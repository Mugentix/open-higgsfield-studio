import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { envForTests, resetStubs, seedTeam, stubKie, useMemoryStore, useTestDatabase, type TestDb } from "./harness";

import * as schema from "@/server/db/schema";
import {
  CHANGES_LIMIT,
  CHANGE_OVERLAP_MS,
  PAGE_SIZE,
  countByVerdict,
  deleteResults,
  favoriteResults,
  listChanges,
  listResults,
  noteResult,
  verdictResults,
  type ChangeCursor,
  type GalleryCursor,
  type GalleryItem,
} from "@/server/gallery";
import { getGalleryFacets, listGallery, setNote, setVerdict } from "@/server/gallery-actions";
import { unwrap } from "@/server/result";
import { ensureDefaultProject } from "@/server/runs";
import { requireTeam, type TeamContext } from "@/server/team";

/* The actions read the session through next/headers; here requireTeam is a
   mock that answers with a seeded team. The core takes the team directly. */
vi.mock("@/server/team", () => ({ requireTeam: vi.fn() }));

vi.setConfig({ testTimeout: 30_000 });

let db: TestDb;

beforeEach(async () => {
  envForTests();
  db = await useTestDatabase();
  useMemoryStore({ public: true });
  stubKie();
  vi.mocked(requireTeam).mockReset();
});

afterEach(() => resetStubs());

const ORIGIN: ChangeCursor = { updatedAt: 0, id: "" };

/** One finished run with `count` tiles, all created at the same instant, as
    settleSuccess writes them. */
async function seedTiles(team: TeamContext, count: number, createdAt: Date): Promise<string[]> {
  const { project } = await ensureDefaultProject(team);
  const runId = randomUUID();
  await db.insert(schema.runs).values({
    id: runId,
    teamId: team.teamId,
    projectId: project.id,
    productId: project.productId,
    userId: team.userId,
    idempotencyKey: runId,
    surface: "image",
    modelId: "nano-banana-pro",
    modelLabel: "Nano Banana Pro",
    kieModel: "nano-banana-pro",
    prompt: "a tile",
    settings: {},
    media: [],
    kieInput: {},
    callbackToken: "t",
    deadlineAt: new Date(Date.now() + 600_000),
    status: "succeeded",
  });
  const ids = Array.from({ length: count }, () => randomUUID());
  await db.insert(schema.results).values(
    ids.map((id, index) => ({
      id,
      runId,
      index,
      teamId: team.teamId,
      projectId: project.id,
      productId: project.productId,
      userId: team.userId,
      kind: "image",
      modelId: "nano-banana-pro",
      modelLabel: "Nano Banana Pro",
      prompt: "a tile",
      ratio: "1 / 1",
      meta: "",
      settings: {},
      status: "completed",
      url: `https://media.test/${id}.png`,
      createdAt,
    })),
  );
  return ids;
}

async function pageAll(team: TeamContext): Promise<GalleryItem[][]> {
  const pages: GalleryItem[][] = [];
  let cursor: GalleryCursor | null = null;
  for (;;) {
    const page = await listResults(team, { view: "assets" }, cursor);
    pages.push(page.items);
    if (!page.nextCursor) return pages;
    cursor = page.nextCursor;
  }
}

async function drainChanges(team: TeamContext, since: ChangeCursor): Promise<{ batches: GalleryItem[][]; until: ChangeCursor }> {
  const batches: GalleryItem[][] = [];
  let cursor = since;
  for (;;) {
    const { items, until } = await listChanges(team, cursor);
    batches.push(items);
    if (items.length < CHANGES_LIMIT) return { batches, until };
    cursor = until;
  }
}

