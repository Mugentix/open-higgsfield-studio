import { describe, expect, it } from "vitest";

import { happyHorse1 } from "@/generation/catalog/happy-horse-1";
import { happyHorse11 } from "@/generation/catalog/happy-horse-1.1";
import { pixverse6 } from "@/generation/catalog/pixverse-6";
import { veo31 } from "@/generation/catalog/veo-3.1";
import { toKieFor } from "@/generation/to-kie";

import { IMG, IMG2, plane } from "../plane";

describe("pixverse-6", () => {
  it("text shape sends the aspect ratio, quality and the audio switch", () => {
    expect(toKieFor(plane(pixverse6, { prompt: "a fox crossing fresh snow" }), pixverse6)).toEqual({
      model: "pixverse-v6/text-to-video",
      input: {
        prompt: "a fox crossing fresh snow",
        aspect_ratio: "16:9",
        quality: "720p",
        duration: 5,
        generate_audio_switch: false,
      },
    });
  });

  it("image shape wraps the start frame in image_urls and drops the aspect ratio", () => {
    const request = toKieFor(
      plane(pixverse6, { settings: { resolution: "1080p", generateAudio: true }, media: { start: [IMG] } }),
      pixverse6,
    );
    expect(request.model).toBe("pixverse-v6/image-to-video");
    expect(request.input).toMatchObject({ image_urls: [IMG], quality: "1080p", generate_audio_switch: true });
    expect(request.input).not.toHaveProperty("aspect_ratio");
    expect(request.input).not.toHaveProperty("image_url");
    expect(request.input).not.toHaveProperty("resolution");
  });

  it("transition names both frames and drops the aspect ratio", () => {
    const request = toKieFor(plane(pixverse6, { media: { start: [IMG], end: [IMG2] } }), pixverse6);
    expect(request.model).toBe("pixverse-v6/transition");
    expect(request.input).toMatchObject({ first_frame_image_url: IMG, last_frame_image_url: IMG2, quality: "720p" });
    expect(request.input).not.toHaveProperty("aspect_ratio");
    expect(request.input).not.toHaveProperty("image_urls");
    expect(request.input).not.toHaveProperty("first_frame_url");
  });

  it("reference shape wraps each url as a named subject", () => {
    const request = toKieFor(
      plane(pixverse6, { settings: { aspectRatio: "9:16", duration: 15 }, media: { reference: [IMG, IMG2] } }),
      pixverse6,
    );
    expect(request.model).toBe("pixverse-v6/reference-to-video");
    expect(request.input).toMatchObject({
      aspect_ratio: "9:16",
      duration: 15,
      image_references: [
        { image_url: IMG, type: "subject", ref_name: "ref1" },
        { image_url: IMG2, type: "subject", ref_name: "ref2" },
      ],
    });
    expect(request.input).not.toHaveProperty("image_urls");
  });

  it("refuses an end frame alone, and frames together with references", () => {
    expect(() => toKieFor(plane(pixverse6, { media: { end: [IMG] } }), pixverse6)).toThrow(/start frame/);
    expect(() => toKieFor(plane(pixverse6, { media: { start: [IMG], reference: [IMG2] } }), pixverse6)).toThrow(
      /either frames or references/,
    );
  });
});

describe("happy-horse-1", () => {
  it("text shape sends lowercase resolution and no seed", () => {
    expect(toKieFor(plane(happyHorse1, { prompt: "a cardboard train at night" }), happyHorse1)).toEqual({
      model: "happyhorse/text-to-video",
      input: { prompt: "a cardboard train at night", aspect_ratio: "16:9", resolution: "1080p", duration: 5 },
    });
  });

  it("image shape sends the clean image_urls key and drops the aspect ratio", () => {
    const request = toKieFor(
      plane(happyHorse1, { settings: { resolution: "720p", duration: 3 }, media: { start: [IMG] } }),
      happyHorse1,
    );
    expect(request.model).toBe("happyhorse/image-to-video");
    expect(request.input).toMatchObject({ image_urls: [IMG], resolution: "720p", duration: 3 });
    expect(request.input).not.toHaveProperty("aspect_ratio");
    expect(request.input).not.toHaveProperty("image_url");
    expect(request.input).not.toHaveProperty("image_urls ");
  });

  it("reference shape lists the images under reference_image", () => {
    const request = toKieFor(
      plane(happyHorse1, { settings: { aspectRatio: "3:4" }, media: { reference: [IMG, IMG2] } }),
      happyHorse1,
    );
    expect(request.model).toBe("happyhorse/reference-to-video");
    expect(request.input).toMatchObject({ reference_image: [IMG, IMG2], aspect_ratio: "3:4" });
    expect(request.input).not.toHaveProperty("image_urls");
  });

  it("refuses an end frame, and frames together with references", () => {
    expect(() => toKieFor(plane(happyHorse1, { media: { start: [IMG], end: [IMG2] } }), happyHorse1)).toThrow(
      /no end frame/,
    );
    expect(() => toKieFor(plane(happyHorse1, { media: { start: [IMG], reference: [IMG2] } }), happyHorse1)).toThrow(
      /either frames or references/,
    );
  });
});

