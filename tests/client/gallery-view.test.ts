// @vitest-environment jsdom
import { createElement, type ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { galleryKey, makeQueryClient, useGallery, type Pages } from "@/openhiggsfield/gallery-data";
import type { GalleryFilter, GalleryItem } from "@/server/gallery";

afterEach(cleanup);

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