describe("listResults keyset paging", () => {
  it("returns every tile once when a page boundary falls inside a run stamped with microseconds", async () => {
    const team = await seedTeam(db);
    const base = Date.parse("2026-01-01T00:00:00.000Z");
    const expected: string[] = [];
    /* Ten presses of five, one second apart, plus a lone older tile: 51 rows,
       so the 48-row page boundary lands inside a batch of equal created_at. */
    for (let press = 0; press < 10; press++) expected.push(...(await seedTiles(team, 5, new Date(base + press * 1000))));
    expected.push(...(await seedTiles(team, 1, new Date(base - 60_000))));
    /* Postgres' now() carries microseconds; the column must not keep them. */
    await db.execute(sql`UPDATE results SET created_at = created_at + interval '456 microseconds'`);

    const pages = await pageAll(team);

    expect(pages.map((page) => page.length)).toEqual([PAGE_SIZE, 3]);
    const ids = pages.flat().map((item) => item.id);
    expect(new Set(ids).size).toBe(51);
    expect(ids.sort()).toEqual([...expected].sort());
    const stamps = pages.flat().map((item) => item.createdAt);
    expect(stamps.every((stamp) => Number.isInteger(stamp))).toBe(true);
    for (let i = 1; i < stamps.length; i++) expect(stamps[i]!).toBeLessThanOrEqual(stamps[i - 1]!);
  });

  it("hands back the database clock the page was read at", async () => {
    const team = await seedTeam(db);
    const before = Date.now();
    const page = await listResults(team, { view: "assets" }, null);
    expect(page.at).toBeGreaterThanOrEqual(before - 1000);
    expect(page.at).toBeLessThanOrEqual(Date.now() + 1000);
  });
});

describe("listChanges", () => {
  it("delivers every row of a bulk change that shares one updated_at, across pages", async () => {
    const team = await seedTeam(db);
    const ids: string[] = [];
    for (let run = 0; run < 13; run++) ids.push(...(await seedTiles(team, 20, new Date())));
    expect(ids).toHaveLength(260);
    const seeded = await drainChanges(team, ORIGIN);
    expect(seeded.batches.map((b) => b.length)).toEqual([200, 60]);

    /* One statement, 260 rows, one timestamp. */
    expect(await deleteResults(team, ids)).toHaveLength(260);
    const stamps = await db.select({ at: schema.results.updatedAt }).from(schema.results).where(inArray(schema.results.id, ids));
    expect(new Set(stamps.map((s) => s.at.getTime())).size).toBe(1);

    const { batches, until } = await drainChanges(team, seeded.until);
    expect(batches.map((b) => b.length)).toEqual([200, 60]);
    const delivered = batches.flat();
    expect(new Set(delivered.map((item) => item.id)).size).toBe(260);
    expect(delivered.every((item) => item.deletedAt !== null)).toBe(true);
    /* Nothing is left behind the cursor. */
    expect((await listChanges(team, until)).items.map((item) => item.id).sort()).toEqual(
      delivered.filter((item) => item.updatedAt > until.updatedAt || (item.updatedAt === until.updatedAt && item.id > until.id)).map((i) => i.id).sort(),
    );
  });

  it("a row stamped in the future does not drag the cursor past later writes", async () => {
    const team = await seedTeam(db);
    const [x, y] = await seedTiles(team, 2, new Date());
    await db.execute(sql`UPDATE results SET updated_at = now() + interval '3 seconds' WHERE id = ${x}`);
    const since: ChangeCursor = { updatedAt: Date.now() - 60_000, id: "" };

    const first = await listChanges(team, since);
    expect(first.items.map((item) => item.id).sort()).toEqual([x, y].sort());
    expect(first.until.updatedAt).toBeLessThanOrEqual(Date.now() - CHANGE_OVERLAP_MS + 1000);
    expect(first.until.updatedAt).toBeGreaterThan(since.updatedAt);

    await favoriteResults(team, [y!], true);
    const second = await listChanges(team, first.until);
    expect(second.items.find((item) => item.id === y)).toMatchObject({ favorite: true });
  });

  it("never answers a cursor behind the one it was asked from", async () => {
    const team = await seedTeam(db);
    const since: ChangeCursor = { updatedAt: Date.now() + 60_000, id: "zzz" };
    const { items, until } = await listChanges(team, since);
    expect(items).toEqual([]);
    expect(until).toEqual(since);
  });

  it("stamps favorites, deletes and restores with the database clock", async () => {
    const team = await seedTeam(db);
    const [id] = await seedTiles(team, 1, new Date());
    const before = (await db.query.results.findFirst({ where: eq(schema.results.id, id!) }))!.updatedAt.getTime();
    await new Promise((r) => setTimeout(r, 5));
    await favoriteResults(team, [id!], true);
    const after = (await db.query.results.findFirst({ where: eq(schema.results.id, id!) }))!.updatedAt.getTime();
    expect(after).toBeGreaterThan(before);
    expect(Number.isInteger(after)).toBe(true);
  });
});

