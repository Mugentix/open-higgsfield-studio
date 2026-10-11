import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { envForTests, resetStubs, seedTeam, useMemoryStore, useTestDatabase, type MemoryStore, type TestDb } from "./harness";

import * as schema from "@/server/db/schema";
import { requireTeam, type TeamContext } from "@/server/team";
import { beginUpload, finalizeUpload } from "@/server/uploads";

/* Server actions read the session through next/headers; here requireTeam is
   a mock that answers with whichever seeded team the test points it at. */
vi.mock("@/server/team", () => ({ requireTeam: vi.fn() }));

let db: TestDb;
let store: MemoryStore;
let team: TeamContext;

const PNG = new Uint8Array([137, 80, 78, 71]);
/* The hash the browser would claim for PNG: finalizeUpload checks it against
   what landed on a store that can read its objects back. */
const SHA = createHash("sha256").update(PNG).digest("hex");
const MB = 1024 * 1024;

beforeEach(async () => {
  envForTests();
  db = await useTestDatabase();
  store = useMemoryStore({ public: true });
  team = await seedTeam(db);
  vi.mocked(requireTeam).mockReset();
  vi.mocked(requireTeam).mockResolvedValue(team);
});

afterEach(() => resetStubs());

async function readyAsset(owner: TeamContext, sha256: string | null, overrides: Partial<typeof schema.assets.$inferInsert> = {}) {
  const id = randomUUID();
  const key = `t/${owner.teamId}/u/2026/09/${id}.png`;
  await db.insert(schema.assets).values({
    id,
    teamId: owner.teamId,
    userId: owner.userId,
    source: "upload",
    kind: "image",
    name: "held.png",
    mime: "image/png",
    bytes: 4,
    sha256,
    key,
    url: `https://media.test/${key}`,
    status: "ready",
    ...overrides,
  });
  return { id, key, url: `https://media.test/${key}` };
}

describe("beginUpload: refusals", () => {
  it("rejects a mime outside the allow-list and records nothing", async () => {
    const out = await beginUpload({ name: "logo.svg", mime: "image/svg+xml", size: 1024 });
    expect(out).toEqual({ ok: false, error: "Unsupported file type image/svg+xml" });
    expect(await db.select().from(schema.assets)).toHaveLength(0);
  });

  it("rejects a kind that is allowed nowhere, such as a document", async () => {
    expect(await beginUpload({ name: "brief.pdf", mime: "application/pdf", size: 1024 })).toEqual({
      ok: false,
      error: "Unsupported file type application/pdf",
    });
  });

  it.each([
    ["image/png", 30 * MB + 1, "File larger than 30 MB"],
    ["video/mp4", 200 * MB + 1, "File larger than 200 MB"],
    ["audio/mpeg", 50 * MB + 1, "File larger than 50 MB"],
  ])("rejects an oversize %s", async (mime, size, error) => {
    expect(await beginUpload({ name: "big", mime, size })).toEqual({ ok: false, error });
    expect(await db.select().from(schema.assets)).toHaveLength(0);
  });

  it("accepts a file exactly at the cap", async () => {
    const out = await beginUpload({ name: "edge.png", mime: "image/png", size: 30 * MB });
    expect(out.ok).toBe(true);
  });

  it.each([[0], [-1], [1.5], ["4"], [undefined], [Number.NaN]])("rejects size %j as an empty file", async (size) => {
    expect(await beginUpload({ name: "x.png", mime: "image/png", size })).toEqual({ ok: false, error: "Empty file" });
  });

  it("treats a non-object payload as empty rather than throwing", async () => {
    expect(await beginUpload(null)).toEqual({ ok: false, error: "Empty file" });
    expect(await beginUpload("x.png")).toEqual({ ok: false, error: "Empty file" });
  });

  it("folds a failed sign-in into a coded failure", async () => {
    vi.mocked(requireTeam).mockRejectedValue(Object.assign(new Error("Sign in to continue"), { name: "UnauthenticatedError" }));
    expect(await beginUpload({ name: "x.png", mime: "image/png", size: 4 })).toEqual({
      ok: false,
      error: "Sign in to continue",
      code: "unauthenticated",
    });
  });
});

