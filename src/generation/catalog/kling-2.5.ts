import type { ModelEntry } from "./types";
import { VIDEO_ASPECT, VIDEO_DEADLINE_MS } from "./tokens";
import { snapToString } from "../to-kie/values";

/* One KIE model per shape. The image model takes a scalar image_url and an
   optional tail_image_url, so the end frame rides the image shape. KIE types
   duration as "5" | "10", so the slider steps by 5 and the wire snaps and
   stringifies (the snap only matters for persisted legacy picks); no
   resolution dial on this model. */
export const kling25: ModelEntry = {
  id: "kling-2.5",
  surface: "video",
  label: "Kling 2.5 Turbo Pro",
  roles: { start: 1, end: 1 },
  settings: {
    aspectRatio: { type: "enum", values: VIDEO_ASPECT, default: "16:9" },
    duration: { type: "range", min: 5, max: 10, default: 5, step: 5 },
    cfgScale: { type: "range", min: 0, max: 1, default: 0.5, step: 0.1 },
  },
  kie: {
    models: {
      text: "kling/v2-5-turbo-text-to-video-pro",
      image: "kling/v2-5-turbo-image-to-video-pro",
    },
    media: { start: "image_url", end: "tail_image_url" },
    values: { duration: snapToString([5, 10]) },
    omit: { image: ["aspectRatio"] },
    deadlineMs: VIDEO_DEADLINE_MS,
  },
};
