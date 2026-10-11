import { describe, expect, it } from "vitest";

import { wan26 } from "@/generation/catalog/wan-2.6";
import { wan27 } from "@/generation/catalog/wan-2.7";
import { wan3, wan3Prime } from "@/generation/catalog/wan-3";
import { toKieFor } from "@/generation/to-kie";

import { AUD, IMG, IMG2, VID, plane } from "../plane";

describe("wan 2.7", () => {
  it("text shape sends the aspect as `ratio` and prompt_extend", () => {
    expect(toKieFor(plane(wan27, { prompt: "a neon street" }), wan27)).toEqual({
      model: "wan/2-7-text-to-video",
      input: {
        prompt: "a neon street",
        ratio: "16:9",
        resolution: "720p",
        duration: 5,
        prompt_extend: true,
      },
    });
  });

  it("text shape passes every setting through unchanged", () => {
    expect(
      toKieFor(
        plane(wan27, {
          settings: { aspectRatio: "3:4", resolution: "1080p", duration: 15, promptExtend: false },
        }),
        wan27,
      ),
    ).toEqual({
      model: "wan/2-7-text-to-video",
      input: { prompt: "a prompt", ratio: "3:4", resolution: "1080p", duration: 15, prompt_extend: false },
    });
  });

  it("image shape sends first_frame_url on image-to-video and drops the aspect", () => {
    const request = toKieFor(plane(wan27, { settings: { aspectRatio: "9:16" }, media: { start: [IMG] } }), wan27);
    expect(request.model).toBe("wan/2-7-image-to-video");
    expect(request.input).toMatchObject({
      prompt: "a prompt",
      first_frame_url: IMG,
      resolution: "720p",
      duration: 5,
      prompt_extend: true,
    });
    expect(request.input).not.toHaveProperty("ratio");
    expect(request.input).not.toHaveProperty("aspect_ratio");
    expect(request.input).not.toHaveProperty("image_url");
    expect(request.input).not.toHaveProperty("last_frame_url");
  });

  it("firstLast shape sends both frames on the same model", () => {
    const request = toKieFor(plane(wan27, { media: { start: [IMG], end: [IMG2] } }), wan27);
    expect(request.model).toBe("wan/2-7-image-to-video");
    expect(request.input).toMatchObject({ first_frame_url: IMG, last_frame_url: IMG2, duration: 5 });
    expect(request.input).not.toHaveProperty("ratio");
    expect(request.input).not.toHaveProperty("aspect_ratio");
  });

  it("refuses an end frame alone", () => {
    expect(() => toKieFor(plane(wan27, { media: { end: [IMG] } }), wan27)).toThrow(/start frame/);
  });

  it("refuses references", () => {
    expect(() => toKieFor(plane(wan27, { media: { reference: [IMG] } }), wan27)).toThrow(/no references/);
    expect(() => toKieFor(plane(wan27, { media: { start: [IMG], reference: [IMG2] } }), wan27)).toThrow(
      /either frames or references/,
    );
  });
});

describe("wan 2.6", () => {
  it("text shape sends a string duration and multi_shots, no aspect", () => {
    expect(toKieFor(plane(wan26, { prompt: "a knitted burger" }), wan26)).toEqual({
      model: "wan/2-6-text-to-video",
      input: { prompt: "a knitted burger", resolution: "720p", duration: "5", multi_shots: false },
    });
  });

  it("image shape wraps the start frame in image_urls", () => {
    const request = toKieFor(
      plane(wan26, { settings: { resolution: "1080p", multiShots: true }, media: { start: [IMG] } }),
      wan26,
    );
    expect(request.model).toBe("wan/2-6-image-to-video");
    expect(request.input).toMatchObject({
      prompt: "a prompt",
      image_urls: [IMG],
      resolution: "1080p",
      duration: "5",
      multi_shots: true,
    });
    expect(request.input).not.toHaveProperty("image_url");
    expect(request.input).not.toHaveProperty("aspect_ratio");
  });

  it("snaps the duration to 5, 10 or 15 and stringifies it", () => {
    const duration = (value: number) =>
      toKieFor(plane(wan26, { settings: { duration: value } }), wan26).input.duration;
    expect(duration(7)).toBe("5");
    expect(duration(8)).toBe("10");
    expect(duration(12)).toBe("10");
    expect(duration(13)).toBe("15");
    expect(duration(15)).toBe("15");
  });

  it("refuses an end frame and references", () => {
    expect(() => toKieFor(plane(wan26, { media: { start: [IMG], end: [IMG2] } }), wan26)).toThrow(/no end frame/);
    expect(() => toKieFor(plane(wan26, { media: { end: [IMG] } }), wan26)).toThrow(/start frame/);
    expect(() => toKieFor(plane(wan26, { media: { reference: [IMG] } }), wan26)).toThrow(/no references/);
  });
});

