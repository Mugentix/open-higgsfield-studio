import type { ModelEntry } from "./types";
import { VIDEO_DEADLINE_MS } from "./tokens";
import { snapToString } from "../to-kie/values";

/* Neither KIE model has an aspect field, so there is no aspectRatio setting.
   duration is the string enum "5" | "10" | "15" on the wire: the slider steps
   by five and the coercion snaps and stringifies. The start frame goes as a
   one-item image_urls array. */
export const wan26: ModelEntry = {
  id: "wan-2.6",
  surface: "video",
  label: "Wan 2.6",
  roles: { start: 1 },
  settings: {
    resolution: { type: "enum", values: ["720p", "1080p"], default: "720p" },
    duration: { type: "range", min: 5, max: 15, default: 5, step: 5 },
    multiShots: { type: "boolean", default: false },
  },
  kie: {
    models: { text: "wan/2-6-text-to-video", image: "wan/2-6-image-to-video" },
    media: { start: "image_urls[]" },
    values: { duration: snapToString([5, 10, 15]) },
    deadlineMs: VIDEO_DEADLINE_MS,
  },
};
