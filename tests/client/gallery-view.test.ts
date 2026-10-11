// @vitest-environment jsdom
import { createElement, type ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { galleryKey, makeQueryClient, useGallery, type Pages } from "@/openhiggsfield/gallery-data";
import type { GalleryFilter, GalleryItem } from "@/server/gallery";

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("limits an idle gallery to one background request per thirty seconds", async () => {
  vi.useFakeTimers();
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const fetch = vi.fn(async (_input: string) => Response.json({ ok: true, data: { items: [], until: { updatedAt: Date.now(), id: "" } } }));
  vi.stubGlobal("fetch", fetch);
  const client = makeQueryClient();
  client.setQueryData<Pages>(galleryKey({ view: "image" }), { pages: [{ items: [], nextCursor: null, at: Date.now() }], pageParams: [null] });
  const { unmount } = renderHook(() => useGallery({ view: "image" }), {
    wrapper: ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children),
  });
  await act(() => vi.advanceTimersByTimeAsync(29_999));
  expect(fetch).not.toHaveBeenCalled();
  await act(() => vi.advanceTimersByTimeAsync(1));
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0]?.[0]).toMatch(/^\/api\/studio\/changes\?/);
  unmount();
  client.clear();
});

it("clears image results immediately when switching to an uncached video gallery", () => {
  const client = makeQueryClient();
  const image: GalleryItem = {
    id: "image", requestId: "run", surface: "image", kind: "image", modelId: "nano-banana-pro", modelLabel: "Nano Banana Pro",
    prompt: "Image only", ratio: "1 / 1", meta: "", urls: ["https://media.test/image.png"], status: "completed",
    createdAt: 1000, updatedAt: 1000, favorite: false, verdict: null, note: null, settings: {}, userId: "u", userName: "User",
    projectId: "p", productId: "product", mirrored: true, deletedAt: null,
  };
  client.setQueryData<Pages>(galleryKey({ view: "image" }), { pages: [{ items: [image], nextCursor: null }], pageParams: [null] });
  const { result, rerender, unmount } = renderHook(
    (filter: GalleryFilter) => useGallery(filter, { enabled: false, sync: false }),
    { initialProps: { view: "image" } as GalleryFilter, wrapper: ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children) },
  );
  expect(result.current.items.map((item) => item.id)).toEqual(["image"]);
  rerender({ view: "video" });
  expect(result.current.items).toEqual([]);
  expect(result.current.loading).toBe(true);
  rerender({ view: "image" });
  expect(result.current.items.map((item) => item.id)).toEqual(["image"]);
  unmount();
  client.clear();
});
