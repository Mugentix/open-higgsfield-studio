import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { isSafeKey, mimeForKey } from "./keys";
import type { MediaStore, PresignedPut } from "./index";

/* A checkout without R2: objects under .data/media, served by
   /media/[...key], uploaded through a signed PUT to /api/media/put. Not
   public — KIE cannot fetch these, so inputs are re-uploaded to KIE's own
   scratch service at submit time. */

export const LOCAL_MEDIA_DIR = path.join(process.cwd(), ".data", "media");
const PRESIGN_SECONDS = 15 * 60;

function appOrigin(): string {
  return (process.env.BETTER_AUTH_URL?.trim() || process.env.APP_URL?.trim() || "http://localhost:3000").replace(/\/$/, "");
}

function signingKey(): string {
  const raw = process.env.APP_SECRET_KEY?.trim();
  if (raw) return raw;
  if (process.env.NODE_ENV === "production") throw new Error("APP_SECRET_KEY is not set");
  return "openhiggsfield-dev-only-not-a-secret";
}

export function signPut(key: string, contentType: string, contentLength: number, expiresAt: number): string {
  return createHmac("sha256", signingKey()).update(`${key}\n${contentType}\n${contentLength}\n${expiresAt}`).digest("hex");
}

export function verifyPut(
  key: string,
  contentType: string,
  contentLength: number,
  expiresAt: number,
  signature: string,
): boolean {
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) return false;
  const expected = Buffer.from(signPut(key, contentType, contentLength, expiresAt));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export function localPath(key: string): string {
  if (!isSafeKey(key)) throw new Error("Unsafe media key");
  return path.join(LOCAL_MEDIA_DIR, key);
}

export class LocalStore implements MediaStore {
  readonly kind = "local" as const;
  readonly public = false;

  async put(key: string, body: ReadableStream<Uint8Array> | Uint8Array, _contentType: string, maxBytes?: number) {
    const file = localPath(key);
    await mkdir(path.dirname(file), { recursive: true });
    if (body instanceof Uint8Array) {
      if (maxBytes !== undefined && body.byteLength > maxBytes) throw new Error("Body larger than the signed size");
      await writeFile(file, body);
      return { bytes: body.byteLength };
    }
    let bytes = 0;
    /* The cap is enforced as the bytes arrive, never after a disk's worth. */
    const counted = body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          bytes += chunk.byteLength;
          if (maxBytes !== undefined && bytes > maxBytes) {
            controller.error(new Error("Body larger than the signed size"));
            return;
          }
          controller.enqueue(chunk);
        },
      }),
    );
    try {
      await pipeline(
        Readable.fromWeb(counted as import("node:stream/web").ReadableStream<Uint8Array>),
        createWriteStream(file),
      );
    } catch (caught) {
      await unlink(file).catch(() => undefined);
      throw caught;
    }
    return { bytes };
  }

  async presignPut(key: string, contentType: string, contentLength: number): Promise<PresignedPut> {
    const expiresAt = Date.now() + PRESIGN_SECONDS * 1000;
    const sig = signPut(key, contentType, contentLength, expiresAt);
    const params = new URLSearchParams({ key, type: contentType, size: String(contentLength), exp: String(expiresAt), sig });
    return { url: `${appOrigin()}/api/media/put?${params}`, headers: { "Content-Type": contentType }, expiresAt };
  }

  async head(key: string) {
    try {
      const info = await stat(localPath(key));
      return { bytes: info.size, contentType: mimeForKey(key) };
    } catch {
      return null;
    }
  }

  async remove(key: string) {
    await unlink(localPath(key)).catch(() => undefined);
  }

  async sha256(key: string): Promise<string | null> {
    return new Promise((resolve) => {
      const hash = createHash("sha256");
      createReadStream(localPath(key))
        .on("data", (chunk) => hash.update(chunk))
        .on("error", () => resolve(null))
        .on("end", () => resolve(hash.digest("hex")));
    });
  }

  publicUrl(key: string): string {
    return `${appOrigin()}/media/${key}`;
  }
}