describe("beginUpload: a fresh file", () => {
  it("answers a presigned ticket and records a pending asset row", async () => {
    const out = await beginUpload({ name: "  Mug shot.PNG  ", mime: "IMAGE/PNG", size: 4, sha256: SHA });
    expect(out.ok).toBe(true);
    if (!out.ok || out.data.existing) throw new Error("expected a fresh ticket");
    const { assetId, url, put } = out.data;

    const now = new Date();
    const yyyy = now.getUTCFullYear();
    const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
    const key = `t/${team.teamId}/u/${yyyy}/${mm}/${assetId}.png`;
    expect(url).toBe(`https://media.test/${key}`);
    expect(put).toEqual({ url: `memory://put/${key}?size=4`, headers: { "Content-Type": "image/png" } });

    const rows = await db.select().from(schema.assets);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: assetId,
      teamId: team.teamId,
      userId: team.userId,
      source: "upload",
      kind: "image",
      name: "Mug shot.PNG",
      mime: "image/png",
      bytes: 4,
      sha256: SHA,
      key,
      url,
      status: "pending",
      deletedAt: null,
    });
    /* The object itself is the browser's job; the server has not written it. */
    expect(store.objects.size).toBe(0);
  });

  it("takes the extension from the mime, not the file name, and files a video under kind video", async () => {
    const out = await beginUpload({ name: "clip.mov", mime: "video/mp4", size: 10 });
    if (!out.ok || out.data.existing) throw new Error("expected a fresh ticket");
    expect(out.data.url).toMatch(/\.mp4$/);
    const row = await db.query.assets.findFirst({ where: (a, { eq }) => eq(a.id, out.data.assetId) });
    expect(row).toMatchObject({ kind: "video", mime: "video/mp4", name: "clip.mov" });
  });

  it("defaults the name and clips a long one to 200 characters", async () => {
    const unnamed = await beginUpload({ mime: "image/png", size: 4 });
    if (!unnamed.ok || unnamed.data.existing) throw new Error("expected a fresh ticket");
    const long = await beginUpload({ name: "n".repeat(500), mime: "image/png", size: 4 });
    if (!long.ok || long.data.existing) throw new Error("expected a fresh ticket");
    const rows = await db.select().from(schema.assets);
    expect(rows.find((r) => r.id === unnamed.data.assetId)?.name).toBe("upload");
    expect(rows.find((r) => r.id === long.data.assetId)?.name).toHaveLength(200);
  });

  it("stores a malformed sha256 as null instead of trusting it", async () => {
    const out = await beginUpload({ name: "x.png", mime: "image/png", size: 4, sha256: "A".repeat(64) });
    if (!out.ok || out.data.existing) throw new Error("expected a fresh ticket");
    const row = await db.query.assets.findFirst({ where: (a, { eq }) => eq(a.id, out.data.assetId) });
    expect(row?.sha256).toBeNull();
    const short = await beginUpload({ name: "y.png", mime: "image/png", size: 4, sha256: "abc123" });
    if (!short.ok || short.data.existing) throw new Error("expected a fresh ticket");
    expect((await db.query.assets.findFirst({ where: (a, { eq }) => eq(a.id, short.data.assetId) }))?.sha256).toBeNull();
  });

  it("mints a distinct asset per call even for the same pending file", async () => {
    const first = await beginUpload({ name: "x.png", mime: "image/png", size: 4, sha256: SHA });
    const second = await beginUpload({ name: "x.png", mime: "image/png", size: 4, sha256: SHA });
    if (!first.ok || !second.ok) throw new Error("expected tickets");
    expect(first.data.existing).toBe(false);
    expect(second.data.existing).toBe(false);
    expect(first.data.assetId).not.toBe(second.data.assetId);
    expect(await db.select().from(schema.assets)).toHaveLength(2);
  });
});

describe("beginUpload: reuse by hash", () => {
  it("answers existing:true for a sha256 the team already holds as ready, without a new row", async () => {
    const held = await readyAsset(team, SHA);
    const out = await beginUpload({ name: "again.png", mime: "image/png", size: 4, sha256: SHA });
    expect(out).toEqual({ ok: true, data: { existing: true, assetId: held.id, url: held.url } });
    expect(await db.select().from(schema.assets)).toHaveLength(1);
  });

  it("does not reuse another team's asset with the same hash", async () => {
    const other = await seedTeam(db, { name: "Other Team" });
    const theirs = await readyAsset(other, SHA);
    const out = await beginUpload({ name: "mine.png", mime: "image/png", size: 4, sha256: SHA });
    if (!out.ok) throw new Error(out.error);
    expect(out.data.existing).toBe(false);
    expect(out.data.assetId).not.toBe(theirs.id);
    const rows = await db.select().from(schema.assets);
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.teamId === team.teamId)).toHaveLength(1);
  });

  it("does not reuse a pending or a deleted asset", async () => {
    await readyAsset(team, SHA, { status: "pending" });
    await readyAsset(team, SHA, { deletedAt: new Date() });
    const out = await beginUpload({ name: "x.png", mime: "image/png", size: 4, sha256: SHA });
    if (!out.ok) throw new Error(out.error);
    expect(out.data.existing).toBe(false);
    expect(await db.select().from(schema.assets)).toHaveLength(3);
  });

  it("does not match on a null hash", async () => {
    await readyAsset(team, null);
    const out = await beginUpload({ name: "x.png", mime: "image/png", size: 4 });
    if (!out.ok) throw new Error(out.error);
    expect(out.data.existing).toBe(false);
  });

  it("still refuses a disallowed mime even when the hash is held", async () => {
    await readyAsset(team, SHA);
    expect(await beginUpload({ name: "x.svg", mime: "image/svg+xml", size: 4, sha256: SHA })).toEqual({
      ok: false,
      error: "Unsupported file type image/svg+xml",
    });
  });
});

