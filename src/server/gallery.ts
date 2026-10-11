import { and, asc, desc, eq, gt, ilike, inArray, isNull, lt, or, sql, type SQL } from "drizzle-orm";

import { VERDICT_FILTERS, isVerdict, type Verdict, type VerdictFilter } from "@/openhiggsfield/data";

import { db, schema } from "./db/client";
import { rows as rawRows } from "./db/sql";
import type { TeamContext } from "./team";
import { resultUrl } from "./storage";
import { CHANGE_OVERLAP_MS, compareChangeCursor, type ChangeCursor } from "./gallery-cursor";

/* The gallery is one table read with the filters a marketer reaches for:
   scope, project, product, model, member, favorites, verdict, words. Keyset
   paging on (created_at, id) so a wall of forty thousand tiles scrolls like
   forty. */

export type GalleryView = "image" | "video" | "assets" | "favorites";

export type GalleryFilter = {
  view: GalleryView;
  status?: "running" | "completed" | "failed";
  projectId?: string;
  productId?: string;
  modelIds?: string[];
  userIds?: string[];
  q?: string;
  from?: number;
  to?: number;
  /** One of the three calls, or "none" for the tiles nobody has judged. */
  verdict?: VerdictFilter;
};

export type GalleryCursor = { createdAt: number; id: string };

export { CHANGE_OVERLAP_MS, compareChangeCursor, type ChangeCursor } from "./gallery-cursor";

/** One tile. A superset of the studio's RunRecord so the grid, viewer and
    selection bar read it unchanged; `art` is drawn client-side from the id. */
export type GalleryItem = {
  id: string;
  requestId: string;
  surface: "image" | "video";
  kind: "image" | "video";
  modelId: string;
  modelLabel: string;
  prompt: string;
  ratio: string;
  meta: string;
  badge?: string;
  urls: string[];
  status: "running" | "completed" | "failed";
  error?: string;
  createdAt: number;
  updatedAt: number;
  favorite: boolean;
  /** The team's call and the words behind it; null until someone makes it. */
  verdict: Verdict | null;
  note: string | null;
  settings: Record<string, unknown>;
  userId: string | null;
  userName: string;
  projectId: string;
  productId: string;
  mirrored: boolean;
  deletedAt: number | null;
};

export const PAGE_SIZE = 48;
export const CHANGES_LIMIT = 200;
/* Rows are stamped by the database clock: one clock for every instance. */
const DB_NOW = sql`now()`;

type Row = typeof schema.results.$inferSelect & { author: { name: string; email: string } | null };

export function itemOf(row: Row): GalleryItem {
  const url = resultUrl(row);
  return {
    id: row.id,
    requestId: row.runId,
    surface: row.kind as "image" | "video",
    kind: row.kind as "image" | "video",
    modelId: row.modelId,
    modelLabel: row.modelLabel,
    prompt: row.prompt,
    ratio: row.ratio,
    meta: row.meta,
    ...(row.badge ? { badge: row.badge } : {}),
    urls: row.status === "completed" && url ? [url] : [],
    status: row.status as GalleryItem["status"],
    ...(row.error ? { error: row.error } : {}),
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
    favorite: row.favorite,
    verdict: isVerdict(row.verdict) ? row.verdict : null,
    note: row.note,
    settings: row.settings,
    userId: row.userId,
    userName: row.author?.name || row.author?.email || "",
    projectId: row.projectId,
    productId: row.productId,
    mirrored: row.mirrorStatus === "done",
    deletedAt: row.deletedAt?.getTime() ?? null,
  };
}

function whereFor(team: TeamContext, filter: GalleryFilter): SQL[] {
  const clauses: SQL[] = [eq(schema.results.teamId, team.teamId), isNull(schema.results.deletedAt)];
  if (filter.status) clauses.push(eq(schema.results.status, filter.status));
  if (filter.view === "image" || filter.view === "video") clauses.push(eq(schema.results.kind, filter.view));
  if (filter.view === "favorites") clauses.push(eq(schema.results.favorite, true));
  if (filter.projectId) clauses.push(eq(schema.results.projectId, filter.projectId));
  if (filter.productId) clauses.push(eq(schema.results.productId, filter.productId));
  if (filter.modelIds?.length) clauses.push(inArray(schema.results.modelId, filter.modelIds));
  if (filter.userIds?.length) clauses.push(inArray(schema.results.userId, filter.userIds));
  if (filter.q) clauses.push(ilike(schema.results.prompt, `%${escapeLike(filter.q)}%`));
  if (filter.verdict === "none") clauses.push(isNull(schema.results.verdict));
  else if (filter.verdict) clauses.push(eq(schema.results.verdict, filter.verdict));
  if (filter.from) clauses.push(gt(schema.results.createdAt, new Date(filter.from)));
  if (filter.to) clauses.push(lt(schema.results.createdAt, new Date(filter.to)));
  return clauses;
}

