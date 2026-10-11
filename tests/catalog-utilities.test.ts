import { describe, expect, it } from "vitest";

import { ALL_MODELS, kieSurface } from "@/generation/catalog";
import type { MediaRole } from "@/generation/catalog/types";
import { toKieFor } from "@/generation/to-kie";

import { IMG, VID, plane } from "./plane";

/* The composer hides the textarea and the tile menus submit in one press on
   the strength of these shapes: a utility works on exactly one input and the
   wire never carries a prompt. */
const UTILITIES = ALL_MODELS.filter((entry) => entry.prompt === "none");
const SAMPLE: Partial<Record<MediaRole, string>> = { reference: IMG, video: VID };

describe("promptless utilities", () => {
  it("exist for both surfaces", () => {
    expect(UTILITIES.map((entry) => entry.id)).toEqual([
      "topaz-upscale",
      "crisp-upscale",
      "remove-background",
      "topaz-video-upscale",
    ]);
  });

  it.each(UTILITIES.map((entry) => [entry.id, entry] as const))(
    "%s declares exactly one role, capped at one, with a wire key",
    (_id, entry) => {
      const roles = Object.entries(entry.roles);
      expect(roles).toHaveLength(1);
      const [role, cap] = roles[0]!;
      expect(cap).toBe(1);
      expect(entry.kie.media?.[role as MediaRole]).toBeTypeOf("string");
    },
  );

  it.each(UTILITIES.map((entry) => [entry.id, entry] as const))(
    "%s reaches KIE through one reference-shape model whose result kind is its surface",
    (_id, entry) => {
      expect(Object.keys(entry.kie.models)).toEqual(["reference"]);
      expect(kieSurface(entry.kie.models.reference!)).toBe(entry.surface);
    },
  );

  it.each(UTILITIES.map((entry) => [entry.id, entry] as const))(
    "%s sends its input as a string and no prompt, whatever the tile text says",
    (_id, entry) => {
      const role = Object.keys(entry.roles)[0] as MediaRole;
      const request = toKieFor(plane(entry, { prompt: "Upscale ×2", media: { [role]: [SAMPLE[role]!] } }), entry);
      expect(request.model).toBe(entry.kie.models.reference);
      expect(request.input).not.toHaveProperty("prompt");
      expect(request.input[entry.kie.media![role]!]).toBe(SAMPLE[role]);
    },
  );

  it("close the picker order of their surface", () => {
    for (const surface of ["image", "video"] as const) {
      /* Read off the whole catalog: a gated utility keeps its place in the
         order even while the picker leaves it out. */
      const ids = ALL_MODELS.filter((entry) => entry.surface === surface).map((entry) => entry.prompt ?? "text");
      const firstUtility = ids.indexOf("none");
      expect(firstUtility).toBeGreaterThan(0);
      expect(ids.slice(firstUtility).every((kind) => kind === "none")).toBe(true);
    }
  });
});
