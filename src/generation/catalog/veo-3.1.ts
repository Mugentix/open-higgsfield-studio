import type { ModelEntry } from "./types";
import { VIDEO_DEADLINE_MS } from "./tokens";
import { mapValues, snapTo } from "../to-kie/values";

/* One KIE model for every shape, hand-mapped in to-kie/veo.ts: the mode is a
   generation_type flag and the frames are positions in image_urls. KIE
   spells the auto ratio "Auto" and takes only 4, 6 or 8 seconds (8 in
   reference mode), so the slider steps by two and persisted picks snap. Off
   the picker until a live task proves the route. */
export const veo31: ModelEntry = {
  id: "veo-3.1",
  surface: "video",
  label: "Veo 3.1",
  roles: { start: 1, end: 1, reference: 3 },
  exclusive: "frames-or-references",
  settings: {
    aspectRatio: { type: "enum", values: ["16:9", "9:16", "auto"], default: "16:9" },
    resolution: { type: "enum", values: ["720p", "1080p", "4k"], default: "720p" },
    duration: { type: "range", min: 4, max: 8, default: 8, step: 2 },
  },
  kie: {
    models: { text: "veo-3-1", image: "veo-3-1", firstLast: "veo-3-1", reference: "veo-3-1" },
    values: { aspectRatio: mapValues({ auto: "Auto" }), duration: snapTo([4, 6, 8]) },
    deadlineMs: VIDEO_DEADLINE_MS,
    enabled: false,
  },
};
