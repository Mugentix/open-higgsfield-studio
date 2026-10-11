import type { ModelEntry } from "./types";
import { VIDEO_DEADLINE_MS } from "./tokens";

/* Two KIE models. Text-to-video names its aspect field `ratio`; image-to-video
   has no aspect field at all, the frame decides, so aspectRatio is renamed for
   one shape and dropped for the others. Frames ride first_frame_url and
   last_frame_url on both the image and the firstLast shape. */
const WAN_27_ASPECT = ["16:9", "9:16", "1:1", "4:3", "3:4"] as const;

const IMAGE_MODEL = "wan/2-7-image-to-video";

export const wan27: ModelEntry = {
  id: "wan-2.7",
  surface: "video",
  label: "Wan 2.7",
  roles: { start: 1, end: 1 },
  settings: {
    aspectRatio: { type: "enum", values: WAN_27_ASPECT, default: "16:9" },
    resolution: { type: "enum", values: ["720p", "1080p"], default: "720p" },
    duration: { type: "range", min: 2, max: 15, default: 5 },
    promptExtend: { type: "boolean", default: true },
  },
  kie: {
    models: { text: "wan/2-7-text-to-video", image: IMAGE_MODEL, firstLast: IMAGE_MODEL },
    media: { start: "first_frame_url", end: "last_frame_url" },
    keys: { aspectRatio: "ratio" },
    omit: { image: ["aspectRatio"], firstLast: ["aspectRatio"] },
    deadlineMs: VIDEO_DEADLINE_MS,
  },
};
