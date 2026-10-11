import { describe, expect, it } from "vitest";

import { MODELS, getModel, parseSettings } from "@/generation/catalog";
import type { MediaRole } from "@/generation/catalog";
import { ROLE_KINDS, TILE_TOOLS, tileKeyHint, tileTool, utilityLine } from "@/openhiggsfield/data";

/* The Use menu and the U/B keys submit these entries straight from a tile, so
   each must be a promptless catalog model whose one role takes the tile's
   kind of media — otherwise the press dead-ends on the server. */

const TOOLS = (["image", "video"] as const).flatMap((kind) => TILE_TOOLS[kind].map((tool) => [kind, tool] as const));

describe("TILE_TOOLS", () => {
  it.each(TOOLS)("%s: %o is a promptless catalog entry taking that kind through its one role", (kind, tool) => {
    const entry = getModel(tool.modelId);
    expect(MODELS).toContain(entry);
    expect(entry.prompt).toBe("none");
    const roles = Object.keys(entry.roles) as MediaRole[];
    expect(roles).toHaveLength(1);
    expect(ROLE_KINDS[roles[0]!]).toBe(kind);
  });

  it("gives every tool a distinct lower-case key that is not one of the role keys", () => {
    for (const kind of ["image", "video"] as const) {
      const keys = TILE_TOOLS[kind].map((tool) => tool.key);
      expect(new Set(keys).size).toBe(keys.length);
      for (const key of keys) {
        expect(key).toMatch(/^[a-z]$/);
        expect(["r", "s", "e", "v"]).not.toContain(key);
      }
    }
  });

  it("looks a tool up by its key and lists the letters for the hint", () => {
    /* Crisp Upscale holds U while the Topaz routes are gated; the video side
       has no tool until Topaz Video Upscale is proved live. */
    expect(tileTool("image", "u")?.modelId).toBe("crisp-upscale");
    expect(tileTool("image", "b")?.modelId).toBe("remove-background");
    expect(tileTool("video", "u")).toBeUndefined();
    expect(tileTool("video", "b")).toBeUndefined();
    expect(tileKeyHint("image")).toBe("R · S · E · V · U · B");
    expect(tileKeyHint("video")).toBe("R · S · E · V");
  });
});

describe("utilityLine", () => {
  it("writes the tile line from the entry and its factor", () => {
    const line = (id: string, raw: Record<string, unknown> = {}) => {
      const entry = getModel(id);
      return utilityLine(entry, parseSettings(entry, raw));
    };
    expect(line("topaz-upscale")).toBe("Upscale ×2");
    expect(line("topaz-upscale", { upscaleFactor: "4" })).toBe("Upscale ×4");
    expect(line("crisp-upscale")).toBe("Crisp upscale");
    expect(line("remove-background")).toBe("Background removed");
    expect(line("topaz-video-upscale")).toBe("Video upscale ×2");
  });

  it("falls back to the entry's label for a utility it has no line for", () => {
    const entry = { ...getModel("crisp-upscale"), id: "some-new-tool", label: "Some New Tool", tool: undefined };
    expect(utilityLine(entry, {})).toBe("Some New Tool");
  });
});

describe("the catalog decides the tools", () => {
  it("lists every promptless entry that declares a key, and only those", () => {
    const keyed = MODELS.filter((entry) => entry.prompt === "none" && entry.tool?.key).map((entry) => entry.id);
    const listed = (["image", "video"] as const).flatMap((kind) => TILE_TOOLS[kind].map((tool) => tool.modelId));
    expect(listed.sort()).toEqual(keyed.sort());
    expect(listed).not.toContain("topaz-upscale");
  });

  it("labels a row with the same line the tile will carry", () => {
    for (const kind of ["image", "video"] as const) {
      for (const tool of TILE_TOOLS[kind]) {
        const entry = getModel(tool.modelId);
        expect(tool.label).toBe(utilityLine(entry, parseSettings(entry, {})));
      }
    }
  });
});

describe("hasPlane", () => {
  it("knows a tile published from a skill run has nothing to replay", async () => {
    const { hasPlane } = await import("@/openhiggsfield/data");
    expect(hasPlane({ modelId: "nano-banana-pro" })).toBe(true);
    expect(hasPlane({ modelId: "agent:seedance-dr-cartoon" })).toBe(false);
  });
});
