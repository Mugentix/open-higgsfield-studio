import { describe, expect, it } from "vitest";

import { getModel } from "@/generation/catalog";
import type { MediaItem } from "@/generation/catalog";
import { planeConflict } from "@/openhiggsfield/data";

const item = (role: MediaItem["role"], n = 1): MediaItem => ({ id: `${role}-${n}`, url: `https://x.test/${role}-${n}.png`, role });

/* An exclusive plane holding both groups is refused at submit by pickShape;
   the composer says so first, and only then. */
describe("planeConflict", () => {
  it("names the refusal when an exclusive entry holds a frame and a reference", () => {
    const seedance = getModel("seedance-2.5");
    expect(planeConflict(seedance, [item("start"), item("reference")])).toBe(
      "Seedance 2.5 takes either frames or references — remove the start frame or the references before generating",
    );
    expect(planeConflict(seedance, [item("start"), item("end"), item("audio")])).toBe(
      "Seedance 2.5 takes either frames or references — remove the frames or the references before generating",
    );
  });

  it("is quiet for one group alone, and for entries that take both", () => {
    const seedance = getModel("seedance-2.5");
    expect(planeConflict(seedance, [item("start"), item("end")])).toBeNull();
    expect(planeConflict(seedance, [item("reference"), item("video")])).toBeNull();
    expect(planeConflict(seedance, [])).toBeNull();
    const open = getModel("nano-banana-pro");
    expect(planeConflict(open, [item("start"), item("reference")])).toBeNull();
  });
});
