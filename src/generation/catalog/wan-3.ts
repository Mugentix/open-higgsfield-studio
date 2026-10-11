import type { ModelEntry } from "./types";
import { LONG_VIDEO_DEADLINE_MS } from "./tokens";
import { upper } from "../to-kie/values";

/* One KIE model per tier covers text, frames and references, hand-mapped in
   to-kie/wan.ts the way Seedance is: frames or references, never both. KIE
   writes resolutions as 480P/720P/1080P; the catalog keeps the studio's
   lowercase and uppercases on the wire. */
const WAN_3_ASPECT = ["adaptive", "16:9", "4:3", "1:1", "3:4", "9:16"] as const;

const wan3Roles = { start: 1, end: 1, reference: 10, video: 5, audio: 5 } as const;

const wan3Settings = {
  aspectRatio: { type: "enum", values: WAN_3_ASPECT, default: "16:9" },
  resolution: { type: "enum", values: ["480p", "720p", "1080p"], default: "720p" },
  duration: { type: "range", min: 2, max: 30, default: 5 },
  audio: { type: "boolean", default: true },
} as const satisfies ModelEntry["settings"];

function wan3Kie(model: string): ModelEntry["kie"] {
  return {
    models: { text: model, firstLast: model, reference: model },
    values: { resolution: upper },
    deadlineMs: LONG_VIDEO_DEADLINE_MS,
  };
}

export const wan3: ModelEntry = {
  id: "wan-3",
  surface: "video",
  label: "Wan 3.0",
  roles: wan3Roles,
  exclusive: "frames-or-references",
  settings: { ...wan3Settings },
  kie: wan3Kie("wan/3-0-video"),
};

export const wan3Prime: ModelEntry = {
  id: "wan-3-prime",
  surface: "video",
  label: "Wan 3.0 Prime",
  roles: wan3Roles,
  exclusive: "frames-or-references",
  settings: { ...wan3Settings },
  kie: wan3Kie("wan/3-0-video-prime"),
};
