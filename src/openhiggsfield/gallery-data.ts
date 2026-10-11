"use client";

import {
  QueryClient,
  useInfiniteQuery,
  useQueryClient,
  type InfiniteData,
} from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef } from "react";

import type { GalleryCursor, GalleryFilter, GalleryItem } from "@/server/gallery";
import { CHANGE_OVERLAP_MS, compareChangeCursor, type ChangeCursor } from "@/server/gallery-cursor";
import { removeResults, restoreRemoved, setFavorite, setNote, setVerdict } from "@/server/gallery-actions";
import { unwrap } from "@/server/result";
import { readStudio } from "./studio-read";

import { artFor } from "./artwork";
import type { Verdict } from "./data";
import type { RunRecord } from "./history";

/* The team's wall, read a page at a time and kept fresh by a change feed
   that rides the same cadence as the run poll. Every tile the studio draws
   comes from here; the browser keeps nothing of its own any more. */

export const SYNC_INTERVAL_MS = 4000;

export function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { staleTime: 30_000, gcTime: 10 * 60_000, refetchOnWindowFocus: false, retry: 1 },
    },
  });
}

/** One server page; `at` is the database clock when it was read. */
export type Page = { items: GalleryItem[]; nextCursor: GalleryCursor | null; at?: number };
export type Pages = InfiniteData<Page, GalleryCursor | null>;

/** A tile as the grid draws it: the server's item plus the art the id seeds. */
export type Tile = RunRecord & GalleryItem;

function hueOf(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 360;
  return h;
}

export function tileOf(item: GalleryItem): Tile {
  return { ...item, art: artFor(item.surface, hueOf(item.id), item.id) };
}

export function galleryKey(filter: GalleryFilter) {
  return ["gallery", filter] as const;
}

/** Applies a set of changed items to every cached page of a filter: updates
    in place, drops what was deleted or no longer matches, and slots what is
    new into the page its (createdAt, id) belongs on. Pure, so the same rule
    serves the change feed, the optimistic mutations and the runs this tab
    starts.

    The feed delivers by updated_at, not created_at, so a changed tile may
    belong on a page that is not loaded yet; such a tile is dropped here and
    arrives with its page. Only when every page is loaded does an unseen tile
    always find a home. */
export function applyChanges(pages: Pages | undefined, changes: GalleryItem[], filter: GalleryFilter): Pages | undefined {
  if (!pages || pages.pages.length === 0) return pages;
  const byId = new Map(changes.map((item) => [item.id, item]));
  const seen = new Set<string>();
  const next = pages.pages.map((page) => ({
    ...page,
    items: page.items.flatMap((item) => {
      if (seen.has(item.id)) return [];
      seen.add(item.id);
      const change = byId.get(item.id);
      if (!change) return [item];
      return matches(change, filter) ? [change] : [];
    }),
  }));
  const boundary = next[next.length - 1]!.nextCursor;
  const fresh = changes.filter((item) => !seen.has(item.id) && matches(item, filter) && (!boundary || isNewerThan(item, boundary)));
  for (const item of fresh) {
    /* The first page whose oldest tile the item is newer than; failing that
       (everything is loaded and the item is the oldest of all), the last. */
    let index = next.findIndex((page) => {
      const oldest = page.items[page.items.length - 1];
      return !oldest || newestFirst(item, oldest) < 0;
    });
    if (index === -1) index = next.length - 1;
    const page = next[index]!;
    next[index] = { ...page, items: [...page.items, item].sort(newestFirst) };
  }
  return { ...pages, pages: next };
}

/** The wall's order: newest first, ties broken by id descending, as the server lists. */
function newestFirst(a: GalleryItem, b: GalleryItem): number {
  return b.createdAt - a.createdAt || (b.id < a.id ? -1 : b.id > a.id ? 1 : 0);
}

/** Whether an item sorts before the tile a page cursor names, i.e. inside the loaded window. */
function isNewerThan(item: GalleryItem, cursor: GalleryCursor): boolean {
  return item.createdAt > cursor.createdAt || (item.createdAt === cursor.createdAt && item.id > cursor.id);
}

function matches(item: GalleryItem, filter: GalleryFilter): boolean {
  if (item.deletedAt) return false;
  if (filter.status && item.status !== filter.status) return false;
  if ((filter.view === "image" || filter.view === "video") && item.kind !== filter.view) return false;
  if (filter.view === "favorites" && !item.favorite) return false;
  if (filter.projectId && item.projectId !== filter.projectId) return false;
  if (filter.productId && item.productId !== filter.productId) return false;
  if (filter.modelIds?.length && !filter.modelIds.includes(item.modelId)) return false;
  if (filter.userIds?.length && (!item.userId || !filter.userIds.includes(item.userId))) return false;
  if (filter.q && !item.prompt.toLowerCase().includes(filter.q.toLowerCase())) return false;
  if (filter.verdict && (filter.verdict === "none" ? item.verdict !== null : item.verdict !== filter.verdict)) return false;
  return true;
}

