import type { ModelEntry } from "./types";
import { VIDEO_ASPECT, VIDEO_DEADLINE_MS } from "./tokens";
import { asString } from "../to-kie/values";

/* One KIE model per shape. Both type duration as a string, and the image
   model has no aspect_ratio: the frame decides it. */
export const kling3Turbo: ModelEntry = {
  id: "kling-3-turbo",
  surface: "video",
  label: "Kling 3.0 Turbo",
  roles: { start: 1 },
  settings: {
    aspectRatio: { type: "enum", values: VIDEO_ASPECT, default: "16:9" },
    resolution: { type: "enum", values: ["720p", "1080p"], default: "720p" },
    duration: { type: "range", min: 3, max: 15, default: 5 },
  },
  kie: {
    models: { text: "kling/v3-turbo-text-to-video", image: "kling/v3-turbo-image-to-video" },
    media: { start: "image_urls[]" },
    values: { duration: asString },
    omit: { image: ["aspectRatio"] },
    deadlineMs: VIDEO_DEADLINE_MS,
  },
};
