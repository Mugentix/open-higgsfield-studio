"use server";

import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";

import { db, schema } from "./db/client";
import { guarded, type ActionResult } from "./result";
import { extensionFor, mediaStore, uploadKey } from "./storage";
import { requireTeam } from "./team";

/* Files go straight from the browser to the store on a presigned PUT; the
   server only records the row before and confirms the object after. A file
   the team already holds (same bytes, by hash) is reused rather than sent. */

const ALLOWED = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "video/mp4",
  "video/quicktime",
  "audio/wav",
  "audio/x-wav",
  "audio/mpeg",
]);
const MAX_BYTES: Record<string, number> = { image: 30 * 1024 * 1024, video: 200 * 1024 * 1024, audio: 50 * 1024 * 1024 };

export type UploadTicket =
  | { existing: true; assetId: string; url: string }
  | {
      existing: false;
      assetId: string;
      url: string;
      put: { url: string; headers: Record<string, string> };
    };

export async function beginUpload(data: unknown): Promise<ActionResult<UploadTicket>> {
  return guarded(async () => {
    const team = await requireTeam();
    const { name, mime, size, sha256 } = readBegin(data);
    const kind = mime.split("/")[0]!;
    if (!ALLOWED.has(mime)) throw new Error(`Unsupported file type ${mime}`);
    if (size > (MAX_BYTES[kind] ?? 0)) throw new Error(`File larger than ${Math.round((MAX_BYTES[kind] ?? 0) / 1024 / 1024)} MB`);

    if (sha256) {
      const dup = await db.query.assets.findFirst({
        where: and(
          eq(schema.assets.teamId, team.teamId),
          eq(schema.assets.sha256, sha256),
          eq(schema.assets.status, "ready"),
          isNull(schema.assets.deletedAt),
        ),
      });
      if (dup) return { existing: true as const, assetId: dup.id, url: dup.url };
    }

    const store = mediaStore();
    const assetId = randomUUID();
    const key = uploadKey(team.teamId, assetId, extensionFor(mime, name));
    const url = store.publicUrl(key);
    await db.insert(schema.assets).values({
      id: assetId,
      teamId: team.teamId,
      userId: team.userId,
      source: "upload",
      kind,
      name: name.slice(0, 200),
      mime,
      bytes: size,
      sha256: sha256 ?? null,
      key,
      url,
      status: "pending",
    });
    const put = await store.presignPut(key, mime, size);
    return { existing: false as const, assetId, url, put: { url: put.url, headers: put.headers } };
  });
}

export async function finalizeUpload(assetId: unknown): Promise<ActionResult<{ assetId: string; url: string }>> {
  return guarded(async () => {
    const team = await requireTeam();
    if (typeof assetId !== "string") throw new Error("No such upload");
    const asset = await db.query.assets.findFirst({
      where: and(eq(schema.assets.id, assetId), eq(schema.assets.teamId, team.teamId)),
    });
    if (!asset) throw new Error("No such upload");
    if (asset.status === "ready") return { assetId: asset.id, url: asset.url };
    const store = mediaStore();
    const head = await store.head(asset.key);
    if (!head) throw new Error("The file never arrived; try again");
    /* What landed must be what the ticket was for: same size, same type, and
       on a store we can read, the hash the browser claimed. */
    const typeMatches = head.contentType.split(";")[0]?.trim().toLowerCase() === asset.mime;
    const sizeMatches = asset.bytes === null || head.bytes === asset.bytes;
    let hashMatches = true;
    if (asset.sha256 && store.sha256) {
      const actual = await store.sha256(asset.key);
      if (actual) hashMatches = actual === asset.sha256;
    }
    if (!typeMatches || !sizeMatches || !hashMatches) {
      await store.remove(asset.key);
      await db.update(schema.assets).set({ status: "failed" }).where(eq(schema.assets.id, asset.id));
      throw new Error("The file did not match the upload; try again");
    }
    await db
      .update(schema.assets)
      .set({ status: "ready", bytes: head.bytes })
      .where(eq(schema.assets.id, asset.id));
    return { assetId: asset.id, url: asset.url };
  });
}

function readBegin(data: unknown): { name: string; mime: string; size: number; sha256: string | null } {
  const record = typeof data === "object" && data !== null ? (data as Record<string, unknown>) : {};
  const name = typeof record.name === "string" && record.name.trim() ? record.name.trim() : "upload";
  const mime = typeof record.mime === "string" ? record.mime.toLowerCase() : "";
  const size = record.size;
  if (typeof size !== "number" || !Number.isInteger(size) || size <= 0) throw new Error("Empty file");
  const sha256 = typeof record.sha256 === "string" && /^[a-f0-9]{64}$/.test(record.sha256) ? record.sha256 : null;
  return { name, mime, size, sha256 };
}
