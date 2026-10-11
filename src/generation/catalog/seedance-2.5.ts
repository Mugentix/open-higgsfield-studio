import type { ModelEntry } from "./types";
import { LONG_VIDEO_DEADLINE_MS, SEEDANCE_ASPECT } from "./tokens";

const KIE_MODEL = "bytedance/seedance-2-5";

export const seedance25: ModelEntry = {
  id: "seedance-2.5",
  surface: "video",
  label: "Seedance 2.5",
  roles: { start: 1, end: 1, reference: 30, video: 10, audio: 10 },
  exclusive: "frames-or-references",
  settings: {
    aspectRatio: { type: "enum", values: SEEDANCE_ASPECT, default: "16:9" },
    resolution: { type: "enum", values: ["480p", "720p", "1080p"], default: "720p" },
    duration: { type: "range", min: 4, max: 30, default: 5 },
    generateAudio: { type: "boolean", default: true },
    outputFormat: { type: "enum", values: ["mp4", "mov"], default: "mp4" },
  },
  kie: {
    models: { text: KIE_MODEL, firstLast: KIE_MODEL, reference: KIE_MODEL },
    deadlineMs: LONG_VIDEO_DEADLINE_MS,
  },
};

/* KIE documents no edit endpoint for 2.5; to-kie/seedance.ts sends the clip as
   the first reference video with duration -1, the doc's value for editing
   tasks. The result follows the clip's length, so there is no duration dial. */
export const seedance25Edit: ModelEntry = {
  id: "seedance-2.5-edit",
  surface: "video",
  label: "Seedance 2.5 Edit",
  roles: { video: 1, reference: 9, audio: 3 },
  settings: {
    resolution: { type: "enum", values: ["480p", "720p", "1080p"], default: "720p" },
    generateAudio: { type: "boolean", default: true },
    outputFormat: { type: "enum", values: ["mp4", "mov"], default: "mp4" },
  },
  kie: {
    models: { reference: KIE_MODEL },
    deadlineMs: LONG_VIDEO_DEADLINE_MS,
  },
};
