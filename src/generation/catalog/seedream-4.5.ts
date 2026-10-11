import type { ModelEntry } from "./types";
import { IMAGE_DEADLINE_MS } from "./tokens";

/* Two KIE models: text-to-image, and edit for references, which takes up to
   14 image_urls — the shared mapper's default reference key. Both require
   aspect_ratio and quality on the wire. quality stands in for resolution
   (basic = 2K, high = 4K, no 1K); the doc has no output_format and no "auto"
   ratio, so neither is offered. */
const SEEDREAM_ASPECT = ["1:1", "4:3", "3:4", "16:9", "9:16", "2:3", "3:2", "21:9"] as const;

export const seedream45: ModelEntry = {
  id: "seedream-4.5",
  surface: "image",
  label: "Seedream 4.5",
  roles: { reference: 14 },
  settings: {
    aspectRatio: { type: "enum", values: SEEDREAM_ASPECT, default: "1:1" },
    quality: { type: "enum", values: ["basic", "high"], default: "basic" },
  },
  kie: {
    models: { text: "seedream/4.5-text-to-image", reference: "seedream/4.5-edit" },
    deadlineMs: IMAGE_DEADLINE_MS,
  },
};
