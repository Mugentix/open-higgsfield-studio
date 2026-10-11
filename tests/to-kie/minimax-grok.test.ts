import { describe, expect, it } from "vitest";

import { grokImagineVideo15 } from "@/generation/catalog/grok-imagine-video-1.5";
import { minimaxH3 } from "@/generation/catalog/minimax-h3";
import { minimaxHailuo23 } from "@/generation/catalog/minimax-hailuo-2.3";
import { toKieFor } from "@/generation/to-kie";

import { AUD, IMG, IMG2, VID, plane } from "../plane";

describe("minimax-h3", () => {
  it("text shape sends the required ratio, uppercase resolution and an integer duration", () => {
    expect(toKieFor(plane(minimaxH3, { prompt: "a cat on the beach" }), minimaxH3)).toEqual({
      model: "minimax-h3/text-to-video",
      input: { prompt: "a cat on the beach", aspect_ratio: "16:9", resolution: "2K", duration: 6 },
    });
  });

  it("uppercases 768p and keeps the duration a number", () => {
    const request = toKieFor(
      plane(minimaxH3, { settings: { resolution: "768p", duration: 15, aspectRatio: "21:9" } }),
      minimaxH3,
    );
    expect(request.input).toMatchObject({ resolution: "768P", duration: 15, aspect_ratio: "21:9" });
  });

  it("frames shape uses the first/last frame keys and drops the ratio", () => {
    const request = toKieFor(plane(minimaxH3, { media: { start: [IMG], end: [IMG2] } }), minimaxH3);
    expect(request.model).toBe("minimax-h3/image-to-video");
    expect(request.input).toMatchObject({
      first_frame_url: IMG,
      last_frame_url: IMG2,
      resolution: "2K",
      duration: 6,
    });
    expect(request.input).not.toHaveProperty("aspect_ratio");
    expect(request.input).not.toHaveProperty("reference_image_urls");
  });

  it("a start frame alone and an end frame alone both ride image-to-video", () => {
    const startOnly = toKieFor(plane(minimaxH3, { media: { start: [IMG] } }), minimaxH3);
    expect(startOnly.model).toBe("minimax-h3/image-to-video");
    expect(startOnly.input).toMatchObject({ first_frame_url: IMG });
    expect(startOnly.input).not.toHaveProperty("last_frame_url");
    expect(startOnly.input).not.toHaveProperty("aspect_ratio");

    const endOnly = toKieFor(plane(minimaxH3, { media: { end: [IMG2] } }), minimaxH3);
    expect(endOnly.model).toBe("minimax-h3/image-to-video");
    expect(endOnly.input).toMatchObject({ last_frame_url: IMG2 });
    expect(endOnly.input).not.toHaveProperty("first_frame_url");
    expect(endOnly.input).not.toHaveProperty("aspect_ratio");
  });

  it("reference shape uses the reference_* keys and keeps the explicit ratio", () => {
    const request = toKieFor(
      plane(minimaxH3, { media: { reference: [IMG, IMG2], video: [VID], audio: [AUD] } }),
      minimaxH3,
    );
    expect(request.model).toBe("minimax-h3/reference-to-video");
    expect(request.input).toMatchObject({
      reference_image_urls: [IMG, IMG2],
      reference_video_urls: [VID],
      reference_audio_urls: [AUD],
      aspect_ratio: "16:9",
      resolution: "2K",
      duration: 6,
    });
    expect(request.input).not.toHaveProperty("image_urls");
    expect(request.input).not.toHaveProperty("video_urls");
    expect(request.input).not.toHaveProperty("first_frame_url");
  });

  it("audio rides with a video reference alone", () => {
    const request = toKieFor(plane(minimaxH3, { media: { video: [VID], audio: [AUD] } }), minimaxH3);
    expect(request.model).toBe("minimax-h3/reference-to-video");
    expect(request.input).toMatchObject({ reference_video_urls: [VID], reference_audio_urls: [AUD] });
    expect(request.input).not.toHaveProperty("reference_image_urls");
  });

  it("refuses audio as the only reference", () => {
    /* The doc: reference_audio cannot be used alone, it must be accompanied
       by reference_image or reference_video. */
    expect(() => toKieFor(plane(minimaxH3, { media: { audio: [AUD] } }), minimaxH3)).toThrow(
      /image or video reference with the audio/,
    );
  });

  it("refuses frames together with references", () => {
    expect(() => toKieFor(plane(minimaxH3, { media: { start: [IMG], reference: [IMG2] } }), minimaxH3)).toThrow(
      /either frames or references/,
    );
    expect(() => toKieFor(plane(minimaxH3, { media: { start: [IMG], audio: [AUD] } }), minimaxH3)).toThrow(
      /either frames or references/,
    );
  });
});

