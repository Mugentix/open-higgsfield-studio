import { describe, expect, it } from "vitest";

import { nanoBanana2, nanoBananaPro } from "@/generation/catalog/nano-banana-pro";
import { toKieFor } from "@/generation/to-kie";

import { IMG, IMG2, plane } from "../plane";

describe("nano-banana-pro", () => {
  it("text shape sends prompt, uppercase resolution and no image_input", () => {
    expect(toKieFor(plane(nanoBananaPro, { prompt: "banana hero" }), nanoBananaPro)).toEqual({
      model: "nano-banana-pro",
      input: { prompt: "banana hero", aspect_ratio: "1:1", resolution: "1K", output_format: "png" },
    });
  });

  it("reference shape carries image_input on the same model", () => {
    const request = toKieFor(
      plane(nanoBananaPro, { settings: { resolution: "4k", aspectRatio: "9:16" }, media: { reference: [IMG, IMG2] } }),
      nanoBananaPro,
    );
    expect(request.model).toBe("nano-banana-pro");
    expect(request.input).toMatchObject({ resolution: "4K", aspect_ratio: "9:16", image_input: [IMG, IMG2] });
    expect(request.input).not.toHaveProperty("image_urls");
  });

  it("nano-banana-2 accepts the extreme ratios", () => {
    const request = toKieFor(plane(nanoBanana2, { settings: { aspectRatio: "8:1" } }), nanoBanana2);
    expect(request).toEqual({
      model: "nano-banana-2",
      input: { prompt: "a prompt", aspect_ratio: "8:1", resolution: "1K", output_format: "png" },
    });
  });
});
