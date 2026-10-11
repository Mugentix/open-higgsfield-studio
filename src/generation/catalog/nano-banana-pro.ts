import type { ModelEntry } from "./types";
import { IMAGE_DEADLINE_MS } from "./tokens";
import { upper } from "../to-kie/values";

/* One KIE model serves both the text and the reference shape: image_input is
   simply omitted when nothing is attached. KIE writes resolutions as 1K/2K/4K;
   the catalog keeps the studio's lowercase and uppercases on the wire. */
const NANO_BANANA_ASPECT = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9", "auto"] as const;

export const nanoBananaPro: ModelEntry = {
  id: "nano-banana-pro",
  surface: "image",
  label: "Nano Banana Pro",
  roles: { reference: 8 },
  settings: {
    aspectRatio: { type: "enum", values: NANO_BANANA_ASPECT, default: "1:1" },
    resolution: { type: "enum", values: ["1k", "2k", "4k"], default: "1k" },
    outputFormat: { type: "enum", values: ["png", "jpg"], default: "png" },
  },
  kie: {
    models: { text: "nano-banana-pro", reference: "nano-banana-pro" },
    media: { reference: "image_input" },
    values: { resolution: upper },
    deadlineMs: IMAGE_DEADLINE_MS,
  },
};

export const nanoBanana2: ModelEntry = {
  id: "nano-banana-2",
  surface: "image",
  label: "Nano Banana 2",
  roles: { reference: 14 },
  settings: {
    aspectRatio: {
      type: "enum",
      values: [...NANO_BANANA_ASPECT, "1:4", "4:1", "1:8", "8:1"],
      default: "1:1",
    },
    resolution: { type: "enum", values: ["1k", "2k", "4k"], default: "1k" },
    outputFormat: { type: "enum", values: ["png", "jpg"], default: "png" },
  },
  kie: {
    models: { text: "nano-banana-2", reference: "nano-banana-2" },
    media: { reference: "image_input" },
    values: { resolution: upper },
    deadlineMs: IMAGE_DEADLINE_MS,
  },
};
