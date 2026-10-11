import type { ModelEntry } from "./types";
import { IMAGE_DEADLINE_MS } from "./tokens";
import { upper } from "../to-kie/values";

/* Flare is one of the two GPT Image 2.5 variants KIE lists with the same
   schema. References ride input_urls (KIE takes 16; the studio caps at 8).
   KIE writes resolution as 1K/2K/4K and documents no default for it or for
   background, so the catalog picks 1K and auto. KIE also lists 27:16, 16:27,
   9:8 and 8:9, but the doc makes them 1K-only and the declarative route has no
   cross-key check, so they are left out rather than paired with 2K/4K. */
const GPT_IMAGE_ASPECT = ["auto", "1:1", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16", "21:9"] as const;

export const gptImage25: ModelEntry = {
  id: "gpt-image-2.5",
  surface: "image",
  label: "GPT Image 2.5",
  roles: { reference: 8 },
  settings: {
    aspectRatio: { type: "enum", values: GPT_IMAGE_ASPECT, default: "auto" },
    resolution: { type: "enum", values: ["1k", "2k", "4k"], default: "1k" },
    background: { type: "enum", values: ["transparent", "opaque", "auto"], default: "auto" },
  },
  kie: {
    models: {
      text: "gpt-image-2-5-flare-text-to-image",
      reference: "gpt-image-2-5-flare-image-to-image",
    },
    media: { reference: "input_urls" },
    values: { resolution: upper },
    deadlineMs: IMAGE_DEADLINE_MS,
  },
};
