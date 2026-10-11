import type { ModelEntry } from "./types";
import { VIDEO_DEADLINE_MS } from "./tokens";
import { snapToString, upper } from "../to-kie/values";

/* KIE has no Hailuo 2.3 text-to-video, so the entry offers the image shape
   only and a bare prompt is refused with a request for a start frame. The
   wire types duration as the string "6" | "10" and writes 768P/1080P: the
   slider steps by 4 so it offers exactly those two rungs, and persisted picks
   in between snap. KIE rejects "10" together with 1080P; a per-key coercion
   cannot see the other dial, so to-kie/minimax-grok.ts refuses that pair. */
export const minimaxHailuo23: ModelEntry = {
  id: "minimax-hailuo-2.3",
  surface: "video",
  label: "Hailuo 2.3 Pro",
  roles: { start: 1 },
  settings: {
    resolution: { type: "enum", values: ["768p", "1080p"], default: "768p" },
    duration: { type: "range", min: 6, max: 10, default: 6, step: 4 },
  },
  kie: {
    models: { image: "hailuo/2-3-image-to-video-pro" },
    values: { resolution: upper, duration: snapToString([6, 10]) },
    deadlineMs: VIDEO_DEADLINE_MS,
  },
};
