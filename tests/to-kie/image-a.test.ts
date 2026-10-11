import { describe, expect, it } from "vitest";

import { flux2 } from "@/generation/catalog/flux-2";
import { gptImage25 } from "@/generation/catalog/gpt-image-2.5";
import { seedream45 } from "@/generation/catalog/seedream-4.5";
import { toKieFor } from "@/generation/to-kie";

import { IMG, IMG2, plane } from "../plane";

describe("seedream-4.5", () => {
  it("text shape sends prompt, aspect_ratio and quality, nothing else", () => {
    expect(toKieFor(plane(seedream45, { prompt: "a cafe poster" }), seedream45)).toEqual({
      model: "seedream/4.5-text-to-image",
      input: { prompt: "a cafe poster", aspect_ratio: "1:1", quality: "basic" },
    });
  });

  it("reference shape switches to the edit model with image_urls", () => {
    const request = toKieFor(
      plane(seedream45, {
        settings: { aspectRatio: "21:9", quality: "high" },
        media: { reference: [IMG, IMG2] },
      }),
      seedream45,
    );
    expect(request.model).toBe("seedream/4.5-edit");
    expect(request.input).toMatchObject({ aspect_ratio: "21:9", quality: "high", image_urls: [IMG, IMG2] });
    expect(request.input).not.toHaveProperty("resolution");
    expect(request.input).not.toHaveProperty("input_urls");
  });

  it("quality goes on the wire verbatim, and neither auto nor a resolution is offered", () => {
    expect(toKieFor(plane(seedream45, { settings: { quality: "high" } }), seedream45).input).toMatchObject({
      quality: "high",
    });
    expect(() => plane(seedream45, { settings: { aspectRatio: "auto" } })).toThrow(/Invalid aspectRatio/);
    expect(seedream45.settings).not.toHaveProperty("resolution");
  });

  it("refuses frames", () => {
    expect(() => toKieFor(plane(seedream45, { media: { start: [IMG] } }), seedream45)).toThrow(
      /takes no start frame/,
    );
    expect(() => toKieFor(plane(seedream45, { media: { end: [IMG] } }), seedream45)).toThrow(
      /needs a start frame with the end frame/,
    );
    expect(() =>
      toKieFor(plane(seedream45, { media: { start: [IMG], reference: [IMG2] } }), seedream45),
    ).toThrow(/either frames or references/);
  });
});

describe("gpt-image-2.5", () => {
  it("text shape sends auto ratio, uppercase resolution and background", () => {
    expect(toKieFor(plane(gptImage25, { prompt: "neon poster" }), gptImage25)).toEqual({
      model: "gpt-image-2-5-flare-text-to-image",
      input: { prompt: "neon poster", aspect_ratio: "auto", resolution: "1K", background: "auto" },
    });
  });

  it("reference shape switches to image-to-image with input_urls", () => {
    const request = toKieFor(
      plane(gptImage25, {
        settings: { aspectRatio: "3:2", resolution: "4k", background: "transparent" },
        media: { reference: [IMG, IMG2] },
      }),
      gptImage25,
    );
    expect(request.model).toBe("gpt-image-2-5-flare-image-to-image");
    expect(request.input).toMatchObject({
      aspect_ratio: "3:2",
      resolution: "4K",
      background: "transparent",
      input_urls: [IMG, IMG2],
    });
    expect(request.input).not.toHaveProperty("image_urls");
  });

  it("uppercases every resolution", () => {
    expect(toKieFor(plane(gptImage25, { settings: { resolution: "2k" } }), gptImage25).input).toMatchObject({
      resolution: "2K",
    });
    expect(toKieFor(plane(gptImage25, { settings: { resolution: "1k" } }), gptImage25).input).toMatchObject({
      resolution: "1K",
    });
  });

  it("leaves out the 1K-only ratios so no 2K/4K pairing can reach the wire", () => {
    const aspect = gptImage25.settings.aspectRatio;
    const offered = aspect?.type === "enum" ? aspect.values : [];
    expect(offered).toContain("21:9");
    for (const ratio of ["27:16", "16:27", "9:8", "8:9"]) {
      expect(offered).not.toContain(ratio);
      expect(() => plane(gptImage25, { settings: { aspectRatio: ratio, resolution: "4k" } })).toThrow(
        /Invalid aspectRatio/,
      );
    }
  });

  it("refuses frames", () => {
    expect(() => toKieFor(plane(gptImage25, { media: { start: [IMG] } }), gptImage25)).toThrow(
      /takes no start frame/,
    );
    expect(() => toKieFor(plane(gptImage25, { media: { end: [IMG] } }), gptImage25)).toThrow(
      /needs a start frame with the end frame/,
    );
    expect(() =>
      toKieFor(plane(gptImage25, { media: { start: [IMG], reference: [IMG2] } }), gptImage25),
    ).toThrow(/either frames or references/);
  });
});

describe("flux-2", () => {
  it("text shape sends the required aspect_ratio and uppercase resolution", () => {
    expect(toKieFor(plane(flux2, { prompt: "blister pack" }), flux2)).toEqual({
      model: "flux-2/pro-text-to-image",
      input: { prompt: "blister pack", aspect_ratio: "1:1", resolution: "1K" },
    });
  });

  it("reference shape switches to image-to-image with input_urls in attach order", () => {
    const request = toKieFor(
      plane(flux2, { settings: { aspectRatio: "16:9", resolution: "2k" }, media: { reference: [IMG, IMG2] } }),
      flux2,
    );
    expect(request.model).toBe("flux-2/pro-image-to-image");
    expect(request.input).toMatchObject({ aspect_ratio: "16:9", resolution: "2K", input_urls: [IMG, IMG2] });
    expect(request.input).not.toHaveProperty("image_urls");
  });

  it("offers neither auto (text-to-image rejects it) nor 4k", () => {
    expect(() => plane(flux2, { settings: { aspectRatio: "auto" } })).toThrow(/Invalid aspectRatio/);
    expect(() => plane(flux2, { settings: { resolution: "4k" } })).toThrow(/Invalid resolution/);
  });

  it("refuses frames", () => {
    expect(() => toKieFor(plane(flux2, { media: { start: [IMG] } }), flux2)).toThrow(/takes no start frame/);
    expect(() => toKieFor(plane(flux2, { media: { end: [IMG] } }), flux2)).toThrow(
      /needs a start frame with the end frame/,
    );
    expect(() => toKieFor(plane(flux2, { media: { start: [IMG], reference: [IMG2] } }), flux2)).toThrow(
      /either frames or references/,
    );
  });
});
