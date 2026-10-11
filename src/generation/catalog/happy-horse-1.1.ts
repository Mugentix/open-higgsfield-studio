import type { ModelEntry } from "./types";
import { VIDEO_DEADLINE_MS } from "./tokens";

/* Same wire as 1.0 with four more ratios, no seed, and additionalProperties
   false on the schema: only prompt, resolution, aspect_ratio, duration and
   the media key go out. The prompt addresses references as [Image 1],
   [Image 2]… in reference_image order. */
export const happyHorse11: ModelEntry = {
  id: "happy-horse-1.1",
  surface: "video",
  label: "Happy Horse 1.1",
  roles: { start: 1, reference: 9 },
  exclusive: "frames-or-references",
  settings: {
    aspectRatio: {
      type: "enum",
      values: ["16:9", "9:16", "1:1", "4:3", "3:4", "4:5", "5:4", "9:21", "21:9"],
      default: "16:9",
    },
    resolution: { type: "enum", values: ["720p", "1080p"], default: "1080p" },
    duration: { type: "range", min: 3, max: 15, default: 5 },
  },
  kie: {
    models: {
      text: "happyhorse-1-1/text-to-video",
      image: "happyhorse-1-1/image-to-video",
      reference: "happyhorse-1-1/reference-to-video",
    },
    media: { start: "image_urls[]", reference: "reference_image" },
    omit: { image: ["aspectRatio"] },
    deadlineMs: VIDEO_DEADLINE_MS,
  },
};
