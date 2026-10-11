import { describe, expect, it } from "vitest";

import { crispUpscale, removeBackground } from "@/generation/catalog/recraft";
import { topazUpscale, topazVideoUpscale } from "@/generation/catalog/topaz";
import { PlaneError, toKieFor } from "@/generation/to-kie";

import { IMG, VID, plane } from "../plane";

describe("topaz-upscale", () => {
  it("sends the one image as a string with the default factor and no prompt", () => {
    expect(toKieFor(plane(topazUpscale, { media: { reference: [IMG] } }), topazUpscale)).toEqual({
      model: "topaz/image-upscale",
      input: { image_url: IMG, upscale_factor: "2" },
    });
  });

  it("keeps factor 4 a string on the wire", () => {
    const request = toKieFor(
      plane(topazUpscale, { settings: { upscaleFactor: "4" }, media: { reference: [IMG] } }),
      topazUpscale,
    );
    expect(request.input).toEqual({ image_url: IMG, upscale_factor: "4" });
    expect(request.input.upscale_factor).toBeTypeOf("string");
  });

  it("keeps the studio's synthetic tile text off the wire", () => {
    const request = toKieFor(plane(topazUpscale, { prompt: "Upscale ×2", media: { reference: [IMG] } }), topazUpscale);
    expect(request.input).not.toHaveProperty("prompt");
    expect(request.input).not.toHaveProperty("image_urls");
  });

  it("does not offer factor 1, which is no upscale", () => {
    expect(() => plane(topazUpscale, { settings: { upscaleFactor: "1" } })).toThrow(/Invalid upscaleFactor/);
  });

  it("refuses a plane with nothing attached", () => {
    expect(() => toKieFor(plane(topazUpscale), topazUpscale)).toThrow(PlaneError);
    expect(() => toKieFor(plane(topazUpscale), topazUpscale)).toThrow(/needs an image/);
  });
});

describe("crisp-upscale", () => {
  it("sends the one image under `image` and nothing else", () => {
    expect(toKieFor(plane(crispUpscale, { media: { reference: [IMG] } }), crispUpscale)).toEqual({
      model: "recraft/crisp-upscale",
      input: { image: IMG },
    });
  });

  it("refuses a plane with nothing attached", () => {
    expect(() => toKieFor(plane(crispUpscale), crispUpscale)).toThrow(PlaneError);
    expect(() => toKieFor(plane(crispUpscale), crispUpscale)).toThrow(/Crisp Upscale needs an image/);
  });
});

describe("remove-background", () => {
  it("sends the one image under `image` and nothing else", () => {
    expect(toKieFor(plane(removeBackground, { media: { reference: [IMG] } }), removeBackground)).toEqual({
      model: "recraft/remove-background",
      input: { image: IMG },
    });
  });

  it("refuses a plane with nothing attached", () => {
    expect(() => toKieFor(plane(removeBackground), removeBackground)).toThrow(PlaneError);
    expect(() => toKieFor(plane(removeBackground), removeBackground)).toThrow(/Remove Background needs an image/);
  });
});

describe("topaz-video-upscale", () => {
  it("sends the one clip as a string with the default factor and no prompt", () => {
    expect(toKieFor(plane(topazVideoUpscale, { media: { video: [VID] } }), topazVideoUpscale)).toEqual({
      model: "topaz/video-upscale",
      input: { video_url: VID, upscale_factor: "2" },
    });
  });

  it("keeps factor 4 a string and never writes video_urls", () => {
    const request = toKieFor(
      plane(topazVideoUpscale, { settings: { upscaleFactor: "4" }, media: { video: [VID] } }),
      topazVideoUpscale,
    );
    expect(request.input).toEqual({ video_url: VID, upscale_factor: "4" });
    expect(request.input).not.toHaveProperty("video_urls");
  });

  it("refuses a plane with nothing attached, naming a video", () => {
    expect(() => toKieFor(plane(topazVideoUpscale), topazVideoUpscale)).toThrow(PlaneError);
    expect(() => toKieFor(plane(topazVideoUpscale), topazVideoUpscale)).toThrow(/needs a video/);
  });
});
