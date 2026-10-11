import type { ModelEntry } from "./types";
import { VIDEO_DEADLINE_MS } from "./tokens";

/* One KIE model for both tiers, hand-mapped in to-kie/kling.ts: the character
   image goes in input_urls, the driving clip in video_urls, both required.
   The tier is the route's `mode` constant. KIE has no keep-original-sound
   switch for this model. Off the picker until a live task settles two things
   the doc leaves open: whether `mode` is std/pro or 720p/1080p, and whether
   callBackUrl is really required as the schema claims. */
const KIE_MODEL = "kling-3.0/motion-control";

const klingMotionSettings = {
  characterOrientation: { type: "enum", values: ["video", "image"], default: "video" },
  backgroundSource: { type: "enum", values: ["input_video", "input_image"], default: "input_video" },
} as const satisfies ModelEntry["settings"];

function klingMotionKie(mode: "std" | "pro"): ModelEntry["kie"] {
  return {
    models: { reference: KIE_MODEL },
    constants: { all: { mode } },
    deadlineMs: VIDEO_DEADLINE_MS,
    enabled: false,
  };
}

export const kling3MotionStd: ModelEntry = {
  id: "kling-3-motion-std",
  surface: "video",
  label: "Kling 3.0 Motion Control",
  roles: { start: 1, video: 1 },
  settings: klingMotionSettings,
  kie: klingMotionKie("std"),
};

export const kling3MotionPro: ModelEntry = {
  id: "kling-3-motion-pro",
  surface: "video",
  label: "Kling 3.0 Motion Control Pro",
  roles: { start: 1, video: 1 },
  settings: klingMotionSettings,
  kie: klingMotionKie("pro"),
};