describe("deleteResults", () => {
  it("answers a tile a teammate already retired as gone, without re-stamping who retired it", async () => {
    const owner = await seedTeam(db, { name: "Owner" });
    const admin: TeamContext = { ...owner, userId: randomUUID(), role: "admin" };
    await db.insert(schema.user).values({ id: admin.userId, name: "Admin", email: `${admin.userId.slice(0, 8)}@example.com`, emailVerified: true });
    await db.insert(schema.member).values({ id: randomUUID(), organizationId: owner.teamId, userId: admin.userId, role: "admin", createdAt: new Date() });
    const [a, b] = await seedTiles(owner, 2, new Date());

    expect(await deleteResults(owner, [a!])).toEqual([a]);
    const first = (await db.query.results.findFirst({ where: eq(schema.results.id, a!) }))!;

    expect((await deleteResults(admin, [a!, b!])).sort()).toEqual([a, b].sort());
    const again = (await db.query.results.findFirst({ where: eq(schema.results.id, a!) }))!;
    expect(again.deletedBy).toBe(owner.userId);
    expect(again.deletedAt!.getTime()).toBe(first.deletedAt!.getTime());
    expect((await db.query.results.findFirst({ where: eq(schema.results.id, b!) }))!.deletedBy).toBe(admin.userId);
  });

  it("still keeps a member off a teammate's tiles", async () => {
    const owner = await seedTeam(db);
    const member: TeamContext = { ...owner, userId: randomUUID(), role: "member" };
    await db.insert(schema.user).values({ id: member.userId, name: "Member", email: `${member.userId.slice(0, 8)}@example.com`, emailVerified: true });
    const [a] = await seedTiles(owner, 1, new Date());
    expect(await deleteResults(member, [a!])).toEqual([]);
    expect((await db.query.results.findFirst({ where: eq(schema.results.id, a!) }))!.deletedAt).toBeNull();
  });
});

