import { describe, expect, it } from "vitest";

import { MODELS } from "@/generation/catalog";
import type { Workspace } from "@/server/project-actions";
import { PALETTE_CAP, paletteItems, paletteScore, paletteSections, type PaletteSource } from "@/openhiggsfield/command-palette";

/* The palette is built from the workspace and the catalog every time it
   opens — never from a list of its own — and ranks what is typed by where the
   words land. Both are pure, so they are pinned here without a DOM. */

function project(id: string, productId: string, name: string, status = "active"): Workspace["products"][number]["projects"][number] {
  return { id, productId, name, slug: name.toLowerCase(), brief: null, status, lastUsedAt: 0 };
}

const WORKSPACE: Workspace = {
  defaultProjectId: "general",
  products: [
    {
      id: "coffee",
      name: "Coffee Pods",
      slug: "coffee-pods",
      offerUrl: null,
      brandNotes: null,
      projects: [project("general", "coffee", "General"), project("retarget", "coffee", "Retargeting"), project("old", "coffee", "Old angle", "archived")],
    },
    { id: "glow", name: "Glow Serum", slug: "glow-serum", offerUrl: null, brandNotes: null, projects: [project("launch", "glow", "Launch")] },
  ],
};

const video = MODELS.find((model) => model.surface === "video")!;
const image = MODELS.find((model) => model.surface === "image")!;

const SOURCE: PaletteSource = {
  workspace: WORKSPACE,
  models: [video, image],
  projectId: "retarget",
  modelId: video.id,
  view: "video",
  sidebar: "open",
  templates: false,
};

describe("paletteItems", () => {
  const items = paletteItems(SOURCE);

  it("lists every open project under its product, every product, every model given, the scopes and the actions", () => {
    expect(items.filter((item) => item.kind === "project").map((item) => [item.parent, item.label])).toEqual([
      ["Coffee Pods", "General"],
      ["Coffee Pods", "Retargeting"],
      ["Glow Serum", "Launch"],
    ]);
    expect(items.filter((item) => item.kind === "product").map((item) => item.hint)).toEqual(["Product · 2 projects", "Product · 1 project"]);
    expect(items.filter((item) => item.kind === "model").map((item) => item.label)).toEqual([video.label, image.label]);
    expect(items.filter((item) => item.kind === "scope").map((item) => item.label)).toEqual(["Image", "Video", "Assets", "Favorites"]);
    expect(items.filter((item) => item.kind === "action").map((item) => item.command)).toEqual([
      { type: "action", action: "new-project" },
      { type: "action", action: "new-product" },
      { type: "action", action: "toggle-sidebar" },
      { type: "action", action: "team" },
      { type: "action", action: "shortcuts" },
    ]);
  });

  it("marks the project, product, model and scope in force, and names the product a new project lands in", () => {
    const current = items.filter((item) => item.current).map((item) => item.id);
    expect(current).toEqual(["project:retarget", "product:coffee", `model:${video.id}`, "scope:video"]);
    expect(items.find((item) => item.id === "action:new-project")!.hint).toBe("in Coffee Pods");
    expect(items.find((item) => item.id === "action:toggle-sidebar")!.label).toBe("Fold the sidebar");
    expect(paletteItems({ ...SOURCE, sidebar: "rail" }).find((item) => item.id === "action:toggle-sidebar")!.label).toBe("Open the sidebar");
  });

  it("offers Templates only once a library is wired in, and stands without a workspace", () => {
    expect(items.some((item) => item.id === "action:templates")).toBe(false);
    expect(paletteItems({ ...SOURCE, templates: true }).some((item) => item.id === "action:templates")).toBe(true);
    const bare = paletteItems({ ...SOURCE, workspace: null, projectId: null });
    expect(bare.some((item) => item.kind === "project" || item.kind === "product")).toBe(false);
    expect(bare.find((item) => item.id === "action:new-project")!.hint).toBe("Action");
  });

  it("reads the models it is handed, so the catalog stays the one list", () => {
    expect(paletteItems({ ...SOURCE, models: MODELS }).filter((item) => item.kind === "model")).toHaveLength(MODELS.length);
  });
});

describe("paletteScore", () => {
  const items = paletteItems(SOURCE);
  const retarget = items.find((item) => item.id === "project:retarget")!;
  const launch = items.find((item) => item.id === "project:launch")!;

  it("ranks the label's own start first, then a word of it, then anywhere in it, then the parent", () => {
    expect(paletteScore(retarget, "ret")).toBe(0);
    expect(paletteScore(retarget, "RETARGETING")).toBe(0);
    expect(paletteScore(items.find((item) => item.id === "product:coffee")!, "pods")).toBe(1);
    expect(paletteScore(retarget, "targ")).toBe(2);
    expect(paletteScore(retarget, "coffee")).toBe(3);
    expect(paletteScore(retarget, "pods")).toBe(4);
  });

  it("wants every word typed somewhere in label or parent, and answers null otherwise", () => {
    expect(paletteScore(retarget, "coffee retarg")).toBe(3);
    expect(paletteScore(retarget, "retarg coffee")).toBe(0);
    expect(paletteScore(launch, "coffee")).toBeNull();
    expect(paletteScore(retarget, "xyz")).toBeNull();
    expect(paletteScore(retarget, "")).toBe(0);
  });
});

describe("paletteSections", () => {
  const items = paletteItems(SOURCE);

  it("lands on the recents, the scopes and the actions when nothing is typed", () => {
    const sections = paletteSections(items, "", ["launch", "gone", "retarget"]);
    expect(sections.map((section) => section.title)).toEqual(["Recent", "Scopes", "Actions"]);
    expect(sections[0]!.items.map((item) => item.id)).toEqual(["project:launch", "project:retarget"]);
    expect(sections[1]!.items.map((item) => item.kind)).toEqual(["scope", "scope", "scope", "scope"]);
    expect(paletteSections(items, "  ", []).map((section) => section.title)).toEqual(["Scopes", "Actions"]);
  });

  it("ranks one list once something is typed: exact prefix first, then by kind, then by source order", () => {
    const [section] = paletteSections(items, "g", []);
    expect(section!.title).toMatch(/results$/);
    const ids = section!.items.map((item) => item.id);
    /* "General" and "Glow Serum" both start with g; the project ranks before
       the product on a tie. "Retargeting" carries a g mid-word and follows. */
    expect(ids.indexOf("project:general")).toBeLessThan(ids.indexOf("product:glow"));
    expect(ids.indexOf("product:glow")).toBeLessThan(ids.indexOf("project:retarget"));
    expect(paletteSections(items, "retargeting", [])[0]!.items.map((item) => item.id)).toEqual(["project:retarget"]);
  });

  it("finds a model by its surface word, and caps a long answer", () => {
    const [byWord] = paletteSections(items, "video", []);
    expect(byWord!.items.map((item) => item.id)).toContain(`model:${video.id}`);
    expect(byWord!.items.map((item) => item.id)).toContain("scope:video");
    const many = paletteItems({
      ...SOURCE,
      workspace: {
        defaultProjectId: "p0",
        products: [
          {
            id: "big",
            name: "Big",
            slug: "big",
            offerUrl: null,
            brandNotes: null,
            projects: Array.from({ length: 80 }, (_, index) => project(`p${index}`, "big", `Angle ${index}`)),
          },
        ],
      },
    });
    expect(paletteSections(many, "angle", [])[0]!.items).toHaveLength(PALETTE_CAP);
  });
});
