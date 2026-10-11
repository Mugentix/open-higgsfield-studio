import { describe, expect, it } from "vitest";

import { modelFor, useTargetsFor } from "@/generation/attach";
import { MODELS, getModel } from "@/generation/catalog";

/* A tile's "use as…" picks a model on the visitor's behalf when the one in the
   composer cannot take the role. That pick is a generation from the tile, never
   a utility run on it: the upscalers and the background remover declare the
   same roles, and must sit this choice out. */

const UTILITIES = MODELS.filter((entry) => entry.prompt === "none");
const GENERATORS = MODELS.filter((entry) => entry.prompt !== "none");

describe("modelFor", () => {
  it("has utilities to keep out and generators to fall back on", () => {
    expect(UTILITIES.length).toBeGreaterThan(0);
    expect(GENERATORS.some((entry) => entry.roles.reference)).toBe(true);
    expect(GENERATORS.some((entry) => entry.roles.video)).toBe(true);
  });

  it("keeps the current model when it takes the role", () => {
    const model = getModel("nano-banana-pro");
    expect(modelFor("reference", model)).toBe(model);
  });

  it.each(["reference", "start", "end", "video"] as const)(
    "never switches to a promptless utility for the %s role",
    (role) => {
      for (const current of GENERATORS) {
        const target = modelFor(role, current);
        if (current.roles[role]) {
          expect(target).toBe(current);
          continue;
        }
        expect(target?.prompt).not.toBe("none");
      }
    },
  );

  it("prefers a generator on the same surface even when a utility on it comes later in the picker", () => {
    /* A text-only video model lands its references on a video generator that
       takes them, not on the video upscaler that closes the surface. */
    const textOnly = GENERATORS.find((entry) => entry.surface === "video" && !entry.roles.reference);
    if (!textOnly) return;
    const target = modelFor("reference", textOnly);
    expect(target).not.toBeNull();
    expect(target?.prompt).not.toBe("none");
  });

  it("keeps a utility that is already in the composer for the role it declares", () => {
    const upscale = getModel("topaz-upscale");
    expect(modelFor("reference", upscale)).toBe(upscale);
  });
});

describe("useTargetsFor", () => {
  it("names no utility as the model a tile switches to", () => {
    const names = new Set(UTILITIES.map((entry) => entry.label));
    for (const current of MODELS) {
      for (const kind of ["image", "video"] as const) {
        for (const target of useTargetsFor(kind, current)) {
          if (target.modelLabel) expect(names.has(target.modelLabel)).toBe(false);
        }
      }
    }
  });
});
