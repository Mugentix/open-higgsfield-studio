import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Workspace } from "@/server/project-actions";

/* The sidebar module reaches for the project and spend actions; the tree it
   draws is pure, so the actions are never called here. */
vi.mock("@/server/project-actions", () => ({
  archiveProject: vi.fn(),
  createProduct: vi.fn(),
  createProject: vi.fn(),
  renameProject: vi.fn(),
}));
vi.mock("@/server/spend-actions", () => ({ getSpend: vi.fn() }));

import {
  filterTree,
  monogram,
  recentProjects,
  rowId,
  sidebarTree,
  treeKey,
  treeRows,
  type SidebarProduct,
  type TreeRow,
} from "@/openhiggsfield/sidebar";

describe("layout store", () => {
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
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /* The store hydrates when the app asks, after mount; loading here does the
     same, so each test sees what the first client commit sees. */
  async function load() {
    const loaded = await import("@/generation/stores/layout");
    await loaded.useLayout.persist.rehydrate();
    return loaded;
  }

  /* A narrow screen, as the store sees it: only matchMedia is asked. */
  function narrowScreen(matches: boolean) {
    vi.stubGlobal("window", { matchMedia: (query: string) => ({ matches: matches && query === "(max-width: 900px)" }) });
  }

  it("stands open where there is no screen to ask, and folds to the rail and back", async () => {
    const { useLayout } = await load();
    expect(useLayout.getState().sidebar).toBe("open");
    useLayout.getState().toggleSidebar();
    expect(useLayout.getState().sidebar).toBe("rail");
    useLayout.getState().toggleSidebar();
    expect(useLayout.getState().sidebar).toBe("open");
  });

  it("persists the sidebar, the shut groups and the recents under its own key and rehydrates from it", async () => {
    const { useLayout, LAYOUT_KEY } = await load();
    expect(LAYOUT_KEY).toBe("openhiggsfield.layout.v1");
    useLayout.getState().toggleSidebar();
    useLayout.getState().toggleCollapsed("acme");
    useLayout.getState().touchRecent("spring");
    const stored = JSON.parse(backing.get(LAYOUT_KEY)!);
    expect(stored.state).toEqual({ sidebar: "rail", collapsed: ["acme"], recent: ["spring"] });

    vi.resetModules();
    const fresh = await load();
    expect(fresh.useLayout.getState().sidebar).toBe("rail");
    expect(fresh.useLayout.getState().collapsed).toEqual(["acme"]);
    expect(fresh.useLayout.getState().recent).toEqual(["spring"]);
    expect(typeof fresh.useLayout.getState().toggleSidebar).toBe("function");
  });

  it("reads open until asked to hydrate, so the first client render matches the server's shell", async () => {
    backing.set("openhiggsfield.layout.v1", JSON.stringify({ state: { sidebar: "rail" }, version: 0 }));
    narrowScreen(true);
    const { useLayout } = await import("@/generation/stores/layout");
    expect(useLayout.getState().sidebar).toBe("open");
    await useLayout.persist.rehydrate();
    expect(useLayout.getState().sidebar).toBe("rail");
  });

  it("starts as the rail on a narrow screen when nothing is stored", async () => {
    narrowScreen(true);
    const { useLayout } = await load();
    expect(useLayout.getState().sidebar).toBe("rail");
  });

  it("starts open on a wide screen when nothing is stored", async () => {
    narrowScreen(false);
    const { useLayout } = await load();
    expect(useLayout.getState().sidebar).toBe("open");
  });

  it("lets the stored choice win over the viewport", async () => {
    backing.set("openhiggsfield.layout.v1", JSON.stringify({ state: { sidebar: "open" }, version: 0 }));
    narrowScreen(true);
    const { useLayout } = await load();
    expect(useLayout.getState().sidebar).toBe("open");
  });

  it("falls back on the viewport when the stored value is not a state", async () => {
    backing.set("openhiggsfield.layout.v1", JSON.stringify({ state: { sidebar: "wide" }, version: 0 }));
    narrowScreen(true);
    const { useLayout } = await load();
    expect(useLayout.getState().sidebar).toBe("rail");
  });

  it("hydrates a record from before the lists existed, or a corrupt one, as empty lists", async () => {
    backing.set("openhiggsfield.layout.v1", JSON.stringify({ state: { sidebar: "open", collapsed: "acme", recent: [1, "spring", null] }, version: 0 }));
    const { useLayout } = await load();
    expect(useLayout.getState().collapsed).toEqual([]);
    expect(useLayout.getState().recent).toEqual(["spring"]);
  });

  it("folds a group shut and open again, and opens one whatever its state", async () => {
    const { useLayout } = await load();
    useLayout.getState().toggleCollapsed("acme");
    useLayout.getState().toggleCollapsed("glow");
    expect(useLayout.getState().collapsed).toEqual(["acme", "glow"]);
    useLayout.getState().toggleCollapsed("acme");
    expect(useLayout.getState().collapsed).toEqual(["glow"]);
    useLayout.getState().expand("glow");
    useLayout.getState().expand("glow");
    expect(useLayout.getState().collapsed).toEqual([]);
  });

  it("keeps the six most recent projects, newest first, each once", async () => {
    const { useLayout, RECENT_MAX } = await load();
    expect(RECENT_MAX).toBe(6);
    for (const id of ["a", "b", "c", "d", "e", "f", "g"]) useLayout.getState().touchRecent(id);
    expect(useLayout.getState().recent).toEqual(["g", "f", "e", "d", "c", "b"]);
    useLayout.getState().touchRecent("c");
    expect(useLayout.getState().recent).toEqual(["c", "g", "f", "e", "d", "b"]);
    const before = useLayout.getState();
    useLayout.getState().touchRecent("c");
    expect(useLayout.getState()).toBe(before);
  });

  it("drops recents the workspace no longer knows", async () => {
    const { useLayout } = await load();
    for (const id of ["a", "b", "c"]) useLayout.getState().touchRecent(id);
    useLayout.getState().pruneRecent(new Set(["a", "c"]));
    expect(useLayout.getState().recent).toEqual(["c", "a"]);
    const before = useLayout.getState();
    useLayout.getState().pruneRecent(new Set(["a", "c"]));
    expect(useLayout.getState()).toBe(before);
  });
});