describe("happy-horse-1.1", () => {
  it("text shape sends only the documented keys, with the wide ratios", () => {
    expect(
      toKieFor(
        plane(happyHorse11, { prompt: "a market in the rain", settings: { aspectRatio: "9:21", duration: 15 } }),
        happyHorse11,
      ),
    ).toEqual({
      model: "happyhorse-1-1/text-to-video",
      input: { prompt: "a market in the rain", aspect_ratio: "9:21", resolution: "1080p", duration: 15 },
    });
  });

  it("image shape is exactly prompt, resolution, duration and image_urls", () => {
    const request = toKieFor(
      plane(happyHorse11, { settings: { resolution: "720p" }, media: { start: [IMG] } }),
      happyHorse11,
    );
    expect(request).toEqual({
      model: "happyhorse-1-1/image-to-video",
      input: { prompt: "a prompt", resolution: "720p", duration: 5, image_urls: [IMG] },
    });
    expect(request.input).not.toHaveProperty("aspect_ratio");
  });

  it("reference shape lists the images under reference_image", () => {
    const request = toKieFor(
      plane(happyHorse11, { settings: { aspectRatio: "4:5" }, media: { reference: [IMG, IMG2] } }),
      happyHorse11,
    );
    expect(request.model).toBe("happyhorse-1-1/reference-to-video");
    expect(request.input).toMatchObject({ reference_image: [IMG, IMG2], aspect_ratio: "4:5" });
    expect(request.input).not.toHaveProperty("image_urls");
    expect(request.input).not.toHaveProperty("seed");
  });

  it("refuses an end frame, and frames together with references", () => {
    expect(() => toKieFor(plane(happyHorse11, { media: { start: [IMG], end: [IMG2] } }), happyHorse11)).toThrow(
      /no end frame/,
    );
    expect(() => toKieFor(plane(happyHorse11, { media: { start: [IMG], reference: [IMG2] } }), happyHorse11)).toThrow(
      /either frames or references/,
    );
  });
});

describe("veo-3.1", () => {
  it("stays off the picker until a live probe proves the route", () => {
    expect(veo31.kie.enabled).toBe(false);
  });

  it("text shape flags TEXT_2_VIDEO and sends no image_urls", () => {
    expect(toKieFor(plane(veo31, { prompt: "a dog playing in a park" }), veo31)).toEqual({
      model: "veo-3-1",
      input: {
        prompt: "a dog playing in a park",
        aspect_ratio: "16:9",
        resolution: "720p",
        duration: 8,
        generation_type: "TEXT_2_VIDEO",
      },
    });
  });

  it("start frame alone rides FIRST_AND_LAST_FRAMES_2_VIDEO as a one-item list", () => {
    const request = toKieFor(plane(veo31, { media: { start: [IMG] } }), veo31);
    expect(request.model).toBe("veo-3-1");
    expect(request.input).toMatchObject({ generation_type: "FIRST_AND_LAST_FRAMES_2_VIDEO", image_urls: [IMG] });
    expect(request.input).not.toHaveProperty("image_url");
    expect(request.input).not.toHaveProperty("first_frame_url");
  });

  it("start and end frames are positional in image_urls", () => {
    const request = toKieFor(plane(veo31, { media: { start: [IMG], end: [IMG2] } }), veo31);
    expect(request.input).toMatchObject({ generation_type: "FIRST_AND_LAST_FRAMES_2_VIDEO", image_urls: [IMG, IMG2] });
    expect(request.input).not.toHaveProperty("last_frame_url");
  });

  it("references ride REFERENCE_2_VIDEO and pin the duration to 8", () => {
    const request = toKieFor(plane(veo31, { settings: { duration: 4 }, media: { reference: [IMG, IMG2] } }), veo31);
    expect(request.input).toMatchObject({ generation_type: "REFERENCE_2_VIDEO", image_urls: [IMG, IMG2], duration: 8 });
    expect(request.input).not.toHaveProperty("reference_image");
  });

  it("snaps the duration to 4, 6 or 8, capitalises Auto and keeps 4k lowercase", () => {
    const durationAt = (duration: number) => toKieFor(plane(veo31, { settings: { duration } }), veo31).input.duration;
    expect(durationAt(4)).toBe(4);
    expect(durationAt(5)).toBe(6);
    expect(durationAt(6)).toBe(6);
    expect(durationAt(7)).toBe(8);
    expect(toKieFor(plane(veo31, { settings: { aspectRatio: "auto", resolution: "4k" } }), veo31).input).toMatchObject({
      aspect_ratio: "Auto",
      resolution: "4k",
    });
  });

  it("refuses an end frame alone, and frames together with references", () => {
    expect(() => toKieFor(plane(veo31, { media: { end: [IMG] } }), veo31)).toThrow(/start frame/);
    expect(() => toKieFor(plane(veo31, { media: { start: [IMG], reference: [IMG2] } }), veo31)).toThrow(
      /either frames or references/,
    );
  });
});