export function useGallery(filter: GalleryFilter, options: { enabled?: boolean; sync?: boolean } = {}) {
  const client = useQueryClient();
  const key = galleryKey(filter);

  /* The change feed's origin: a database clock reading, never the browser's.
     It is only ever pulled back — to the moment a page was read, less an
     overlap — so anything written while a page was in flight is delivered
     on the next tick rather than lost between the snapshot and the feed. */
  const since = useRef<ChangeCursor | null>(null);
  const origin = useCallback((at: number) => {
    const from: ChangeCursor = { updatedAt: at - CHANGE_OVERLAP_MS, id: "" };
    if (!since.current || compareChangeCursor(from, since.current) < 0) since.current = from;
  }, []);

  const query = useInfiniteQuery({
    enabled: options.enabled,
    refetchOnMount: options.sync === false ? "always" : true,
    queryKey: key,
    queryFn: async ({ pageParam, signal }) => {
      const page = unwrap(await readStudio("gallery", { filter, cursor: pageParam }, signal));
      origin(page.at);
      return page as Page;
    },
    initialPageParam: null as GalleryCursor | null,
    getNextPageParam: (last) => last.nextCursor,
  });

  /* Pages served from the cache never ran queryFn; the feed still needs a start. */
  useEffect(() => {
    if (since.current) return;
    const at = query.data?.pages[0]?.at;
    if (at !== undefined) origin(at);
  }, [query.data, origin]);

  const items = useMemo(() => {
    const tiles: Tile[] = [];
    const seen = new Set<string>();
    for (const page of query.data?.pages ?? []) {
      for (const item of page.items) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        tiles.push(tileOf(item));
      }
    }
    return tiles;
  }, [query.data]);

  /** Every filter's cache is patched, not just this one: a favorite flipped
      in the image scope must already be right when Favorites opens. */
  const patch = useCallback(
    (changes: GalleryItem[]) => {
      for (const entry of client.getQueryCache().findAll({ queryKey: ["gallery"] })) {
        const entryFilter = entry.queryKey[1] as GalleryFilter;
        client.setQueryData<Pages>(entry.queryKey, (pages) => applyChanges(pages, changes, entryFilter));
      }
    },
    [client],
  );

  /* The change feed: team-wide, because every project's cache is patched
     from it; every few seconds while the tab is visible. */
  useEffect(() => {
    if (options.sync === false || options.enabled === false) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      if (!live) return;
      const sent = since.current;
      if (document.visibilityState === "visible" && sent) {
        try {
          const result = await readStudio("changes", { since: sent });
          if (result.ok && live) {
            if (result.data.items.length) patch(result.data.items);
            /* A page read meanwhile may have pulled the origin back; never skip past it. */
            const current = since.current ?? sent;
            since.current = compareChangeCursor(result.data.until, current) < 0 || current === sent ? result.data.until : current;
          }
        } catch {
          /* the next tick tries again */
        }
      }
      if (live) timer = setTimeout(() => void tick(), SYNC_INTERVAL_MS);
    };
    timer = setTimeout(() => void tick(), SYNC_INTERVAL_MS);
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [patch, options.sync, options.enabled]);

  const favorite = useCallback(
    async (targets: Tile[], keep: boolean) => {
      patch(targets.map((tile) => ({ ...tile, favorite: keep })));
      const result = await setFavorite({ ids: targets.map((tile) => tile.id), keep });
      if (!result.ok) patch(targets);
    },
    [patch],
  );

  /** The team's call, on the wall before the server answers, the way a keep
      is: a Winners scope open in the next tab is right by the time it is
      looked at. */
  const judge = useCallback(
    async (targets: Tile[], verdict: Verdict | null) => {
      patch(targets.map((tile) => ({ ...tile, verdict })));
      const result = await setVerdict({ ids: targets.map((tile) => tile.id), verdict });
      if (!result.ok) patch(targets);
    },
    [patch],
  );

  /** The words behind the call. A refusal is thrown rather than swallowed:
      the visitor typed them, and a field that quietly emptied would read as
      a save. */
  const note = useCallback(
    async (target: Tile, text: string | null) => {
      patch([{ ...target, note: text }]);
      const result = await setNote({ id: target.id, note: text });
      if (!result.ok) {
        patch([target]);
        throw new Error(result.error);
      }
    },
    [patch],
  );

  const remove = useCallback(
    async (targets: Tile[]) => {
      patch(targets.map((tile) => ({ ...tile, deletedAt: Date.now() })));
      const result = await removeResults({ ids: targets.map((tile) => tile.id) });
      if (!result.ok) {
        patch(targets);
        throw new Error(result.error);
      }
      /* Tiles the server kept (another member's, for a member) come back. */
      const gone = new Set(result.data);
      patch(targets.filter((tile) => !gone.has(tile.id)));
      return targets.filter((tile) => gone.has(tile.id));
    },
    [patch],
  );

  const restore = useCallback(
    async (targets: Tile[]) => {
      patch(targets.map((tile) => ({ ...tile, deletedAt: null })));
      const result = await restoreRemoved({ ids: targets.map((tile) => tile.id) });
      if (!result.ok) patch(targets.map((tile) => ({ ...tile, deletedAt: Date.now() })));
    },
    [patch],
  );

  return {
    items,
    loading: query.isPending,
    error: query.error,
    fetchingMore: query.isFetchingNextPage,
    hasMore: Boolean(query.hasNextPage),
    loadMore: () => {
      if (query.hasNextPage && !query.isFetchingNextPage) void query.fetchNextPage();
    },
    patch,
    favorite,
    judge,
    note,
    remove,
    restore,
    refetch: () => void query.refetch(),
  };
}