function project(id: string, productId: string, name: string, status = "active"): Workspace["products"][number]["projects"][number] {
  return { id, productId, name, slug: name.toLowerCase(), brief: null, status, lastUsedAt: 0 };
}

const WORKSPACE: Workspace = {
  defaultProjectId: "inbox",
  products: [
    {
      id: "acme",
      name: "Acme Serum",
      slug: "acme-serum",
      offerUrl: null,
      brandNotes: null,
      projects: [project("inbox", "acme", "General"), project("spring", "acme", "Spring angle"), project("old", "acme", "Old angle", "archived")],
    },
    { id: "glow", name: "Glow", slug: "glow", offerUrl: null, brandNotes: null, projects: [project("glow-1", "glow", "Launch")] },
  ],
};

describe("sidebarTree", () => {
  it("lists every product with its open projects and marks the one holding the current project", () => {
    const tree = sidebarTree(WORKSPACE, "spring");
    expect(tree.map((product) => [product.id, product.active])).toEqual([
      ["acme", true],
      ["glow", false],
    ]);
    expect(tree[0]!.projects.map((entry) => [entry.id, entry.active])).toEqual([
      ["inbox", false],
      ["spring", true],
    ]);
    expect(tree[1]!.projects.map((entry) => entry.active)).toEqual([false]);
  });

  it("keeps archived projects off the list whatever the workspace carries", () => {
    const tree = sidebarTree(WORKSPACE, "old");
    expect(tree[0]!.projects.map((entry) => entry.id)).not.toContain("old");
    expect(tree.every((product) => !product.active)).toBe(true);
  });

  it("is empty before the workspace answers", () => {
    expect(sidebarTree(null, null)).toEqual([]);
  });

  it("folds a product to its initials on the rail", () => {
    expect(sidebarTree(WORKSPACE, null).map((product) => product.mono)).toEqual(["AS", "GL"]);
    expect(monogram("  one   two three ")).toBe("OT");
    expect(monogram("x")).toBe("X");
    expect(monogram("")).toBe("?");
  });
});

