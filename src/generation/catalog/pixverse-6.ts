import type { ModelEntry } from "./types";
import { VIDEO_DEADLINE_MS } from "./tokens";

/* Four KIE products, one per shape, hand-mapped in to-kie/pixverse.ts: the
   start frame travels as a one-item image_urls list, a transition names its
   frames first_/last_frame_image_url, and references are {image_url, type,
   ref_name} objects. KIE calls the resolution `quality` and the audio switch
   generate_audio_switch; the frame shapes take no aspect ratio. */
export const pixverse6: ModelEntry = {
  id: "pixverse-6",
  surface: "video",
  label: "PixVerse V6",
  roles: { start: 1, end: 1, reference: 7 },
  exclusive: "frames-or-references",
  settings: {
    aspectRatio: {
      type: "enum",
      values: ["16:9", "4:3", "1:1", "3:4", "9:16", "2:3", "3:2", "21:9"],
      default: "16:9",
    },
    resolution: { type: "enum", values: ["360p", "540p", "720p", "1080p"], default: "720p" },
    duration: { type: "range", min: 1, max: 15, default: 5 },
    generateAudio: { type: "boolean", default: false },
  },
  kie: {
    models: {
      text: "pixverse-v6/text-to-video",
      image: "pixverse-v6/image-to-video",
      firstLast: "pixverse-v6/transition",
      reference: "pixverse-v6/reference-to-video",
    },
    keys: { resolution: "quality", generateAudio: "generate_audio_switch" },
    omit: { image: ["aspectRatio"], firstLast: ["aspectRatio"] },
    deadlineMs: VIDEO_DEADLINE_MS,
  },
};
