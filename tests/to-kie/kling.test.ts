import { describe, expect, it } from "vitest";

import { kling25 } from "@/generation/catalog/kling-2.5";
import { kling26 } from "@/generation/catalog/kling-2.6";
import { kling34k, kling3Pro, kling3Std } from "@/generation/catalog/kling-3";
import { kling3MotionPro, kling3MotionStd } from "@/generation/catalog/kling-3-motion";
import { kling3Omni } from "@/generation/catalog/kling-3-omni";
import { kling3Turbo } from "@/generation/catalog/kling-3-turbo";
import { toKieFor } from "@/generation/to-kie";

import { IMG, IMG2, VID, plane } from "../plane";

const IMG3 = "https://files.example.com/ref3.png";
const IMG4 = "https://files.example.com/ref4.png";
const IMG5 = "https://files.example.com/ref5.png";

describe("kling-3-turbo", () => {
  it("text shape sends a string duration and the aspect ratio", () => {
    expect(toKieFor(plane(kling3Turbo, { prompt: "a fox in snow" }), kling3Turbo)).toEqual({
      model: "kling/v3-turbo-text-to-video",
      input: { prompt: "a fox in snow", aspect_ratio: "16:9", resolution: "720p", duration: "5" },
    });
  });

  it("image shape wraps the frame in image_urls and drops the aspect ratio", () => {
    const request = toKieFor(
      plane(kling3Turbo, { settings: { duration: 12, resolution: "1080p" }, media: { start: [IMG] } }),
      kling3Turbo,
    );
    expect(request.model).toBe("kling/v3-turbo-image-to-video");
    expect(request.input).toMatchObject({ image_urls: [IMG], duration: "12", resolution: "1080p" });
    expect(request.input).not.toHaveProperty("aspect_ratio");
    expect(request.input).not.toHaveProperty("image_url");
  });

  it("refuses an end frame and references", () => {
    expect(() => toKieFor(plane(kling3Turbo, { media: { start: [IMG], end: [IMG2] } }), kling3Turbo)).toThrow(
      /no end frame/,
    );
    expect(() => toKieFor(plane(kling3Turbo, { media: { reference: [IMG] } }), kling3Turbo)).toThrow(
      /no references/,
    );
  });
});

describe("kling-3 std / pro / 4k", () => {
  it("text shape sends the tier as mode, single-shot, no cfg_scale", () => {
    expect(toKieFor(plane(kling3Std, { prompt: "a market at dawn" }), kling3Std)).toEqual({
      model: "kling-3.0/video",
      input: {
        prompt: "a market at dawn",
        aspect_ratio: "16:9",
        duration: "5",
        sound: true,
        mode: "std",
        multi_shots: false,
      },
    });
  });

  it("start frame goes as a one-item image_urls without aspect_ratio", () => {
    const request = toKieFor(
      plane(kling3Pro, { settings: { duration: 9, sound: false }, media: { start: [IMG] } }),
      kling3Pro,
    );
    expect(request.model).toBe("kling-3.0/video");
    expect(request.input).toMatchObject({ mode: "pro", image_urls: [IMG], duration: "9", sound: false });
    expect(request.input).not.toHaveProperty("aspect_ratio");
    expect(request.input).not.toHaveProperty("first_frame_url");
    expect(request.input).not.toHaveProperty("cfg_scale");
    expect(request.input).not.toHaveProperty("multi_prompt");
  });

  it("first and last frames are positional, and 4K is the uppercase mode", () => {
    const request = toKieFor(plane(kling34k, { media: { start: [IMG], end: [IMG2] } }), kling34k);
    expect(request.model).toBe("kling-3.0/video");
    expect(request.input).toMatchObject({ mode: "4K", image_urls: [IMG, IMG2], multi_shots: false });
    expect(request.input).not.toHaveProperty("aspect_ratio");
    expect(request.input).not.toHaveProperty("last_frame_url");
  });

  it("refuses an end frame alone and references", () => {
    expect(() => toKieFor(plane(kling3Std, { media: { end: [IMG] } }), kling3Std)).toThrow(/start frame/);
    expect(() => toKieFor(plane(kling3Std, { media: { reference: [IMG] } }), kling3Std)).toThrow(
      /no references/,
    );
    expect(() => toKieFor(plane(kling3Std, { media: { start: [IMG], reference: [IMG2] } }), kling3Std)).toThrow(
      /either frames or references/,
    );
  });
});

