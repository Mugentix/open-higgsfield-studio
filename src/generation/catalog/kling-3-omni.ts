import type { ModelEntry } from "./types";
import { LONG_VIDEO_DEADLINE_MS, VIDEO_ASPECT } from "./tokens";

/* Three KIE models, one per shape, hand-mapped in to-kie/kling.ts: frames go
   as a positional image_urls array with aspect_ratio "auto", references as
   image_urls and/or a single video_urls entry. Every submit is single-shot
   (customize_multi_shots false), so multi_prompt and elements stay off the
   wire. Duration is an integer here, unlike the rest of the family. */
export const kling3Omni: ModelEntry = {
  id: "kling-3-omni",
  surface: "video",
  label: "Kling 3.0 Omni",
  roles: { start: 1, end: 1, reference: 7, video: 1 },
  exclusive: "frames-or-references",
  settings: {
    aspectRatio: { type: "enum", values: VIDEO_ASPECT, default: "16:9" },
    resolution: { type: "enum", values: ["720p", "1080p", "4k"], default: "720p" },
    duration: { type: "range", min: 3, max: 15, default: 5 },
    audio: { type: "boolean", default: false },
  },
  kie: {
    models: {
      text: "kling-3.0-omni/text-to-video",
      firstLast: "kling-3.0-omni/image-to-video",
      reference: "kling-3.0-omni/reference-to-video",
    },
    constants: { all: { customize_multi_shots: false } },
    deadlineMs: LONG_VIDEO_DEADLINE_MS,
  },
};
