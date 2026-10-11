import { create } from "zustand";
import { persist } from "zustand/middleware";

import type { MediaItem } from "../catalog/types";
import { browserStorage } from "./browser-storage";

type MediaState = {
  items: MediaItem[];
  add: (item: MediaItem) => void;
  remove: (id: string) => void;
  /** Put an item at a position within its own role — the mapper sends each
      role's urls in list order, so this is what decides which one the prompt
      calls Image 2. Other roles keep their places; `to` clamps to the role's
      length; an unknown id changes nothing. */
  move: (id: string, to: number) => void;
};

/** The role's items in their new order, laid back into the slots the role
    already held, so a start frame between two references stays where it was. */
function reorder(items: MediaItem[], id: string, to: number): MediaItem[] {
  const moving = items.find((item) => item.id === id);
  if (!moving) return items;
  const siblings = items.filter((item) => item.role === moving.role);
  const from = siblings.indexOf(moving);
  const target = Math.max(0, Math.min(siblings.length - 1, to));
  if (from === target) return items;
  siblings.splice(from, 1);
  siblings.splice(target, 0, moving);
  let next = 0;
  return items.map((item) => (item.role === moving.role ? siblings[next++]! : item));
}

function createMediaStore(name: string) {
  return create<MediaState>()(
    persist(
      (set) => ({
        items: [],
        add: (item) => set((state) => ({ items: [...state.items, item] })),
        remove: (id) => set((state) => ({ items: state.items.filter((item) => item.id !== id) })),
        move: (id, to) =>
          set((state) => {
            const items = reorder(state.items, id, to);
            return items === state.items ? state : { items };
          }),
      }),
      {
        name,
        storage: browserStorage(),
        partialize: (state) => ({
          items: state.items.filter((item) => !item.url.startsWith("blob:")),
        }),
      },
    ),
  );
}

export const useImageMedia = createMediaStore("openhiggsfield.imageMedia.v1");
export const useVideoMedia = createMediaStore("openhiggsfield.videoMedia.v1");