/** The database's clock in ms, for cursors a client will hand back; never
    compared against a browser's idea of the time. */
export async function dbNow(): Promise<number> {
  const [row] = await rawRows<{ ms: string | number }>(sql`SELECT (EXTRACT(EPOCH FROM now()) * 1000)::bigint AS ms`);
  return Number(row?.ms ?? Date.now());
}

export async function listResults(
  team: TeamContext,
  filter: GalleryFilter,
  cursor: GalleryCursor | null,
): Promise<{ items: GalleryItem[]; nextCursor: GalleryCursor | null; at: number }> {
  /* Read before the rows, so a change feed seeded from `at` re-delivers
     anything written while this page was being read. */
  const at = await dbNow();
  const clauses = whereFor(team, filter);
  if (cursor) {
    const at = new Date(cursor.createdAt);
    clauses.push(
      or(
        lt(schema.results.createdAt, at),
        and(eq(schema.results.createdAt, at), lt(schema.results.id, cursor.id)),
      )!,
    );
  }
  const rows = await db.query.results.findMany({
    where: and(...clauses),
    with: { author: { columns: { name: true, email: true } } },
    orderBy: [desc(schema.results.createdAt), desc(schema.results.id)],
    limit: PAGE_SIZE + 1,
  });
  const page = rows.slice(0, PAGE_SIZE);
  const last = page[page.length - 1];
  return {
    items: page.map(itemOf),
    nextCursor: rows.length > PAGE_SIZE && last ? { createdAt: last.createdAt.getTime(), id: last.id } : null,
    at,
  };
}

/** Every tile that changed since a cursor, deletions included, so an open
    tab keeps up with teammates and with the mirror jobs. A full page answers
    with its last row as the cursor; a short one answers with the database
    clock less an overlap, so re-delivery is possible and a miss is not. */
export async function listChanges(
  team: TeamContext,
  since: ChangeCursor,
  projectId?: string,
): Promise<{ items: GalleryItem[]; until: ChangeCursor }> {
  const now = await dbNow();
  const at = new Date(since.updatedAt);
  const clauses: SQL[] = [
    eq(schema.results.teamId, team.teamId),
    or(gt(schema.results.updatedAt, at), and(eq(schema.results.updatedAt, at), gt(schema.results.id, since.id)))!,
  ];
  if (projectId) clauses.push(eq(schema.results.projectId, projectId));
  const rows = await db.query.results.findMany({
    where: and(...clauses),
    with: { author: { columns: { name: true, email: true } } },
    orderBy: [asc(schema.results.updatedAt), asc(schema.results.id)],
    limit: CHANGES_LIMIT,
  });
  const last = rows[rows.length - 1];
  let until: ChangeCursor;
  if (rows.length === CHANGES_LIMIT && last) {
    until = { updatedAt: last.updatedAt.getTime(), id: last.id };
  } else {
    const floor: ChangeCursor = { updatedAt: now - CHANGE_OVERLAP_MS, id: "" };
    until = compareChangeCursor(floor, since) > 0 ? floor : since;
  }
  return { items: rows.map(itemOf), until };
}

export async function favoriteResults(team: TeamContext, ids: string[], keep: boolean): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .update(schema.results)
    .set({ favorite: keep, favoritedBy: keep ? team.userId : null, updatedAt: DB_NOW })
    .where(and(eq(schema.results.teamId, team.teamId), inArray(schema.results.id, ids)))
    .returning();
  return rows.map((row) => row.id);
}

/** The team's call on a set of tiles, or the call taken back with null. Any
    member judges any tile — a verdict is the team's, like a favorite — and the
    row remembers who spoke last and when. Stamped by the database clock so the
    change feed carries it to every open tab. */
