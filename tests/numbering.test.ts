import { describe, expect, it } from "vitest";

import { MODELS, getModel } from "@/generation/catalog";
import type { MediaItem, MediaRole } from "@/generation/catalog/types";
import { LIST_ROLES, numberedItems, numbersInputs, orderHint, roleAccepts } from "@/openhiggsfield/data";

/* The strip's "REF 2" is reference_image_urls[1]: the number is the item's
   place within its role, counted the way the mapper walks the plane, and
   nothing else. Frames are one url under their own key and carry none. */

function item(id: string, role: MediaRole): MediaItem {
  return { id, url: `https://files.example.com/${id}`, role };
}

describe("numberedItems", () => {
  const seedance = getModel("seedance-2.5");

  it("numbers each list role from 1 in the order held, and skips the frames", () => {
    const items = [
      item("s", "start"),
      item("r1", "reference"),
      item("v1", "video"),
      item("r2", "reference"),
      item("a1", "audio"),
      item("e", "end"),
      item("r3", "reference"),
      item("v2", "video"),
    ];
    expect(numberedItems(items, seedance.roles).map((entry) => [entry.item.id, entry.n])).toEqual([
      ["s", undefined],
      ["r1", 1],
      ["v1", 1],
      ["r2", 2],
      ["a1", 1],
      ["e", undefined],
      ["r3", 3],
      ["v2", 2],
    ]);
  });

  it("keeps the items' order and identity", () => {
    const items = [item("r1", "reference"), item("r2", "reference")];
    const numbered = numberedItems(items, seedance.roles);
    expect(numbered.map((entry) => entry.item)).toEqual(items);
    expect(numbered[0]!.item).toBe(items[0]);
  });

  it("numbers nothing on an entry whose lists hold one item in all", () => {
    const upscale = getModel("crisp-upscale");
    expect(numbersInputs(upscale.roles)).toBe(false);
    expect(numberedItems([item("r1", "reference")], upscale.roles)).toEqual([{ item: item("r1", "reference"), sent: true }]);
    const ideogram = getModel("ideogram-3");
    expect(numbersInputs(ideogram.roles)).toBe(false);
  });

  it("marks items past the role's cap as not sent and gives them no number", () => {
    /* The store is shared across models: three clips held under Seedance are
       still there under Kling Omni, whose video slot takes one. assemblePlane
       sends video[0] alone, so only that one is Video 1. */
    const omni = getModel("kling-3-omni");
    const clips = numberedItems([item("v1", "video"), item("v2", "video"), item("v3", "video"), item("r1", "reference")], omni.roles);
    expect(clips.map((entry) => [entry.item.id, entry.n, entry.sent])).toEqual([
      ["v1", 1, true],
      ["v2", undefined, false],
      ["v3", undefined, false],
      ["r1", 1, true],
    ]);
    /* Nine references carried into Veo 3.1 (three): REF 1–3 go, the rest stay. */
    const veo = getModel("veo-3.1");
    const refs = numberedItems(Array.from({ length: 9 }, (_, index) => item(`r${index + 1}`, "reference")), veo.roles);
    expect(refs.map((entry) => entry.n)).toEqual([1, 2, 3, undefined, undefined, undefined, undefined, undefined, undefined]);
    expect(refs.filter((entry) => entry.sent).map((entry) => entry.item.id)).toEqual(["r1", "r2", "r3"]);
    /* A second frame under a one-frame key is held but not sent either. */
    expect(numberedItems([item("s1", "start"), item("s2", "start")], veo.roles).map((entry) => entry.sent)).toEqual([true, false]);
  });

  it("numbers a one-slot video role on an entry whose images are a list", () => {
    /* Kling Omni takes one clip beside up to seven images: the prompt still
       says Video 1, so the badge does too. */
    const omni = getModel("kling-3-omni");
    expect(numbersInputs(omni.roles)).toBe(true);
    expect(numberedItems([item("v", "video"), item("r", "reference")], omni.roles).map((entry) => entry.n)).toEqual([1, 1]);
  });

  it("is decided by the catalog: every multi-reference generator numbers", () => {
    for (const entry of MODELS) {
      let slots = 0;
      for (const role of LIST_ROLES) slots += entry.roles[role] ?? 0;
      expect(numbersInputs(entry.roles)).toBe(slots > 1);
    }
  });
});

describe("orderHint", () => {
  it("names the kinds the entry takes, in the wire's words", () => {
    expect(orderHint(getModel("seedance-2.5"))).toBe("Refer to inputs as Image 1, Video 1, Audio 1 in the prompt.");
    expect(orderHint(getModel("kling-3-omni"))).toBe("Refer to inputs as Image 1, Video 1 in the prompt.");
    expect(orderHint(getModel("nano-banana-pro"))).toBe("Refer to references as Image 1, Image 2… in the prompt.");
  });
});

describe("roleAccepts", () => {
  it("applies the role's own allow-list to a dropped file", () => {
    expect(roleAccepts("reference", { type: "image/png" })).toBe(true);
    expect(roleAccepts("reference", { type: "video/mp4" })).toBe(false);
    expect(roleAccepts("video", { type: "video/mp4" })).toBe(true);
    expect(roleAccepts("audio", { type: "audio/mpeg" })).toBe(true);
    expect(roleAccepts("start", { type: "" })).toBe(false);
  });
});
