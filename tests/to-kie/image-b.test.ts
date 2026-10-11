import { describe, expect, it } from "vitest";

import { grokImagine2 } from "@/generation/catalog/grok-imagine-2";
import { ideogram3 } from "@/generation/catalog/ideogram-3";
import { qwenImage3 } from "@/generation/catalog/qwen-image-3";
import { zImage } from "@/generation/catalog/z-image";
import { toKieFor } from "@/generation/to-kie";

import { IMG, IMG2, plane } from "../plane";

describe("grok-imagine-2", () => {
  it("text shape sends prompt and the required aspect_ratio, nothing else", () => {
    expect(toKieFor(plane(grokImagine2, { prompt: "a fox in snow" }), grokImagine2)).toEqual({
      model: "grok-imagine-image-2-0/text-to-image",
      input: { prompt: "a fox in snow", aspect_ratio: "1:1" },
    });
  });

  it("reference shape goes to image-edit with image_urls", () => {
    const request = toKieFor(
      plane(grokImagine2, { settings: { aspectRatio: "9:16" }, media: { reference: [IMG, IMG2] } }),
      grokImagine2,
    );
    expect(request.model).toBe("grok-imagine-image-2-0/image-edit");
    expect(request.input).toMatchObject({ aspect_ratio: "9:16", image_urls: [IMG, IMG2] });
    expect(request.input).not.toHaveProperty("resolution");
    expect(request.input).not.toHaveProperty("image_input");
  });

  it("offers no auto ratio, since text-to-image has none", () => {
    expect(() => plane(grokImagine2, { settings: { aspectRatio: "auto" } })).toThrow(/aspectRatio/);
  });

  it("refuses a start frame", () => {
    expect(() => toKieFor(plane(grokImagine2, { media: { start: [IMG] } }), grokImagine2)).toThrow(
      /no start frame/,
    );
  });
});

describe("ideogram-3", () => {
  it("text shape sends image_size, rendering_speed, style and expand_prompt", () => {
    expect(toKieFor(plane(ideogram3, { prompt: "neon sign" }), ideogram3)).toEqual({
      model: "ideogram/v3-text-to-image",
      input: {
        prompt: "neon sign",
        image_size: "square_hd",
        rendering_speed: "BALANCED",
        style: "AUTO",
        expand_prompt: true,
      },
    });
  });

  it("reference shape goes to character with reference_image_urls", () => {
    const request = toKieFor(
      plane(ideogram3, {
        settings: { imageSize: "portrait_16_9", renderingSpeed: "quality", style: "realistic", expandPrompt: false },
        media: { reference: [IMG] },
      }),
      ideogram3,
    );
    expect(request.model).toBe("ideogram/character");
    expect(request.input).toMatchObject({
      reference_image_urls: [IMG],
      image_size: "portrait_16_9",
      rendering_speed: "QUALITY",
      style: "REALISTIC",
      expand_prompt: false,
    });
    expect(request.input).not.toHaveProperty("image_urls");
    expect(request.input).not.toHaveProperty("num_images");
    expect(request.input).not.toHaveProperty("aspect_ratio");
  });

  it("only offers the styles legal on both models", () => {
    expect(() => plane(ideogram3, { settings: { style: "design" } })).toThrow(/style/);
    expect(() => plane(ideogram3, { settings: { style: "fiction" } })).toThrow(/style/);
    expect(() => plane(ideogram3, { settings: { style: "AUTO" } })).toThrow(/style/);
  });

  it("refuses a start frame", () => {
    expect(() => toKieFor(plane(ideogram3, { media: { start: [IMG] } }), ideogram3)).toThrow(/no start frame/);
  });
});

describe("qwen-image-3", () => {
  it("text shape writes the ratio as image_size and uppercases the resolution", () => {
    expect(toKieFor(plane(qwenImage3, { prompt: "a harbour at dawn" }), qwenImage3)).toEqual({
      model: "qwen3/pro-text-to-image",
      input: {
        prompt: "a harbour at dawn",
        image_size: "1:1",
        resolution: "1K",
        output_format: "png",
        prompt_extend: true,
      },
    });
  });

  it("reference shape goes to image-to-image with image_urls", () => {
    const request = toKieFor(
      plane(qwenImage3, {
        settings: { aspectRatio: "9:16", resolution: "2k", outputFormat: "jpeg", promptExtend: false },
        media: { reference: [IMG, IMG2] },
      }),
      qwenImage3,
    );
    expect(request.model).toBe("qwen3/pro-image-to-image");
    expect(request.input).toMatchObject({
      image_urls: [IMG, IMG2],
      image_size: "9:16",
      resolution: "2K",
      output_format: "jpeg",
      prompt_extend: false,
    });
    expect(request.input).not.toHaveProperty("aspect_ratio");
    expect(request.input).not.toHaveProperty("nsfw_checker");
  });

  it("offers no auto ratio and no 4k", () => {
    expect(() => plane(qwenImage3, { settings: { aspectRatio: "auto" } })).toThrow(/aspectRatio/);
    expect(() => plane(qwenImage3, { settings: { resolution: "4k" } })).toThrow(/resolution/);
  });

  it("refuses a start frame", () => {
    expect(() => toKieFor(plane(qwenImage3, { media: { start: [IMG] } }), qwenImage3)).toThrow(/no start frame/);
  });
});

describe("z-image", () => {
  it("text shape sends prompt and aspect_ratio only", () => {
    expect(toKieFor(plane(zImage, { prompt: "cafe terrace", settings: { aspectRatio: "4:3" } }), zImage)).toEqual({
      model: "z-image",
      input: { prompt: "cafe terrace", aspect_ratio: "4:3" },
    });
  });

  it("refuses references and frames", () => {
    expect(() => toKieFor(plane(zImage, { media: { reference: [IMG] } }), zImage)).toThrow(/no references/);
    expect(() => toKieFor(plane(zImage, { media: { start: [IMG] } }), zImage)).toThrow(/no start frame/);
  });
});
