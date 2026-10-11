import { create } from "zustand";
import { persist } from "zustand/middleware";

import { browserStorage } from "./browser-storage";

/** The sidebar stands open as a 248px column or folds to a 56px rail of
    icons. The visitor's own toggle is remembered per browser. */
export type SidebarState = "open" | "rail";

type LayoutState = {
  sidebar: SidebarState;
  /** Product groups the visitor folded shut in the sidebar, by id. A team
      with forty products reads the column by product; the groups it is not
      working stay shut across visits. */
  collapsed: string[];
  /** The projects opened most recently, newest first, deduped, at most
      RECENT_MAX. Ids only: the sidebar resolves names from the workspace, so
      a renamed project keeps its place and an archived one simply drops out. */
  recent: string[];
  toggleSidebar: () => void;
  toggleCollapsed: (productId: string) => void;
  /** Opens a group whatever its state — the group the current project is in
      is never left shut. */
  expand: (productId: string) => void;
  touchRecent: (projectId: string) => void;
  /** Drops recents the workspace no longer knows, so an archived project does
      not hold one of the six places empty. */
  pruneRecent: (known: ReadonlySet<string>) => void;
};

export const LAYOUT_KEY = "openhiggsfield.layout.v1";

/** How many projects the Recent section holds: enough for the set a visitor
    is working across today, short enough to scan without reading. */
export const RECENT_MAX = 6;

/* Under this width a full column would starve the wall, so a first visit on
   a narrow screen starts folded. Only the very first visit: once the visitor
   has chosen, the stored choice wins at every width. */
export const RAIL_BELOW = "(max-width: 900px)";

function startsAsRail(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(RAIL_BELOW).matches;
}

function isSidebarState(value: unknown): value is SidebarState {
  return value === "open" || value === "rail";
}

/** A stored list is kept only as far as it is a list of ids. */
function idList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

export const useLayout = create<LayoutState>()(
  persist(
    (set) => ({
      sidebar: "open",
      collapsed: [],
      recent: [],
      toggleSidebar: () => set((state) => ({ sidebar: state.sidebar === "open" ? "rail" : "open" })),
      toggleCollapsed: (productId) =>
        set((state) => ({
          collapsed: state.collapsed.includes(productId)
            ? state.collapsed.filter((id) => id !== productId)
            : [...state.collapsed, productId],
        })),
      expand: (productId) =>
        set((state) => (state.collapsed.includes(productId) ? { collapsed: state.collapsed.filter((id) => id !== productId) } : state)),
      touchRecent: (projectId) =>
        set((state) => {
          if (state.recent[0] === projectId) return state;
          return { recent: [projectId, ...state.recent.filter((id) => id !== projectId)].slice(0, RECENT_MAX) };
        }),
      pruneRecent: (known) =>
        set((state) => {
          const recent = state.recent.filter((id) => known.has(id));
          return recent.length === state.recent.length ? state : { recent };
        }),
    }),
    {
      name: LAYOUT_KEY,
      storage: browserStorage(),
      partialize: (state) => ({ sidebar: state.sidebar, collapsed: state.collapsed, recent: state.recent }),
      /* Hydration waits for the app to ask, after mount. The shell is
         server-rendered open; a store already reading "rail" at module
         evaluation would put the first client render against that markup,
         and React keeps the server's data-sidebar on a mismatch — the rail
         would be drawn open until the second toggle. Rehydrated from an
         effect, the stored or narrow-screen choice lands on first paint. */
      skipHydration: true,
      /* Nothing stored yet — or a value this version does not know — falls
         back on the viewport rather than on "open" regardless of screen. The
         lists are read the same way: a record from before they existed, or
         one something else wrote, hydrates as empty rather than as a crash. */
      merge: (persisted, current) => {
        const stored = (persisted as { sidebar?: unknown; collapsed?: unknown; recent?: unknown } | undefined) ?? {};
        return {
          ...current,
          sidebar: isSidebarState(stored.sidebar) ? stored.sidebar : startsAsRail() ? "rail" : "open",
          collapsed: idList(stored.collapsed),
          recent: idList(stored.recent).slice(0, RECENT_MAX),
        };
      },
    },
  ),
);
