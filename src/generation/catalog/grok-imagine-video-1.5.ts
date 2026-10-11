import type { ModelEntry } from "./types";
import { VIDEO_DEADLINE_MS } from "./tokens";

/* One KIE model serves text and references: image_urls is simply absent when
   nothing is attached. The input schema closes with additionalProperties:
   false, so only prompt, aspect_ratio, resolution, duration and image_urls
   may go on the wire. "auto" is KIE's own default ratio here and the ratio is
   ignored anyway once a single image sets it. 1080p takes one image only;
   to-kie/minimax-grok.ts refuses more. */
const KIE_MODEL = "grok-imagine-video-1-5-preview";

export const grokImagineVideo15: ModelEntry = {
  id: "grok-imagine-video-1.5",
  surface: "video",
  label: "Grok Imagine Video 1.5",
  roles: { reference: 7 },
  settings: {
    aspectRatio: { type: "enum", values: ["1:1", "16:9", "9:16", "3:2", "2:3", "auto"], default: "auto" },
    resolution: { type: "enum", values: ["480p", "720p", "1080p"], default: "720p" },
    duration: { type: "range", min: 1, max: 15, default: 8 },
  },
  kie: {
    models: { text: KIE_MODEL, reference: KIE_MODEL },
    deadlineMs: VIDEO_DEADLINE_MS,
  },
};
