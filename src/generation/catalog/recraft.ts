import type { ModelEntry } from "./types";
import { IMAGE_DEADLINE_MS } from "./tokens";

/* Two image tools with no prompt and no settings, hand-mapped in
   to-kie/utility.ts: the one input url goes as a plain string under `image`.
   Crisp Upscale takes jpeg/png/webp up to 10 MB; Remove Background takes the
   same formats up to 5 MB and 4096 px a side, and answers with a transparent
   png. */
export const crispUpscale: ModelEntry = {
  id: "crisp-upscale",
  surface: "image",
  label: "Crisp Upscale",
  prompt: "none",
  tool: { line: "Crisp upscale", key: "u" },
  roles: { reference: 1 },
  settings: {},
  kie: {
    models: { reference: "recraft/crisp-upscale" },
    media: { reference: "image" },
    deadlineMs: IMAGE_DEADLINE_MS,
  },
};

export const removeBackground: ModelEntry = {
  id: "remove-background",
  surface: "image",
  label: "Remove Background",
  prompt: "none",
  tool: { line: "Background removed", key: "b" },
  roles: { reference: 1 },
  settings: {},
  kie: {
    models: { reference: "recraft/remove-background" },
    media: { reference: "image" },
    deadlineMs: IMAGE_DEADLINE_MS,
  },
};
