import type { ModelEntry } from "./types";
import { IMAGE_DEADLINE_MS } from "./tokens";
import { upper } from "../to-kie/values";

/* Text and image-to-image share one schema under two model ids. KIE calls the
   aspect ratio image_size and writes resolutions as 1K/2K; the catalog keeps
   the studio's key and lowercase and renames/uppercases on the wire. */
export const qwenImage3: ModelEntry = {
  id: "qwen-image-3",
  surface: "image",
  label: "Qwen Image 3 Pro",
  roles: { reference: 3 },
  settings: {
    aspectRatio: {
      type: "enum",
      values: ["1:1", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16", "21:9"],
      default: "1:1",
    },
    resolution: { type: "enum", values: ["1k", "2k"], default: "1k" },
    outputFormat: { type: "enum", values: ["png", "jpeg"], default: "png" },
    promptExtend: { type: "boolean", default: true },
  },
  kie: {
    models: { text: "qwen3/pro-text-to-image", reference: "qwen3/pro-image-to-image" },
    keys: { aspectRatio: "image_size" },
    values: { resolution: upper },
    deadlineMs: IMAGE_DEADLINE_MS,
  },
};
