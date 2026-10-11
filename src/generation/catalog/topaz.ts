import type { ModelEntry } from "./types";
import { IMAGE_DEADLINE_MS, VIDEO_DEADLINE_MS } from "./tokens";

/* Two upscalers with no prompt, hand-mapped in to-kie/utility.ts: one input
   url as a plain string under image_url or video_url, and upscale_factor as
   the string KIE types it. Each declares the one role it works on, capped at
   one. KIE also lists factor "1", which is not an upscale, so it is not
   offered. The image side takes jpeg/png/webp up to 10 MB, the video side
   mp4/mov up to 50 MB.
   Both are gated: on 2026-09-29 KIE answered topaz/image-upscale with
   "internal error, please try again later" even for the example image in its
   own docs, so Crisp Upscale holds the U key until `pnpm probe --live` proves
   these routes; flip `enabled` then and give the image entry its key back. */
const UPSCALE_FACTOR = { type: "enum", values: ["2", "4"], default: "2" } as const;

export const topazUpscale: ModelEntry = {
  id: "topaz-upscale",
  surface: "image",
  label: "Topaz Upscale",
  prompt: "none",
  tool: { line: "Upscale" },
  roles: { reference: 1 },
  settings: { upscaleFactor: UPSCALE_FACTOR },
  kie: {
    models: { reference: "topaz/image-upscale" },
    media: { reference: "image_url" },
    deadlineMs: IMAGE_DEADLINE_MS,
    enabled: false,
  },
};

export const topazVideoUpscale: ModelEntry = {
  id: "topaz-video-upscale",
  surface: "video",
  label: "Topaz Video Upscale",
  prompt: "none",
  tool: { line: "Video upscale", key: "u" },
  roles: { video: 1 },
  settings: { upscaleFactor: UPSCALE_FACTOR },
  kie: {
    models: { reference: "topaz/video-upscale" },
    media: { video: "video_url" },
    deadlineMs: VIDEO_DEADLINE_MS,
    enabled: false,
  },
};
