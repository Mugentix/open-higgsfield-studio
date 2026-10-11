import { describe, expect, it } from "vitest";

import { seedance2, seedance2Fast } from "@/generation/catalog/seedance-2";
import { seedance25, seedance25Edit } from "@/generation/catalog/seedance-2.5";
import { toKieFor } from "@/generation/to-kie";

import { AUD, IMG, IMG2, VID, plane } from "../plane";

describe("seedance 2.x", () => {
  it("text shape", () => {
    expect(toKieFor(plane(seedance2Fast, { prompt: "a beach at sunset" }), seedance2Fast)).toEqual({
      model: "bytedance/seedance-2-fast",
      input: {
        prompt: "a beach at sunset",
        aspect_ratio: "16:9",
        duration: 5,
        generate_audio: true,
        resolution: "720p",
      },
    });
  });

  it("frames shape uses first/last frame keys", () => {
    const request = toKieFor(plane(seedance2, { media: { start: [IMG], end: [IMG2] } }), seedance2);
    expect(request.model).toBe("bytedance/seedance-2");
    expect(request.input).toMatchObject({ first_frame_url: IMG, last_frame_url: IMG2 });
    expect(request.input).not.toHaveProperty("reference_image_urls");
  });

  it("reference shape uses the reference_* keys", () => {
    const request = toKieFor(
      plane(seedance2Fast, { media: { reference: [IMG], video: [VID], audio: [AUD] } }),
      seedance2Fast,
    );
    expect(request.input).toMatchObject({
      reference_image_urls: [IMG],
      reference_video_urls: [VID],
      reference_audio_urls: [AUD],
    });
    expect(request.input).not.toHaveProperty("first_frame_url");
  });

  it("refuses frames together with references, and an end frame alone", () => {
    expect(() => toKieFor(plane(seedance2, { media: { start: [IMG], reference: [IMG2] } }), seedance2)).toThrow(
      /either frames or references/,
    );
    expect(() => toKieFor(plane(seedance2, { media: { end: [IMG] } }), seedance2)).toThrow(/start frame/);
  });

  it("2.5 sends output_format and the 4k-free resolution list", () => {
    const request = toKieFor(
      plane(seedance25, { settings: { resolution: "1080p", outputFormat: "mov", duration: 30 } }),
      seedance25,
    );
    expect(request).toEqual({
      model: "bytedance/seedance-2-5",
      input: {
        prompt: "a prompt",
        aspect_ratio: "16:9",
        resolution: "1080p",
        duration: 30,
        generate_audio: true,
        output_format: "mov",
      },
    });
  });

  it("2.5 edit sends the clip as the first reference video with duration -1", () => {
    const request = toKieFor(plane(seedance25Edit, { media: { video: [VID], reference: [IMG] } }), seedance25Edit);
    expect(request).toEqual({
      model: "bytedance/seedance-2-5",
      input: {
        prompt: "a prompt",
        resolution: "720p",
        generate_audio: true,
        output_format: "mp4",
        duration: -1,
        aspect_ratio: "adaptive",
        reference_video_urls: [VID],
        reference_image_urls: [IMG],
      },
    });
    expect(() => toKieFor(plane(seedance25Edit), seedance25Edit)).toThrow(/video to edit/);
  });
});
