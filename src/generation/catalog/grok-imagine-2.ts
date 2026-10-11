import type { ModelEntry } from "./types";
import { IMAGE_DEADLINE_MS } from "./tokens";

/* Two KIE models: text-to-image, and image-edit once references are attached
   (the doc page is titled image-to-image, but the model id it names is
   image-edit). aspect_ratio is required on both; only image-edit accepts
   "auto", so the catalog leaves it out. Neither takes a resolution. */
export const grokImagine2: ModelEntry = {
  id: "grok-imagine-2",
  surface: "image",
  label: "Grok Imagine 2.0",
  roles: { reference: 5 },
  settings: {
    aspectRatio: { type: "enum", values: ["1:1", "2:3", "3:2", "16:9", "9:16"], default: "1:1" },
  },
  kie: {
    models: {
      text: "grok-imagine-image-2-0/text-to-image",
      reference: "grok-imagine-image-2-0/image-edit",
    },
    deadlineMs: IMAGE_DEADLINE_MS,
  },
};