describe("wan 3.0", () => {
  it("text shape sends an uppercase resolution and the audio flag", () => {
    expect(toKieFor(plane(wan3, { prompt: "a cat on a roof" }), wan3)).toEqual({
      model: "wan/3-0-video",
      input: { prompt: "a cat on a roof", aspect_ratio: "16:9", resolution: "720P", duration: 5, audio: true },
    });
  });

  it("uppercases every resolution and passes adaptive and the long durations through", () => {
    expect(
      toKieFor(
        plane(wan3, { settings: { resolution: "480p", aspectRatio: "adaptive", duration: 30, audio: false } }),
        wan3,
      ),
    ).toEqual({
      model: "wan/3-0-video",
      input: { prompt: "a prompt", aspect_ratio: "adaptive", resolution: "480P", duration: 30, audio: false },
    });
    expect(toKieFor(plane(wan3, { settings: { resolution: "1080p" } }), wan3).input.resolution).toBe("1080P");
  });

  it("frames shape uses first/last frame keys and lets the frame set the ratio", () => {
    const request = toKieFor(plane(wan3, { media: { start: [IMG], end: [IMG2] } }), wan3);
    expect(request).toEqual({
      model: "wan/3-0-video",
      input: {
        prompt: "a prompt",
        aspect_ratio: "adaptive",
        resolution: "720P",
        duration: 5,
        audio: true,
        first_frame_url: IMG,
        last_frame_url: IMG2,
      },
    });
  });

  it("caps the duration at 15 s when reference videos are attached", () => {
    expect(() =>
      toKieFor(plane(wan3, { settings: { duration: 20 }, media: { video: [VID] } }), wan3),
    ).toThrow(/at most 15 s/);
    expect(toKieFor(plane(wan3, { settings: { duration: 15 }, media: { video: [VID] } }), wan3).input).toMatchObject({
      duration: 15,
      reference_video_urls: [VID],
    });
  });

  it("a start frame alone sends no last_frame_url", () => {
    const request = toKieFor(plane(wan3, { media: { start: [IMG] } }), wan3);
    expect(request.input).toMatchObject({ first_frame_url: IMG });
    expect(request.input).not.toHaveProperty("last_frame_url");
  });

  it("reference shape uses the reference_* keys", () => {
    const request = toKieFor(
      plane(wan3, { media: { reference: [IMG, IMG2], video: [VID], audio: [AUD] } }),
      wan3,
    );
    expect(request.model).toBe("wan/3-0-video");
    expect(request.input).toMatchObject({
      reference_image_urls: [IMG, IMG2],
      reference_video_urls: [VID],
      reference_audio_urls: [AUD],
      resolution: "720P",
    });
    expect(request.input).not.toHaveProperty("first_frame_url");
    expect(request.input).not.toHaveProperty("last_frame_url");
    expect(request.input).not.toHaveProperty("image_urls");
  });

  it("sends only the reference lists that are attached", () => {
    const request = toKieFor(plane(wan3, { media: { video: [VID] } }), wan3);
    expect(request.input).toMatchObject({ reference_video_urls: [VID] });
    expect(request.input).not.toHaveProperty("reference_image_urls");
    expect(request.input).not.toHaveProperty("reference_audio_urls");
  });

  it("refuses frames together with references, and an end frame alone", () => {
    expect(() => toKieFor(plane(wan3, { media: { start: [IMG], reference: [IMG2] } }), wan3)).toThrow(
      /either frames or references/,
    );
    expect(() => toKieFor(plane(wan3, { media: { start: [IMG], audio: [AUD] } }), wan3)).toThrow(
      /either frames or references/,
    );
    expect(() => toKieFor(plane(wan3, { media: { end: [IMG] } }), wan3)).toThrow(/start frame/);
  });

  it("prime sends the same wire to wan/3-0-video-prime", () => {
    expect(toKieFor(plane(wan3Prime, { prompt: "a cat on a roof" }), wan3Prime)).toEqual({
      model: "wan/3-0-video-prime",
      input: { prompt: "a cat on a roof", aspect_ratio: "16:9", resolution: "720P", duration: 5, audio: true },
    });
    const request = toKieFor(plane(wan3Prime, { media: { reference: [IMG] } }), wan3Prime);
    expect(request.model).toBe("wan/3-0-video-prime");
    expect(request.input).toMatchObject({ reference_image_urls: [IMG] });
    expect(() => toKieFor(plane(wan3Prime, { media: { end: [IMG] } }), wan3Prime)).toThrow(/start frame/);
  });
});
