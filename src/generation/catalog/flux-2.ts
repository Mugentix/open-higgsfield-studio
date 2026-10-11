import type { ModelEntry } from "./types";
import { IMAGE_DEADLINE_MS } from "./tokens";
import { upper } from "../to-kie/values";

/* Two KIE models: text-to-image, and image-to-image for references, which
   takes 1–8 input_urls in the order the prompt addresses them ("image 1",
   "image 2"). aspect_ratio and resolution are required on both wires. "auto"
   is only legal on image-to-image, so the entry leaves it out rather than
   offer the text shape a value KIE rejects. KIE writes resolution as 1K/2K;
   the catalog keeps the studio's lowercase and uppercases on the wire. */
const FLUX_ASPECT = ["1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3"] as const;

export const flux2: ModelEntry = {
  id: "flux-2",
  surface: "image",
  label: "Flux 2 Pro",
  roles: { reference: 8 },
  settings: {
    aspectRatio: { type: "enum", values: FLUX_ASPECT, default: "1:1" },
    resolution: { type: "enum", values: ["1k", "2k"], default: "1k" },
  },
  kie: {
    models: { text: "flux-2/pro-text-to-image", reference: "flux-2/pro-image-to-image" },
    media: { reference: "input_urls" },
    values: { resolution: upper },
    deadlineMs: IMAGE_DEADLINE_MS,
  },
};
