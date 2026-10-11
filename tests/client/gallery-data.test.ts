import { describe, expect, it, vi } from "vitest";

import type { GalleryCursor, GalleryFilter, GalleryItem } from "@/server/gallery";

/* The cache rules are pure; the server actions behind the hook are not called. */
vi.mock("@/server/gallery-actions", () => ({
  listGallery: vi.fn(),
  removeResults: vi.fn(),
  restoreRemoved: vi.fn(),
  setFavorite: vi.fn(),
  setNote: vi.fn(),
  setVerdict: vi.fn(),
  syncGallery: vi.fn(),
}));

import { applyChanges, type Pages } from "@/openhiggsfield/gallery-data";

const ALL: GalleryFilter = { view: "assets" };

function item(id: string, createdAt: number, patch: Partial<GalleryItem> = {}): GalleryItem {
  return {
    id,
    requestId: `run-${id}`,
    surface: "image",
    kind: "image",
    modelId: "nano-banana-pro",
    modelLabel: "Nano Banana Pro",
    prompt: "a tile",
    ratio: "1 / 1",
    meta: "",
    urls: [`https://media.test/${id}.png`],
    status: "completed",
    createdAt,
    updatedAt: createdAt,
    favorite: false,
    verdict: null,
    note: null,
    settings: {},
    userId: "u1",
    userName: "Tester",
    projectId: "p1",
    productId: "pr1",
    mirrored: true,
    deletedAt: null,
    ...patch,
  };
}

/** Pages as react-query holds them; the last page's cursor says whether more
    tiles exist on the server. */
function pagesOf(pages: GalleryItem[][], nextCursor: GalleryCursor | null): Pages {
  return {
    pages: pages.map((items, index) => ({ items, nextCursor: index === pages.length - 1 ? nextCursor : cursorOf(items[items.length - 1]!), at: 1000 })),
    pageParams: pages.map((_, index) => (index === 0 ? null : cursorOf(pages[index - 1]![pages[index - 1]!.length - 1]!))),
  };
}

function cursorOf(last: GalleryItem): GalleryCursor {
  return { createdAt: last.createdAt, id: last.id };
}

function ids(pages: Pages | undefined): string[][] {
  return (pages?.pages ?? []).map((page) => page.items.map((i) => i.id));
}

const c = item("c", 300);
const b = item("b", 200);
const a = item("a", 100);

describe("applyChanges", () => {
  it("updates a cached tile in place and drops one that was deleted or no longer matches", () => {
    const pages = pagesOf([[c, b], [a]], null);
    const next = applyChanges(pages, [{ ...b, favorite: true }, { ...a, deletedAt: 5 }], ALL);
    expect(ids(next)).toEqual([["c", "b"], []]);
    expect(next!.pages[0]!.items[1]!.favorite).toBe(true);

    const favorites = applyChanges(pagesOf([[c, { ...b, favorite: true }]], null), [b], { view: "favorites" });
    expect(ids(favorites)).toEqual([["c"]]);
  });

  it("drops an old tile arriving through the feed when the page it belongs to is not loaded", () => {
    const pages = pagesOf([[c, b]], cursorOf(b));
    const next = applyChanges(pages, [a], ALL);
    expect(ids(next)).toEqual([["c", "b"]]);
    /* When that page arrives from the server the tile comes once, in place. */
    const loaded: Pages = { pages: [...next!.pages, { items: [a], nextCursor: null, at: 1000 }], pageParams: [...next!.pageParams, cursorOf(b)] };
    expect(ids(applyChanges(loaded, [{ ...a, favorite: true }], ALL))).toEqual([["c", "b"], ["a"]]);
  });

  it("slots an old tile into the last page, in order, once every page is loaded", () => {
    const z = item("z", 50);
    const pages = pagesOf([[c, b], [a]], null);
    expect(ids(applyChanges(pages, [z], ALL))).toEqual([["c", "b"], ["a", "z"]]);
  });

  it("slots a fresh tile inside the loaded window onto the page it belongs to", () => {
    const x = item("x", 150);
    const n = item("n", 400);
    const pages = pagesOf([[c, b], [a]], cursorOf(a));
    const next = applyChanges(pages, [x, n], ALL);
    expect(ids(next)).toEqual([["n", "c", "b"], ["x", "a"]]);
    expect(next!.pages[1]!.nextCursor).toEqual(cursorOf(a));
  });

  it("breaks a created_at tie on id, as the server does", () => {
    const pages = pagesOf([[c, item("m", 100)]], { createdAt: 100, id: "m" });
    const newer = item("n", 100);
    const older = item("a", 100);
    expect(ids(applyChanges(pages, [newer, older], ALL))).toEqual([["c", "n", "m"]]);
  });

  it("keeps a tile that appears on two pages only once", () => {
    const pages = pagesOf([[c, b], [b, a]], null);
    const next = applyChanges(pages, [{ ...b, favorite: true }], ALL);
    expect(ids(next)).toEqual([["c", "b"], ["a"]]);
    expect(ids(applyChanges(pages, [], ALL))).toEqual([["c", "b"], ["a"]]);
  });

  it("an optimistic delete and its rollback leave the wall in server order", () => {
    const pages = pagesOf([[c, b], [a]], cursorOf(a));
    const removed = applyChanges(pages, [{ ...b, deletedAt: 5 }], ALL);
    expect(ids(removed)).toEqual([["c"], ["a"]]);
    const restored = applyChanges(removed, [b], ALL);
    expect(ids(restored)!.flat()).toEqual(["c", "b", "a"]);
  });

  it("keeps only the tiles that carry the call a verdict filter asks for, and the unjudged under none", () => {
    const winners: GalleryFilter = { view: "assets", verdict: "winner" };
    const pages = pagesOf([[{ ...c, verdict: "winner" }, { ...b, verdict: "winner" }]], null);
    /* b's call moves on and a's is made: b leaves the Winners scope, a joins it in order. */
    const next = applyChanges(pages, [{ ...b, verdict: "testing" }, { ...a, verdict: "winner" }], winners);
    expect(ids(next)).toEqual([["c", "a"]]);
    expect(next!.pages[0]!.items[1]!.verdict).toBe("winner");

    const none = applyChanges(
      pagesOf([[c, b]], null),
      [{ ...c, verdict: "killed" }, { ...b, note: "still open" }],
      { view: "assets", verdict: "none" },
    );
    expect(ids(none)).toEqual([["b"]]);
    expect(none!.pages[0]!.items[0]!.note).toBe("still open");
    /* Taking a call back brings the tile home to the unjudged. */
    expect(ids(applyChanges(none, [{ ...c, verdict: null }], { view: "assets", verdict: "none" }))).toEqual([["c", "b"]]);
  });

  it("leaves an absent or empty cache alone", () => {
    expect(applyChanges(undefined, [a], ALL)).toBeUndefined();
    const empty: Pages = { pages: [], pageParams: [] };
    expect(applyChanges(empty, [a], ALL)).toBe(empty);
    expect(ids(applyChanges(pagesOf([[]], null), [a], ALL))).toEqual([["a"]]);
  });
});
