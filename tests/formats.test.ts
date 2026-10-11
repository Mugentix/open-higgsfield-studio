import { beforeEach, describe, expect, it, vi } from "vitest";

import { kling3MotionStd } from "@/generation/catalog/kling-3-motion";
import { nanoBananaPro } from "@/generation/catalog/nano-banana-pro";
import { seedance25 } from "@/generation/catalog/seedance-2.5";
import { FORMATS_CAP, aspectRatiosOf, planesFor, ratiosFor } from "@/generation/formats";

import { IMG, plane } from "./plane";

describe("planesFor", () => {
  it("puts the primary first and one override per extra ratio, in the order given", () => {
    const source = plane(nanoBananaPro, { settings: { aspectRatio: "1:1" } });
    const planes = planesFor(source, ["9:16", "4:5"]);
    expect(planes.map((entry) => entry.settings.aspectRatio)).toEqual(["1:1", "9:16", "4:5"]);
    expect(planes[0]).toBe(source);
  });

  it("overrides aspectRatio alone and carries everything else across", () => {
    const source = plane(nanoBananaPro, {
      prompt: "a cafe poster",
      settings: { aspectRatio: "1:1", resolution: "2k" },
      media: { reference: [IMG] },
    });
    const [, story] = planesFor(source, ["9:16"]);
    expect(story).toEqual({
      ...source,
      settings: { ...source.settings, aspectRatio: "9:16" },
    });
    expect(story!.settings.resolution).toBe("2k");
    expect(story!.media).toBe(source.media);
    expect(story!.prompt).toBe(source.prompt);
  });

  it("never mutates the source plane", () => {
    const source = plane(seedance25, { settings: { aspectRatio: "16:9" } });
    const before = structuredClone(source);
    const planes = planesFor(source, ["9:16", "1:1"]);
    planes[1]!.settings.duration = 30;
    expect(source).toEqual(before);
    expect(planes[2]!.settings.duration).toBe(before.settings.duration);
  });

  it("skips the primary's own ratio and repeats", () => {
    const source = plane(nanoBananaPro, { settings: { aspectRatio: "4:5" } });
    const planes = planesFor(source, ["4:5", "9:16", "9:16", "1:1"]);
    expect(planes.map((entry) => entry.settings.aspectRatio)).toEqual(["4:5", "9:16", "1:1"]);
  });

  it("is just the plane when there is nothing extra", () => {
    const source = plane(nanoBananaPro);
    expect(planesFor(source, [])).toEqual([source]);
  });
});

describe("ratiosFor", () => {
  it("keeps only the ratios the model offers, in the catalog's order", () => {
    expect(ratiosFor(nanoBananaPro, ["9:16", "3:7", "1:1", "4:5"])).toEqual(["1:1", "4:5", "9:16"]);
    expect(ratiosFor(seedance25, ["9:16", "4:5"])).toEqual(["9:16"]);
  });

  it("drops repeats and unknown values", () => {
    expect(ratiosFor(nanoBananaPro, ["1:1", "1:1", "square"])).toEqual(["1:1"]);
    expect(ratiosFor(nanoBananaPro, [])).toEqual([]);
  });

  it("offers nothing for a model whose output size is not a setting", () => {
    expect(aspectRatiosOf(kling3MotionStd)).toBeNull();
    expect(ratiosFor(kling3MotionStd, ["16:9", "1:1"])).toEqual([]);
  });

  it("reads the ratios off the catalog entry itself", () => {
    const field = nanoBananaPro.settings.aspectRatio!;
    if (field.type !== "enum") throw new Error("nano-banana-pro's aspectRatio is an enum");
    expect(aspectRatiosOf(nanoBananaPro)).toBe(field.values);
  });
});

describe("FORMATS_CAP", () => {
  it("bounds formats × batch at a dozen results", () => {
    expect(FORMATS_CAP).toBe(12);
    const source = plane(nanoBananaPro, { settings: { aspectRatio: "1:1" } });
    const three = planesFor(source, ["4:5", "9:16"]);
    expect(three.length * 4).toBeLessThanOrEqual(FORMATS_CAP);
    const four = planesFor(source, ["4:5", "9:16", "16:9"]);
    expect(four.length * 4).toBeGreaterThan(FORMATS_CAP);
  });
});

describe("formats store", () => {
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
    const { useFormats } = await import("@/generation/stores/formats");
    return useFormats;
  }

  it("toggles a ratio on and off per model", async () => {
    const useFormats = await load();
    const { toggle } = useFormats.getState();
    toggle("nano-banana-pro", "9:16");
    toggle("nano-banana-pro", "4:5");
    toggle("seedance-2.5", "9:16");
    expect(useFormats.getState().byModel).toEqual({
      "nano-banana-pro": ["9:16", "4:5"],
      "seedance-2.5": ["9:16"],
    });
    toggle("nano-banana-pro", "9:16");
    expect(useFormats.getState().byModel["nano-banana-pro"]).toEqual(["4:5"]);
  });

  it("drops the model's entry once its last ratio is toggled off or it is cleared", async () => {
    const useFormats = await load();
    const { toggle, clear } = useFormats.getState();
    toggle("nano-banana-pro", "9:16");
    toggle("nano-banana-pro", "9:16");
    expect(useFormats.getState().byModel).not.toHaveProperty("nano-banana-pro");
    toggle("seedance-2.5", "9:16");
    toggle("seedance-2.5", "1:1");
    clear("seedance-2.5");
    expect(useFormats.getState().byModel).toEqual({});
  });

  it("leaves state untouched when clearing a model it never held", async () => {
    const useFormats = await load();
    const before = useFormats.getState();
    useFormats.getState().clear("flux-2");
    expect(useFormats.getState()).toBe(before);
  });

  it("persists byModel alone under its own key and rehydrates from it", async () => {
    const useFormats = await load();
    useFormats.getState().toggle("nano-banana-pro", "9:16");
    const stored = JSON.parse(backing.get("openhiggsfield.formats.v1")!);
    expect(stored.state).toEqual({ byModel: { "nano-banana-pro": ["9:16"] } });

    vi.resetModules();
    const fresh = await load();
    expect(fresh.getState().byModel).toEqual({ "nano-banana-pro": ["9:16"] });
    expect(typeof fresh.getState().toggle).toBe("function");
  });
});