describe("finalizeUpload", () => {
  async function begin() {
    const out = await beginUpload({ name: "x.png", mime: "image/png", size: 4, sha256: SHA });
    if (!out.ok || out.data.existing) throw new Error("expected a fresh ticket");
    const key = out.data.url.replace("https://media.test/", "");
    return { assetId: out.data.assetId, url: out.data.url, key };
  }

  it("marks the asset ready with the store's byte count once the object is there", async () => {
    const { assetId, url, key } = await begin();
    store.objects.set(key, { bytes: PNG, contentType: "image/png" });
    expect(await finalizeUpload(assetId)).toEqual({ ok: true, data: { assetId, url } });
    const row = await db.query.assets.findFirst({ where: (a, { eq }) => eq(a.id, assetId) });
    expect(row).toMatchObject({ status: "ready", bytes: 4, key, url });
  });

  it("refuses an object that is not what the ticket was for, and removes it", async () => {
    const { assetId, key } = await begin();
    store.objects.set(key, { bytes: PNG.slice(0, 2), contentType: "image/png" });
    expect(await finalizeUpload(assetId)).toEqual({ ok: false, error: "The file did not match the upload; try again" });
    expect((await db.query.assets.findFirst({ where: (a, { eq }) => eq(a.id, assetId) }))?.status).toBe("failed");
    expect(store.objects.has(key)).toBe(false);

    const again = await begin();
    store.objects.set(again.key, { bytes: PNG, contentType: "text/html" });
    expect((await finalizeUpload(again.assetId)).ok).toBe(false);
    expect(store.objects.has(again.key)).toBe(false);
  });

  it("errors and leaves the row pending when the object never arrived", async () => {
    const { assetId } = await begin();
    expect(await finalizeUpload(assetId)).toEqual({ ok: false, error: "The file never arrived; try again" });
    expect((await db.query.assets.findFirst({ where: (a, { eq }) => eq(a.id, assetId) }))?.status).toBe("pending");
  });

  it("is idempotent once ready and no longer consults the store", async () => {
    const { assetId, url, key } = await begin();
    store.objects.set(key, { bytes: PNG, contentType: "image/png" });
    await finalizeUpload(assetId);
    store.objects.delete(key);
    expect(await finalizeUpload(assetId)).toEqual({ ok: true, data: { assetId, url } });
  });

  it("makes the reused asset visible to a later hash lookup", async () => {
    const { assetId, url, key } = await begin();
    store.objects.set(key, { bytes: PNG, contentType: "image/png" });
    await finalizeUpload(assetId);
    expect(await beginUpload({ name: "same.png", mime: "image/png", size: 4, sha256: SHA })).toEqual({
      ok: true,
      data: { existing: true, assetId, url },
    });
  });

  it("does not finalize another team's asset, an unknown id or a non-string", async () => {
    const other = await seedTeam(db, { name: "Other Team" });
    const theirs = await readyAsset(other, null, { status: "pending" });
    store.objects.set(theirs.key, { bytes: PNG, contentType: "image/png" });
    expect(await finalizeUpload(theirs.id)).toEqual({ ok: false, error: "No such upload" });
    expect((await db.query.assets.findFirst({ where: (a, { eq }) => eq(a.id, theirs.id) }))?.status).toBe("pending");
    expect(await finalizeUpload(randomUUID())).toEqual({ ok: false, error: "No such upload" });
    expect(await finalizeUpload({ assetId: theirs.id })).toEqual({ ok: false, error: "No such upload" });
    expect(await finalizeUpload(undefined)).toEqual({ ok: false, error: "No such upload" });
  });
});