describe("minimax-hailuo-2.3", () => {
  it("image shape sends image_url, a string duration and uppercase resolution", () => {
    expect(
      toKieFor(plane(minimaxHailuo23, { prompt: "she turns and smiles", media: { start: [IMG] } }), minimaxHailuo23),
    ).toEqual({
      model: "hailuo/2-3-image-to-video-pro",
      input: { prompt: "she turns and smiles", resolution: "768P", duration: "6", image_url: IMG },
    });
  });

  it("offers only the 6 and 10 second rungs", () => {
    expect(minimaxHailuo23.settings.duration).toEqual({ type: "range", min: 6, max: 10, default: 6, step: 4 });
  });

  it("snaps a persisted duration to '6' or '10' as a string, ties rounding up", () => {
    /* The slider steps by 4 and never offers 7–9; a value persisted before
       the step existed still lands on a legal rung. */
    const at = (duration: number) =>
      toKieFor(plane(minimaxHailuo23, { settings: { duration }, media: { start: [IMG] } }), minimaxHailuo23).input
        .duration;
    expect(at(7)).toBe("6");
    expect(at(8)).toBe("10");
    expect(at(9)).toBe("10");
    expect(at(10)).toBe("10");
  });

  it("uppercases 1080p", () => {
    const request = toKieFor(
      plane(minimaxHailuo23, { settings: { resolution: "1080p" }, media: { start: [IMG] } }),
      minimaxHailuo23,
    );
    expect(request.input).toMatchObject({ resolution: "1080P", duration: "6" });
  });

  it("refuses 10 s at 1080P, the pair KIE rejects", () => {
    expect(() =>
      toKieFor(
        plane(minimaxHailuo23, { settings: { resolution: "1080p", duration: 10 }, media: { start: [IMG] } }),
        minimaxHailuo23,
      ),
    ).toThrow(/6 s clips at 1080p/);
    /* A persisted 8 snaps to "10" and meets the same guard. */
    expect(() =>
      toKieFor(
        plane(minimaxHailuo23, { settings: { resolution: "1080p", duration: 8 }, media: { start: [IMG] } }),
        minimaxHailuo23,
      ),
    ).toThrow(/6 s clips at 1080p/);
  });

  it("still sends 10 s at 768P", () => {
    const request = toKieFor(
      plane(minimaxHailuo23, { settings: { resolution: "768p", duration: 10 }, media: { start: [IMG] } }),
      minimaxHailuo23,
    );
    expect(request.input).toMatchObject({ resolution: "768P", duration: "10" });
  });

  it("refuses a bare prompt, an end frame and references", () => {
    expect(() => toKieFor(plane(minimaxHailuo23), minimaxHailuo23)).toThrow(/needs a start frame/);
    expect(() =>
      toKieFor(plane(minimaxHailuo23, { media: { start: [IMG], end: [IMG2] } }), minimaxHailuo23),
    ).toThrow(/no end frame/);
    expect(() => toKieFor(plane(minimaxHailuo23, { media: { end: [IMG] } }), minimaxHailuo23)).toThrow(
      /start frame/,
    );
    expect(() => toKieFor(plane(minimaxHailuo23, { media: { reference: [IMG] } }), minimaxHailuo23)).toThrow(
      /no references/,
    );
  });
});

describe("grok-imagine-video-1.5", () => {
  it("text shape sends exactly prompt, ratio, resolution and duration", () => {
    expect(toKieFor(plane(grokImagineVideo15, { prompt: "a neon market" }), grokImagineVideo15)).toEqual({
      model: "grok-imagine-video-1-5-preview",
      input: { prompt: "a neon market", aspect_ratio: "auto", resolution: "720p", duration: 8 },
    });
  });

  it("reference shape carries image_urls on the same model and nothing more", () => {
    /* The input schema is closed (additionalProperties: false), so the whole
       body is pinned rather than matched. */
    const request = toKieFor(
      plane(grokImagineVideo15, {
        settings: { aspectRatio: "3:2", resolution: "720p", duration: 15 },
        media: { reference: [IMG, IMG2] },
      }),
      grokImagineVideo15,
    );
    expect(request).toEqual({
      model: "grok-imagine-video-1-5-preview",
      input: { prompt: "a prompt", aspect_ratio: "3:2", resolution: "720p", duration: 15, image_urls: [IMG, IMG2] },
    });
  });

  it("takes a single image at 1080p", () => {
    const request = toKieFor(
      plane(grokImagineVideo15, { settings: { resolution: "1080p" }, media: { reference: [IMG] } }),
      grokImagineVideo15,
    );
    expect(request.input).toMatchObject({ resolution: "1080p", image_urls: [IMG] });
  });

  it("refuses more than one image at 1080p", () => {
    expect(() =>
      toKieFor(
        plane(grokImagineVideo15, { settings: { resolution: "1080p" }, media: { reference: [IMG, IMG2] } }),
        grokImagineVideo15,
      ),
    ).toThrow(/one reference at 1080p/);
  });

  it("accepts a one-second clip and the lowest rung", () => {
    const request = toKieFor(
      plane(grokImagineVideo15, { settings: { duration: 1, resolution: "480p", aspectRatio: "9:16" } }),
      grokImagineVideo15,
    );
    expect(request.input).toMatchObject({ duration: 1, resolution: "480p", aspect_ratio: "9:16" });
  });

  it("refuses a start frame", () => {
    expect(() => toKieFor(plane(grokImagineVideo15, { media: { start: [IMG] } }), grokImagineVideo15)).toThrow(
      /no start frame/,
    );
  });
});
