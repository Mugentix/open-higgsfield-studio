import type { ModelEntry } from "./types";
import { LONG_VIDEO_DEADLINE_MS, VIDEO_ASPECT, VIDEO_DEADLINE_MS } from "./tokens";
import { asString } from "../to-kie/values";

/* One KIE model for all three tiers, hand-mapped in to-kie/kling.ts: the tier
   is the route's `mode` constant, frames travel as a positional image_urls
   array, and every submit is single-shot, so KIE's multi_prompt and element
   fields never reach the wire. The model has no cfg_scale. */
const KIE_MODEL = "kling-3.0/video";

const kling3Settings = {
  aspectRatio: { type: "enum", values: VIDEO_ASPECT, default: "16:9" },
  duration: { type: "range", min: 3, max: 15, default: 5 },
  sound: { type: "boolean", default: true },
} as const satisfies ModelEntry["settings"];

function kling3Kie(mode: "std" | "pro" | "4K", deadlineMs: number): ModelEntry["kie"] {
  return {
    models: { text: KIE_MODEL, image: KIE_MODEL, firstLast: KIE_MODEL },
    values: { duration: asString },
    omit: { image: ["aspectRatio"], firstLast: ["aspectRatio"] },
    constants: { all: { mode, multi_shots: false } },
    deadlineMs,
  };
}

export const kling3Std: ModelEntry = {
  id: "kling-3-std",
  surface: "video",
  label: "Kling 3.0 Standard",
  roles: { start: 1, end: 1 },
  settings: kling3Settings,
  kie: kling3Kie("std", VIDEO_DEADLINE_MS),
};

export const kling3Pro: ModelEntry = {
  id: "kling-3-pro",
  surface: "video",
  label: "Kling 3.0 Pro",
  roles: { start: 1, end: 1 },
  settings: kling3Settings,
  kie: kling3Kie("pro", VIDEO_DEADLINE_MS),
};

export const kling34k: ModelEntry = {
  id: "kling-3-4k",
  surface: "video",
  label: "Kling 3.0 4K",
  roles: { start: 1, end: 1 },
  settings: kling3Settings,
  kie: kling3Kie("4K", LONG_VIDEO_DEADLINE_MS),
};
