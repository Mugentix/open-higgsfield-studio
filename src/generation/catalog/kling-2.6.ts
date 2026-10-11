import type { ModelEntry } from "./types";
import { VIDEO_ASPECT, VIDEO_DEADLINE_MS } from "./tokens";
import { snapToString } from "../to-kie/values";

/* One KIE model per shape. KIE types duration as "5" | "10", so the slider
   steps by 5 and the wire snaps and stringifies (the snap only matters for
   persisted legacy picks). No resolution dial on this model, and the image
   model has no aspect_ratio: the frame decides it. */
export const kling26: ModelEntry = {
  id: "kling-2.6",
  surface: "video",
  label: "Kling 2.6",
  roles: { start: 1 },
  settings: {
    aspectRatio: { type: "enum", values: VIDEO_ASPECT, default: "16:9" },
    duration: { type: "range", min: 5, max: 10, default: 5, step: 5 },
    sound: { type: "boolean", default: true },
  },
  kie: {
    models: { text: "kling-2.6/text-to-video", image: "kling-2.6/image-to-video" },
    media: { start: "image_urls[]" },
    values: { duration: snapToString([5, 10]) },
    omit: { image: ["aspectRatio"] },
    deadlineMs: VIDEO_DEADLINE_MS,
  },
};