describe("verdicts", () => {
  it("sets the call on a set of tiles, remembering who spoke and when, and takes it back with null", async () => {
    const team = await seedTeam(db);
    const [a, b, c] = await seedTiles(team, 3, new Date());

    expect((await verdictResults(team, [a!, b!], "winner")).sort()).toEqual([a, b].sort());
    const judged = (await db.query.results.findFirst({ where: eq(schema.results.id, a!) }))!;
    expect(judged.verdict).toBe("winner");
    expect(judged.verdictBy).toBe(team.userId);
    expect(judged.verdictAt).not.toBeNull();
    expect((await db.query.results.findFirst({ where: eq(schema.results.id, c!) }))!.verdict).toBeNull();

    /* The wall reads the call and the note off the row; both null until made. */
    const { items } = await listResults(team, { view: "assets" }, null);
    expect(items.find((item) => item.id === a)).toMatchObject({ verdict: "winner", note: null });
    expect(items.find((item) => item.id === c)).toMatchObject({ verdict: null, note: null });

    expect(await verdictResults(team, [a!], null)).toEqual([a]);
    const cleared = (await db.query.results.findFirst({ where: eq(schema.results.id, a!) }))!;
    expect(cleared.verdict).toBeNull();
    expect(cleared.verdictBy).toBeNull();
    expect(cleared.verdictAt).toBeNull();
    expect((await db.query.results.findFirst({ where: eq(schema.results.id, b!) }))!.verdict).toBe("winner");
  });

  it("stays inside the team", async () => {
    const team = await seedTeam(db);
    const other = await seedTeam(db, { name: "Other" });
    const [a] = await seedTiles(team, 1, new Date());

    expect(await verdictResults(other, [a!], "killed")).toEqual([]);
    expect(await noteResult(other, a!, "not yours")).toEqual([]);
    const row = (await db.query.results.findFirst({ where: eq(schema.results.id, a!) }))!;
    expect(row.verdict).toBeNull();
    expect(row.note).toBeNull();
    expect(await countByVerdict(other)).toEqual({ winner: 0, testing: 0, killed: 0, none: 0 });
  });

  it("filters the wall by the call, the unjudged under none, and counts each for the facet", async () => {
    const team = await seedTeam(db);
    const [a, b, c, d] = await seedTiles(team, 4, new Date());
    await verdictResults(team, [a!, b!], "winner");
    await verdictResults(team, [c!], "killed");

    const ids = async (verdict: "winner" | "testing" | "killed" | "none") =>
      (await listResults(team, { view: "assets", verdict }, null)).items.map((item) => item.id).sort();
    expect(await ids("winner")).toEqual([a, b].sort());
    expect(await ids("killed")).toEqual([c]);
    expect(await ids("testing")).toEqual([]);
    expect(await ids("none")).toEqual([d]);

    const { project } = await ensureDefaultProject(team);
    expect(await countByVerdict(team, project.id)).toEqual({ winner: 2, testing: 0, killed: 1, none: 1 });
    expect(await countByVerdict(team, randomUUID())).toEqual({ winner: 0, testing: 0, killed: 0, none: 0 });

    /* A retired tile leaves the wall and the count alike. */
    await deleteResults(team, [d!]);
    expect(await ids("none")).toEqual([]);
    expect(await countByVerdict(team)).toEqual({ winner: 2, testing: 0, killed: 1, none: 0 });
  });

  it("reaches an open tab through the change feed, stamped by the database clock", async () => {
    const team = await seedTeam(db);
    const [a] = await seedTiles(team, 1, new Date());
    const before = (await db.query.results.findFirst({ where: eq(schema.results.id, a!) }))!.updatedAt.getTime();
    /* A cursor just past the row as seeded: only a change can bring it back. */
    const since: ChangeCursor = { updatedAt: before, id: a! };
    expect((await listChanges(team, since)).items).toEqual([]);

    await new Promise((r) => setTimeout(r, 5));
    await verdictResults(team, [a!], "testing");
    const first = await listChanges(team, since);
    expect(first.items.map((item) => item.id)).toEqual([a]);
    expect(first.items[0]).toMatchObject({ verdict: "testing", note: null });
    expect(first.items[0]!.updatedAt).toBeGreaterThan(before);
    expect(Number.isInteger(first.items[0]!.updatedAt)).toBe(true);

    await new Promise((r) => setTimeout(r, 5));
    await noteResult(team, a!, "Hook lands in the first second");
    const second = await listChanges(team, { updatedAt: first.items[0]!.updatedAt, id: a! });
    expect(second.items.map((item) => item.id)).toEqual([a]);
    expect(second.items[0]).toMatchObject({ verdict: "testing", note: "Hook lands in the first second" });
  });

  it("keeps a note per tile and clears it with null", async () => {
    const team = await seedTeam(db);
    const [a, b] = await seedTiles(team, 2, new Date());

    expect(await noteResult(team, a!, "Won on CTR, lost on CVR")).toEqual([a]);
    const { items } = await listResults(team, { view: "assets" }, null);
    expect(items.find((item) => item.id === a)?.note).toBe("Won on CTR, lost on CVR");
    expect(items.find((item) => item.id === b)?.note).toBeNull();

    expect(await noteResult(team, a!, null)).toEqual([a]);
    expect((await db.query.results.findFirst({ where: eq(schema.results.id, a!) }))!.note).toBeNull();
    expect(await noteResult(team, randomUUID(), "nobody's")).toEqual([]);
  });

  it("through the actions: refuses a word that is not a call, caps and trims the note, counts for the facet", async () => {
    const team = await seedTeam(db);
    vi.mocked(requireTeam).mockResolvedValue(team);
    const [a, b] = await seedTiles(team, 2, new Date());
    const { project } = await ensureDefaultProject(team);

    expect(await setVerdict({ ids: [a], verdict: "maybe" })).toEqual({ ok: false, error: "Pick winner, testing or killed" });
    expect(await setVerdict({ ids: [], verdict: "winner" })).toEqual({ ok: false, error: "No tiles named" });
    expect(await setVerdict({ ids: [a], verdict: "winner" })).toEqual({ ok: true, data: [a] });

    expect(await setNote({ id: a, note: "x".repeat(501) })).toEqual({ ok: false, error: "A note runs to 500 characters" });
    expect(await setNote({ note: "no tile" })).toEqual({ ok: false, error: "No tile named" });
    expect(await setNote({ id: a, note: "  Hook lands  " })).toEqual({ ok: true, data: [a] });
    expect((await db.query.results.findFirst({ where: eq(schema.results.id, a!) }))!.note).toBe("Hook lands");
    expect(await setNote({ id: a, note: "   " })).toEqual({ ok: true, data: [a] });
    expect((await db.query.results.findFirst({ where: eq(schema.results.id, a!) }))!.note).toBeNull();

    expect(unwrap(await getGalleryFacets({ projectId: project.id })).verdicts).toEqual({ winner: 1, testing: 0, killed: 0, none: 1 });
    expect(unwrap(await listGallery({ filter: { view: "assets", verdict: "none" } })).items.map((item) => item.id)).toEqual([b]);
    /* A word the facet does not know is no filter at all. */
    expect(unwrap(await listGallery({ filter: { view: "assets", verdict: "best" } })).items).toHaveLength(2);
  });
});