describe("filterTree", () => {
  const tree = sidebarTree(WORKSPACE, "spring");

  it("is the whole tree for an empty or blank query", () => {
    expect(filterTree(tree, "")).toBe(tree);
    expect(filterTree(tree, "   ")).toBe(tree);
  });

  it("keeps a product whole when its own name matches, and only the matching projects otherwise", () => {
    expect(filterTree(tree, "ACME").map((product) => [product.id, product.projects.length])).toEqual([["acme", 2]]);
    const narrowed = filterTree(tree, "spring");
    expect(narrowed.map((product) => product.id)).toEqual(["acme"]);
    expect(narrowed[0]!.projects.map((entry) => entry.id)).toEqual(["spring"]);
  });

  it("matches inside a word at either level, and answers empty when nothing does", () => {
    expect(filterTree(tree, "aunch").map((product) => product.id)).toEqual(["glow"]);
    expect(filterTree(tree, "zzz")).toEqual([]);
  });
});

describe("treeRows and treeKey", () => {
  const tree: SidebarProduct[] = sidebarTree(WORKSPACE, "spring");
  const allOpen = () => true;
  const shut = (product: SidebarProduct) => product.id !== "acme";

  it("walks every product and, under the open ones, every project", () => {
    expect(treeRows(tree, allOpen).map((row) => row.id)).toEqual([
      rowId("product", "acme"),
      rowId("project", "inbox"),
      rowId("project", "spring"),
      rowId("product", "glow"),
      rowId("project", "glow-1"),
    ]);
    expect(treeRows(tree, shut).map((row) => row.id)).toEqual([rowId("product", "acme"), rowId("product", "glow"), rowId("project", "glow-1")]);
    expect(treeRows(tree, () => false).map((row) => row.kind)).toEqual(["product", "product"]);
  });

  const rows: TreeRow[] = treeRows(tree, allOpen);
  const expanded = (productId: string) => productId !== "glow";

  it("moves up and down within the rows and stops at the ends", () => {
    expect(treeKey(rows, 0, "ArrowDown", expanded)).toEqual({ focus: 1 });
    expect(treeKey(rows, 4, "ArrowDown", expanded)).toEqual({ focus: 4 });
    expect(treeKey(rows, 0, "ArrowUp", expanded)).toEqual({ focus: 0 });
    expect(treeKey(rows, 3, "Home", expanded)).toEqual({ focus: 0 });
    expect(treeKey(rows, 0, "End", expanded)).toEqual({ focus: 4 });
  });

  it("folds and opens a product with the horizontal arrows, and steps between a project and its parent", () => {
    /* Open product: Right steps onto the first child, Left folds it. */
    expect(treeKey(rows, 0, "ArrowRight", expanded)).toEqual({ focus: 1 });
    expect(treeKey(rows, 0, "ArrowLeft", expanded)).toEqual({ toggle: "acme" });
    /* Shut product: Right opens it, Left has nowhere to go. */
    expect(treeKey(rows, 3, "ArrowRight", expanded)).toEqual({ toggle: "glow" });
    expect(treeKey(rows, 3, "ArrowLeft", expanded)).toBeNull();
    /* Project: Left climbs to the product, Right does nothing. */
    expect(treeKey(rows, 2, "ArrowLeft", expanded)).toEqual({ focus: 0 });
    expect(treeKey(rows, 2, "ArrowRight", expanded)).toBeNull();
  });

  it("opens a project on Enter or Space and toggles a product, and leaves other keys alone", () => {
    expect(treeKey(rows, 2, "Enter", expanded)).toEqual({ open: "spring" });
    expect(treeKey(rows, 2, " ", expanded)).toEqual({ open: "spring" });
    expect(treeKey(rows, 0, "Enter", expanded)).toEqual({ toggle: "acme" });
    expect(treeKey(rows, 0, "r", expanded)).toBeNull();
    expect(treeKey(rows, 9, "ArrowDown", expanded)).toBeNull();
  });
});

describe("recentProjects", () => {
  it("resolves the stored ids against the tree, newest first, and drops what the tree no longer has", () => {
    const tree = sidebarTree(WORKSPACE, "spring");
    expect(recentProjects(tree, ["glow-1", "gone", "old", "spring"])).toEqual([
      { id: "glow-1", name: "Launch", product: "Glow", active: false },
      { id: "spring", name: "Spring angle", product: "Acme Serum", active: true },
    ]);
    expect(recentProjects(tree, [])).toEqual([]);
  });
});
