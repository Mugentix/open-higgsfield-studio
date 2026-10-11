"use server";

import { NOTE_LIMIT, isVerdict, isVerdictFilter, type Verdict, type VerdictFilter } from "@/openhiggsfield/data";

import {
  countByModel,
  countByVerdict,
  deleteResults,
  favoriteResults,
  listAuthors,
  listChanges,
  listResults,
  noteResult,
  restoreResults,
  verdictResults,
  type ChangeCursor,
  type GalleryCursor,
  type GalleryFilter,
  type GalleryItem,
} from "./gallery";
import { guarded, type ActionResult } from "./result";
import { requireTeam } from "./team";

const VIEWS = new Set(["image", "video", "assets", "favorites"]);

export async function listGallery(
  data: unknown,
): Promise<ActionResult<{ items: GalleryItem[]; nextCursor: GalleryCursor | null; at: number }>> {
  return guarded(async () => {
    const team = await requireTeam();
    const record = asObject(data);
    return listResults(team, readFilter(record.filter), readCursor(record.cursor));
  });
}

export async function syncGallery(data: unknown): Promise<ActionResult<{ items: GalleryItem[]; until: ChangeCursor }>> {
  return guarded(async () => {
    const team = await requireTeam();
    const record = asObject(data);
    return listChanges(team, readSince(record.since), typeof record.projectId === "string" ? record.projectId : undefined);
  });
}

export async function setFavorite(data: unknown): Promise<ActionResult<string[]>> {
  return guarded(async () => {
    const team = await requireTeam();
    const record = asObject(data);
    return favoriteResults(team, readIds(record.ids), record.keep === true);
  });
}

/** The team's call on the named tiles; `verdict: null` takes it back. */
export async function setVerdict(data: unknown): Promise<ActionResult<string[]>> {
  return guarded(async () => {
    const team = await requireTeam();
    const record = asObject(data);
    return verdictResults(team, readIds(record.ids), readVerdict(record.verdict));
  });
}

/** The words behind the call on one tile; empty or null clears them. */
export async function setNote(data: unknown): Promise<ActionResult<string[]>> {
  return guarded(async () => {
    const team = await requireTeam();
    const record = asObject(data);
    return noteResult(team, readId(record.id), readNote(record.note));
  });
}

export async function removeResults(data: unknown): Promise<ActionResult<string[]>> {
  return guarded(async () => {
    const team = await requireTeam();
    return deleteResults(team, readIds(asObject(data).ids));
  });
}

export async function restoreRemoved(data: unknown): Promise<ActionResult<string[]>> {
  return guarded(async () => {
    const team = await requireTeam();
    return restoreResults(team, readIds(asObject(data).ids));
  });
}

export async function getGalleryFacets(data: unknown): Promise<
  ActionResult<{
    authors: Array<{ id: string; name: string }>;
    models: Array<{ modelId: string; count: number }>;
    verdicts: Record<VerdictFilter, number>;
  }>
> {
  return guarded(async () => {
    const team = await requireTeam();
    const record = asObject(data);
    const projectId = typeof record.projectId === "string" ? record.projectId : undefined;
    const [authors, models, verdicts] = await Promise.all([
      listAuthors(team),
      countByModel(team, projectId),
      countByVerdict(team, projectId),
    ]);
    return { authors, models, verdicts };
  });
}

function readFilter(value: unknown): GalleryFilter {
  const record = asObject(value);
  const view = typeof record.view === "string" && VIEWS.has(record.view) ? (record.view as GalleryFilter["view"]) : "assets";
  const strings = (key: string) =>
    Array.isArray(record[key]) ? (record[key] as unknown[]).filter((v): v is string => typeof v === "string").slice(0, 50) : undefined;
  const number = (key: string) => (typeof record[key] === "number" && Number.isFinite(record[key]) ? (record[key] as number) : undefined);
  return {
    view,
    ...(typeof record.projectId === "string" ? { projectId: record.projectId } : {}),
    ...(typeof record.productId === "string" ? { productId: record.productId } : {}),
    ...(strings("modelIds")?.length ? { modelIds: strings("modelIds") } : {}),
    ...(strings("userIds")?.length ? { userIds: strings("userIds") } : {}),
    ...(typeof record.q === "string" && record.q.trim() ? { q: record.q.trim().slice(0, 200) } : {}),
    ...(number("from") ? { from: number("from") } : {}),
    ...(number("to") ? { to: number("to") } : {}),
    ...(isVerdictFilter(record.verdict) ? { verdict: record.verdict } : {}),
  };
}

function readVerdict(value: unknown): Verdict | null {
  if (value === null || value === undefined) return null;
  if (!isVerdict(value)) throw new Error("Pick winner, testing or killed");
  return value;
}

/** Trimmed and capped; what is left empty is no note at all. */
function readNote(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new Error("A note is words");
  const note = value.trim();
  if (note.length > NOTE_LIMIT) throw new Error(`A note runs to ${NOTE_LIMIT} characters`);
  return note || null;
}

function readCursor(value: unknown): GalleryCursor | null {
  if (value === null || value === undefined) return null;
  const record = asObject(value);
  if (typeof record.createdAt !== "number" || typeof record.id !== "string") throw new Error("Invalid cursor");
  return { createdAt: record.createdAt, id: record.id };
}

function readSince(value: unknown): ChangeCursor {
  const record = asObject(value);
  const updatedAt = record.updatedAt;
  if (typeof updatedAt !== "number" || !Number.isFinite(updatedAt) || updatedAt < 0) throw new Error("Invalid sync point");
  const id = typeof record.id === "string" && record.id.length < 100 ? record.id : "";
  return { updatedAt, id };
}

function readId(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length >= 100) throw new Error("No tile named");
  return value;
}

function readIds(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error("No tiles named");
  const ids = value.filter((v): v is string => typeof v === "string" && v.length > 0 && v.length < 100);
  if (ids.length === 0 || ids.length > 500) throw new Error("No tiles named");
  return ids;
}

function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