describe("kling-3-motion", () => {
  it("sends the character image and the driving clip as one-item arrays", () => {
    expect(
      toKieFor(plane(kling3MotionStd, { prompt: "dancing", media: { start: [IMG], video: [VID] } }), kling3MotionStd),
    ).toEqual({
      model: "kling-3.0/motion-control",
      input: {
        prompt: "dancing",
        character_orientation: "video",
        background_source: "input_video",
        mode: "std",
        input_urls: [IMG],
        video_urls: [VID],
      },
    });
  });

  it("pro tier carries its own mode and the orientation and background settings", () => {
    const request = toKieFor(
      plane(kling3MotionPro, {
        settings: { characterOrientation: "image", backgroundSource: "input_image" },
        media: { start: [IMG], video: [VID] },
      }),
      kling3MotionPro,
    );
    expect(request.model).toBe("kling-3.0/motion-control");
    expect(request.input).toMatchObject({
      mode: "pro",
      character_orientation: "image",
      background_source: "input_image",
    });
    expect(request.input).not.toHaveProperty("keep_original_sound");
    expect(request.input).not.toHaveProperty("image_url");
    expect(request.input).not.toHaveProperty("video_url");
  });

  it("refuses a missing image or a missing video", () => {
    expect(() => toKieFor(plane(kling3MotionStd, { media: { video: [VID] } }), kling3MotionStd)).toThrow(
      /start frame/,
    );
    expect(() => toKieFor(plane(kling3MotionStd, { media: { start: [IMG] } }), kling3MotionStd)).toThrow(
      /video/,
    );
    expect(() => toKieFor(plane(kling3MotionStd), kling3MotionStd)).toThrow(/start frame/);
  });
});

describe("kling-3-omni", () => {
  it("text shape sends an integer duration and single-shot", () => {
    expect(toKieFor(plane(kling3Omni, { prompt: "a fox at sunrise" }), kling3Omni)).toEqual({
      model: "kling-3.0-omni/text-to-video",
      input: {
        prompt: "a fox at sunrise",
        aspect_ratio: "16:9",
        resolution: "720p",
        duration: 5,
        audio: false,
        customize_multi_shots: false,
      },
    });
  });

  it("start frame goes to image-to-video with aspect_ratio auto", () => {
    const request = toKieFor(
      plane(kling3Omni, { settings: { aspectRatio: "9:16", resolution: "4k", duration: 10 }, media: { start: [IMG] } }),
      kling3Omni,
    );
    expect(request.model).toBe("kling-3.0-omni/image-to-video");
    expect(request.input).toMatchObject({
      image_urls: [IMG],
      aspect_ratio: "auto",
      resolution: "4k",
      duration: 10,
      customize_multi_shots: false,
    });
    expect(request.input).not.toHaveProperty("first_frame_url");
  });

  it("first and last frames are positional", () => {
    const request = toKieFor(plane(kling3Omni, { media: { start: [IMG], end: [IMG2] } }), kling3Omni);
    expect(request.model).toBe("kling-3.0-omni/image-to-video");
    expect(request.input).toMatchObject({ image_urls: [IMG, IMG2], aspect_ratio: "auto" });
    expect(request.input).not.toHaveProperty("last_frame_url");
  });

  it("reference images alone keep the aspect ratio and audio", () => {
    const request = toKieFor(
      plane(kling3Omni, { settings: { aspectRatio: "1:1", audio: true }, media: { reference: [IMG, IMG2] } }),
      kling3Omni,
    );
    expect(request.model).toBe("kling-3.0-omni/reference-to-video");
    expect(request.input).toMatchObject({ image_urls: [IMG, IMG2], aspect_ratio: "1:1", audio: true, duration: 5 });
    expect(request.input).not.toHaveProperty("video_urls");
  });

  it("a video alone forces aspect_ratio auto and audio off and drops the duration", () => {
    expect(
      toKieFor(plane(kling3Omni, { settings: { audio: true, duration: 8 }, media: { video: [VID] } }), kling3Omni),
    ).toEqual({
      model: "kling-3.0-omni/reference-to-video",
      input: {
        prompt: "a prompt",
        aspect_ratio: "auto",
        resolution: "720p",
        audio: false,
        customize_multi_shots: false,
        video_urls: [VID],
      },
    });
  });

  it("a video with images keeps the aspect ratio and duration, audio off", () => {
    const request = toKieFor(
      plane(kling3Omni, { settings: { audio: true, duration: 7 }, media: { reference: [IMG], video: [VID] } }),
      kling3Omni,
    );
    expect(request.model).toBe("kling-3.0-omni/reference-to-video");
    expect(request.input).toMatchObject({
      image_urls: [IMG],
      video_urls: [VID],
      aspect_ratio: "16:9",
      duration: 7,
      audio: false,
    });
  });

  it("refuses more than four images with a video, an end frame alone, and frames with references", () => {
    expect(() =>
      toKieFor(plane(kling3Omni, { media: { reference: [IMG, IMG2, IMG3, IMG4, IMG5], video: [VID] } }), kling3Omni),
    ).toThrow(/at most 4 reference images/);
    expect(() => toKieFor(plane(kling3Omni, { media: { end: [IMG] } }), kling3Omni)).toThrow(/start frame/);
    expect(() => toKieFor(plane(kling3Omni, { media: { start: [IMG], reference: [IMG2] } }), kling3Omni)).toThrow(
      /either frames or references/,
    );
  });
});

