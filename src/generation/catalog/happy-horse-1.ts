import type { ModelEntry } from "./types";
import { VIDEO_DEADLINE_MS } from "./tokens";

/* Plain renames, so the shared mapper serves it: the start frame is a
   one-item image_urls list (the doc's schema spells the key with a trailing
   space; its example does not), references go under reference_image in the
   order the prompt addresses them as character1, character2…, and the image
   shape takes no aspect ratio. The doc's seed stays off the wire. */
export const happyHorse1: ModelEntry = {
  id: "happy-horse-1",
  surface: "video",
  label: "Happy Horse 1.0",
  roles: { start: 1, reference: 9 },
  exclusive: "frames-or-references",
  settings: {
    aspectRatio: { type: "enum", values: ["16:9", "9:16", "1:1", "4:3", "3:4"], default: "16:9" },
    resolution: { type: "enum", values: ["720p", "1080p"], default: "1080p" },
    duration: { type: "range", min: 3, max: 15, default: 5 },
  },
  kie: {
    models: {
      text: "happyhorse/text-to-video",
      image: "happyhorse/image-to-video",
      reference: "happyhorse/reference-to-video",
    },
    media: { start: "image_urls[]", reference: "reference_image" },
    omit: { image: ["aspectRatio"] },
    deadlineMs: VIDEO_DEADLINE_MS,
  },
};
