import type { ModelEntry } from "./types";
import { LONG_VIDEO_DEADLINE_MS } from "./tokens";
import { upper } from "../to-kie/values";

/* One KIE model per shape. Frames ride image-to-video as first_frame_url and
   last_frame_url, either one alone or both, and the ratio follows the image,
   so aspect_ratio stays off that wire. Text-to-video requires a ratio and
   rejects "adaptive", so the catalog offers none and the reference shape gets
   the same explicit ratio instead of KIE's adaptive default. References use
   the reference_* keys; KIE writes resolutions as 768P/2K. Audio alone is not
   a valid reference set on KIE's side; to-kie/minimax-grok.ts refuses it. */
const H3_ASPECT = ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"] as const;

export const minimaxH3: ModelEntry = {
  id: "minimax-h3",
  surface: "video",
  label: "MiniMax H3",
  roles: { start: 1, end: 1, reference: 9, video: 3, audio: 3 },
  exclusive: "frames-or-references",
  settings: {
    aspectRatio: { type: "enum", values: H3_ASPECT, default: "16:9" },
    resolution: { type: "enum", values: ["768p", "2k"], default: "2k" },
    duration: { type: "range", min: 4, max: 15, default: 6 },
  },
  kie: {
    models: {
      text: "minimax-h3/text-to-video",
      firstLast: "minimax-h3/image-to-video",
      reference: "minimax-h3/reference-to-video",
    },
    media: {
      reference: "reference_image_urls",
      video: "reference_video_urls",
      audio: "reference_audio_urls",
    },
    values: { resolution: upper },
    omit: { firstLast: ["aspectRatio"] },
    deadlineMs: LONG_VIDEO_DEADLINE_MS,
  },
};