describe("kling-2.6", () => {
  it("text shape sends all four fields with a string duration", () => {
    expect(toKieFor(plane(kling26, { prompt: "a host on a live stream" }), kling26)).toEqual({
      model: "kling-2.6/text-to-video",
      input: { prompt: "a host on a live stream", aspect_ratio: "16:9", duration: "5", sound: true },
    });
  });

  it("image shape wraps the frame in image_urls and drops the aspect ratio", () => {
    const request = toKieFor(
      plane(kling26, { settings: { duration: 10, sound: false }, media: { start: [IMG] } }),
      kling26,
    );
    expect(request.model).toBe("kling-2.6/image-to-video");
    expect(request.input).toMatchObject({ image_urls: [IMG], duration: "10", sound: false });
    expect(request.input).not.toHaveProperty("aspect_ratio");
    expect(request.input).not.toHaveProperty("resolution");
    expect(request.input).not.toHaveProperty("image_url");
  });

  it("offers only the 5 and 10 second rungs", () => {
    expect(kling26.settings.duration).toEqual({ type: "range", min: 5, max: 10, default: 5, step: 5 });
  });

  it("snaps a persisted duration to '5' or '10' as a string", () => {
    /* The slider steps by 5 and never offers 6–9; a value persisted before
       the step existed still lands on a legal rung. */
    const at = (duration: number) => toKieFor(plane(kling26, { settings: { duration } }), kling26).input.duration;
    expect(at(5)).toBe("5");
    expect(at(7)).toBe("5");
    expect(at(8)).toBe("10");
    expect(at(10)).toBe("10");
  });

  it("refuses an end frame", () => {
    expect(() => toKieFor(plane(kling26, { media: { start: [IMG], end: [IMG2] } }), kling26)).toThrow(
      /no end frame/,
    );
  });
});

describe("kling-2.5", () => {
  it("text shape sends a string duration and cfg_scale", () => {
    expect(toKieFor(plane(kling25, { prompt: "a ruined city" }), kling25)).toEqual({
      model: "kling/v2-5-turbo-text-to-video-pro",
      input: { prompt: "a ruined city", aspect_ratio: "16:9", duration: "5", cfg_scale: 0.5 },
    });
  });

  it("image shape sends a scalar image_url and drops the aspect ratio", () => {
    const request = toKieFor(
      plane(kling25, { settings: { cfgScale: 0.3, duration: 10 }, media: { start: [IMG] } }),
      kling25,
    );
    expect(request.model).toBe("kling/v2-5-turbo-image-to-video-pro");
    expect(request.input).toMatchObject({ image_url: IMG, duration: "10", cfg_scale: 0.3 });
    expect(request.input).not.toHaveProperty("aspect_ratio");
    expect(request.input).not.toHaveProperty("image_urls");
    expect(request.input).not.toHaveProperty("tail_image_url");
    expect(request.input).not.toHaveProperty("negative_prompt");
  });

  it("an end frame rides the image model as tail_image_url", () => {
    const request = toKieFor(plane(kling25, { media: { start: [IMG], end: [IMG2] } }), kling25);
    expect(request.model).toBe("kling/v2-5-turbo-image-to-video-pro");
    expect(request.input).toMatchObject({ image_url: IMG, tail_image_url: IMG2 });
    expect(request.input).not.toHaveProperty("aspect_ratio");
  });

  it("offers only the 5 and 10 second rungs", () => {
    expect(kling25.settings.duration).toEqual({ type: "range", min: 5, max: 10, default: 5, step: 5 });
  });

  it("snaps a persisted duration to '5' or '10' as a string", () => {
    /* The slider steps by 5 and never offers 6–9; a value persisted before
       the step existed still lands on a legal rung. */
    const at = (duration: number) =>
      toKieFor(plane(kling25, { settings: { duration }, media: { start: [IMG] } }), kling25).input.duration;
    expect(at(5)).toBe("5");
    expect(at(7)).toBe("5");
    expect(at(8)).toBe("10");
    expect(at(10)).toBe("10");
  });

  it("refuses an end frame alone", () => {
    expect(() => toKieFor(plane(kling25, { media: { end: [IMG] } }), kling25)).toThrow(/start frame/);
  });
});