export async function verdictResults(team: TeamContext, ids: string[], verdict: Verdict | null): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .update(schema.results)
    .set({ verdict, verdictBy: verdict ? team.userId : null, verdictAt: verdict ? DB_NOW : null, updatedAt: DB_NOW })
    .where(and(eq(schema.results.teamId, team.teamId), inArray(schema.results.id, ids)))
    .returning();
  return rows.map((row) => row.id);
}

/** The words behind a call — why it won, what to try next — on one tile;
    null clears them. The action has already trimmed and capped the text. */
export async function noteResult(team: TeamContext, id: string, note: string | null): Promise<string[]> {
  const rows = await db
    .update(schema.results)
    .set({ note, updatedAt: DB_NOW })
    .where(and(eq(schema.results.teamId, team.teamId), eq(schema.results.id, id)))
    .returning();
  return rows.map((row) => row.id);
}

/** Members retire their own runs; owners and admins retire anyone's. The row
    stays for thirty days behind deleted_at, so undo is a flag flip. Answers
    every named tile that is gone afterwards, including one a teammate had
    already retired, so the caller never brings a deleted tile back. */
export async function deleteResults(team: TeamContext, ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const own = team.role === "member" ? [eq(schema.results.userId, team.userId)] : [];
  const rows = await db
    .update(schema.results)
    .set({
      deletedAt: sql`COALESCE(${schema.results.deletedAt}, now())`,
      deletedBy: sql`COALESCE(${schema.results.deletedBy}, ${team.userId})`,
      updatedAt: DB_NOW,
    })
    .where(and(eq(schema.results.teamId, team.teamId), inArray(schema.results.id, ids), ...own))
    .returning();
  return rows.map((row) => row.id);
}

export async function restoreResults(team: TeamContext, ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const own = team.role === "member" ? [eq(schema.results.deletedBy, team.userId)] : [];
  const rows = await db
    .update(schema.results)
    .set({ deletedAt: null, deletedBy: null, updatedAt: DB_NOW })
    .where(and(eq(schema.results.teamId, team.teamId), inArray(schema.results.id, ids), ...own))
    .returning();
  return rows.map((row) => row.id);
}

/** Members the team's tiles were made by, for the filter row. */
export async function listAuthors(team: TeamContext): Promise<Array<{ id: string; name: string }>> {
  const rows = await db
    .select({ id: schema.user.id, name: schema.user.name, email: schema.user.email })
    .from(schema.member)
    .innerJoin(schema.user, eq(schema.member.userId, schema.user.id))
    .where(eq(schema.member.organizationId, team.teamId))
    .orderBy(asc(schema.user.name));
  return rows.map((row) => ({ id: row.id, name: row.name || row.email }));
}

/** Tiles per model in the current scope, for the model filter's counts. */
export async function countByModel(team: TeamContext, projectId?: string): Promise<Array<{ modelId: string; count: number }>> {
  const clauses: SQL[] = [eq(schema.results.teamId, team.teamId), isNull(schema.results.deletedAt)];
  if (projectId) clauses.push(eq(schema.results.projectId, projectId));
  const rows = await db
    .select({ modelId: schema.results.modelId, count: sql<number>`count(*)::int` })
    .from(schema.results)
    .where(and(...clauses))
    .groupBy(schema.results.modelId);
  return rows.map((row) => ({ modelId: row.modelId, count: Number(row.count) }));
}

/** Tiles per call in the current scope, the unjudged under "none", for the
    filter bar's facet. Every key is present, so a zero is a zero and never a
    miss. */
export async function countByVerdict(team: TeamContext, projectId?: string): Promise<Record<VerdictFilter, number>> {
  const clauses: SQL[] = [eq(schema.results.teamId, team.teamId), isNull(schema.results.deletedAt)];
  if (projectId) clauses.push(eq(schema.results.projectId, projectId));
  const rows = await db
    .select({ verdict: schema.results.verdict, count: sql<number>`count(*)::int` })
    .from(schema.results)
    .where(and(...clauses))
    .groupBy(schema.results.verdict);
  const counts = Object.fromEntries(VERDICT_FILTERS.map((key) => [key, 0])) as Record<VerdictFilter, number>;
  for (const row of rows) counts[isVerdict(row.verdict) ? row.verdict : "none"] += Number(row.count);
  return counts;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}
