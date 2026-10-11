import type { ModelEntry } from "./types";
import { IMAGE_DEADLINE_MS } from "./tokens";

/* Prompt and a required aspect_ratio, nothing else: no references, no
   resolution, one image per task. */
export const zImage: ModelEntry = {
  id: "z-image",
  surface: "image",
  label: "Z-Image",
  roles: {},
  settings: {
    aspectRatio: { type: "enum", values: ["1:1", "4:3", "3:4", "16:9", "9:16"], default: "1:1" },
  },
  kie: {
    models: { text: "z-image" },
    deadlineMs: IMAGE_DEADLINE_MS,
  },
};
