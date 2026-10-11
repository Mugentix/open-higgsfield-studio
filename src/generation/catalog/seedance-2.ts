import type { ModelEntry } from "./types";
import { LONG_VIDEO_DEADLINE_MS, SEEDANCE_ASPECT, VIDEO_DEADLINE_MS } from "./tokens";

/* The wire is shared by every tier and hand-mapped in to-kie/seedance.ts:
   frames or references, never both. `models` names the single KIE id for
   documentation and for reading the result's kind back off a status. */
const seedanceRoles = { start: 1, end: 1, reference: 9, video: 3, audio: 3 } as const;

const seedanceSettings = {
  aspectRatio: { type: "enum", values: SEEDANCE_ASPECT, default: "16:9" },
  duration: { type: "range", min: 4, max: 15, default: 5 },
  generateAudio: { type: "boolean", default: true },
} as const satisfies ModelEntry["settings"];

function seedanceKie(model: string, deadlineMs: number): ModelEntry["kie"] {
  return {
    models: { text: model, firstLast: model, reference: model },
    deadlineMs,
  };
}

export const seedance2: ModelEntry = {
  id: "seedance-2",
  surface: "video",
  label: "Seedance 2.0",
  roles: seedanceRoles,
  exclusive: "frames-or-references",
  settings: {
    ...seedanceSettings,
    resolution: { type: "enum", values: ["480p", "720p", "1080p", "4k"], default: "720p" },
  },
  kie: seedanceKie("bytedance/seedance-2", LONG_VIDEO_DEADLINE_MS),
};

export const seedance2Fast: ModelEntry = {
  id: "seedance-2-fast",
  surface: "video",
  label: "Seedance 2.0 Fast",
  roles: seedanceRoles,
  exclusive: "frames-or-references",
  settings: {
    ...seedanceSettings,
    resolution: { type: "enum", values: ["480p", "720p"], default: "720p" },
  },
  kie: seedanceKie("bytedance/seedance-2-fast", VIDEO_DEADLINE_MS),
};

export const seedance2Mini: ModelEntry = {
  id: "seedance-2-mini",
  surface: "video",
  label: "Seedance 2.0 Mini",
  roles: seedanceRoles,
  exclusive: "frames-or-references",
  settings: {
    ...seedanceSettings,
    resolution: { type: "enum", values: ["480p", "720p"], default: "720p" },
  },
  kie: seedanceKie("bytedance/seedance-2-mini", VIDEO_DEADLINE_MS),
};
