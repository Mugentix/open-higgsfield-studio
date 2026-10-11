import { beforeEach, describe, expect, it, vi } from "vitest";

import type { MediaItem, MediaRole } from "@/generation/catalog/types";

/* The wire sends each role's urls in the order the store holds them, so what
   `move` does is what decides which reference the prompt calls Image 2. */

function item(id: string, role: MediaRole): MediaItem {
  return { id, url: `https://files.example.com/${id}`, role };
}

const ORDER = (items: MediaItem[]) => items.map((entry) => entry.id);

describe("media store", () => {
  /* A Map stands in for localStorage: the store module reads it per call, so
     stubbing before the import is enough for persist to see it. */
  const backing = new Map<string, string>();
  beforeEach(() => {
    backing.clear();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => backing.get(key) ?? null,
      setItem: (key: string, value: string) => void backing.set(key, value),
      removeItem: (key: string) => void backing.delete(key),
    });
    vi.resetModules();
  });

  async function load() {
    const { useVideoMedia } = await import("@/generation/stores/media");
    const store = useVideoMedia;
    for (const entry of [item("start", "start"), item("r1", "reference"), item("v1", "video"), item("r2", "reference"), item("r3", "reference"), item("v2", "video")]) {
      store.getState().add(entry);
    }
    return store;
  }

  it("adds in order and removes by id", async () => {
    const store = await load();
    expect(ORDER(store.getState().items)).toEqual(["start", "r1", "v1", "r2", "r3", "v2"]);
    store.getState().remove("r2");
    expect(ORDER(store.getState().items)).toEqual(["start", "r1", "v1", "r3", "v2"]);
  });

  it("moves within the role and leaves every other role where it was", async () => {
    const store = await load();
    store.getState().move("r3", 0);
    expect(ORDER(store.getState().items)).toEqual(["start", "r3", "v1", "r1", "r2", "v2"]);
    store.getState().move("r3", 1);
    expect(ORDER(store.getState().items)).toEqual(["start", "r1", "v1", "r3", "r2", "v2"]);
    store.getState().move("v2", 0);
    expect(ORDER(store.getState().items)).toEqual(["start", "r1", "v2", "r3", "r2", "v1"]);
  });

  it("clamps the position to the role's length", async () => {
    const store = await load();
    store.getState().move("r1", 99);
    expect(ORDER(store.getState().items)).toEqual(["start", "r2", "v1", "r3", "r1", "v2"]);
    store.getState().move("r1", -5);
    expect(ORDER(store.getState().items)).toEqual(["start", "r1", "v1", "r2", "r3", "v2"]);
  });

  it("is a no-op for an unknown id or the position already held", async () => {
    const store = await load();
    const before = store.getState();
    store.getState().move("nobody", 0);
    expect(store.getState()).toBe(before);
    store.getState().move("r2", 1);
    expect(store.getState()).toBe(before);
    store.getState().move("start", 3);
    expect(store.getState()).toBe(before);
  });

  it("persists the order it holds", async () => {
    const store = await load();
    store.getState().move("r3", 0);
    const saved = JSON.parse(backing.get("openhiggsfield.videoMedia.v1")!) as { state: { items: MediaItem[] } };
    expect(ORDER(saved.state.items)).toEqual(["start", "r3", "v1", "r1", "r2", "v2"]);
  });
});
