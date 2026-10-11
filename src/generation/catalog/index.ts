import { flux2 } from "./flux-2";
import { gptImage25 } from "./gpt-image-2.5";
import { grokImagine2 } from "./grok-imagine-2";
import { grokImagineVideo15 } from "./grok-imagine-video-1.5";
import { happyHorse1 } from "./happy-horse-1";
import { happyHorse11 } from "./happy-horse-1.1";
import { ideogram3 } from "./ideogram-3";
import { kling25 } from "./kling-2.5";
import { kling26 } from "./kling-2.6";
import { kling34k, kling3Pro, kling3Std } from "./kling-3";
import { kling3MotionPro, kling3MotionStd } from "./kling-3-motion";
import { kling3Omni } from "./kling-3-omni";
import { kling3Turbo } from "./kling-3-turbo";
import { minimaxH3 } from "./minimax-h3";
import { minimaxHailuo23 } from "./minimax-hailuo-2.3";
import { nanoBanana2, nanoBananaPro } from "./nano-banana-pro";
import { parseSettings } from "./parse-settings";
import { pixverse6 } from "./pixverse-6";
import { qwenImage3 } from "./qwen-image-3";
import { crispUpscale, removeBackground } from "./recraft";
import { seedance2, seedance2Fast, seedance2Mini } from "./seedance-2";
import { seedance25, seedance25Edit } from "./seedance-2.5";
import { seedream45 } from "./seedream-4.5";
import { topazUpscale, topazVideoUpscale } from "./topaz";
import type { ModelEntry, Surface } from "./types";
import { veo31 } from "./veo-3.1";
import { wan26 } from "./wan-2.6";
import { wan27 } from "./wan-2.7";
import { wan3, wan3Prime } from "./wan-3";
import { zImage } from "./z-image";

/* Picker order. Image entries first, the everyday ad workhorse at the top of
   each surface: switching scope lands on the first entry of that surface.
   The promptless utilities close each surface. */
const ALL: readonly ModelEntry[] = [
  nanoBananaPro,
  nanoBanana2,
  seedream45,
  gptImage25,
  flux2,
  grokImagine2,
  ideogram3,
  qwenImage3,
  zImage,
  topazUpscale,
  crispUpscale,
  removeBackground,
  seedance25,
  seedance2,
  seedance2Fast,
  seedance2Mini,
  seedance25Edit,
  kling3Omni,
  kling3Turbo,
  kling3Std,
  kling3Pro,
  kling34k,
  kling3MotionStd,
  kling3MotionPro,
  kling26,
  kling25,
  veo31,
  wan3,
  wan3Prime,
  wan27,
  wan26,
  minimaxH3,
  minimaxHailuo23,
  grokImagineVideo15,
  pixverse6,
  happyHorse11,
  happyHorse1,
  topazVideoUpscale,
];

/* An entry gated behind `enabled: false` has a route the docs describe but no
   live task has proved. NEXT_PUBLIC_KIE_EXPERIMENTAL_MODELS=1 lets a checkout
   see it to run that probe. */
const SHOW_EXPERIMENTAL = process.env.NEXT_PUBLIC_KIE_EXPERIMENTAL_MODELS === "1";

export const MODELS: readonly ModelEntry[] = ALL.filter(
  (entry) => entry.kie.enabled !== false || SHOW_EXPERIMENTAL,
);

/** Every entry, gated ones included: probes and history lookups need them. */
export const ALL_MODELS: readonly ModelEntry[] = ALL;

export function getModel(id: string): ModelEntry {
  const model = ALL.find((entry) => entry.id === id);
  if (!model) throw new Error(`Unknown model: ${id}`);
  return model;
}

/** The kind of result a KIE model id produces, read off the entry that uses
    it; undefined for an id no entry lists. */
export function kieSurface(kieModel: string): Surface | undefined {
  for (const entry of ALL) {
    if (Object.values(entry.kie.models).includes(kieModel)) return entry.surface;
  }
  return undefined;
}

export type {
  GenerationPlane,
  KieMapper,
  KieRequest,
  KieRoute,
  KieShape,
  MediaItem,
  MediaRole,
  ModelEntry,
  Surface,
} from "./types";
export { parseSettings };
export { LEGACY_MODEL_IDS, resolveModelId } from "./aliases";
