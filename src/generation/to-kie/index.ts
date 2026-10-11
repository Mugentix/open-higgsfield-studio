import { getModel } from "../catalog";
import type { GenerationPlane, KieMapper, KieRequest, ModelEntry } from "../catalog/types";
import { KLING_MAP } from "./kling";
import { MINIMAX_GROK_MAP } from "./minimax-grok";
import { PIXVERSE_MAP } from "./pixverse";
import { SEEDANCE_MAP } from "./seedance";
import { mapByRoute } from "./shared";
import { UTILITY_MAP } from "./utility";
import { VEO_MAP } from "./veo";
import { WAN_MAP } from "./wan";

/** Families whose wire the shared mapper cannot express, keyed by catalog id.
    Everything else is a plain rename and rides `mapByRoute`. */
const MAP: Record<string, KieMapper> = {
  ...SEEDANCE_MAP,
  ...KLING_MAP,
  ...WAN_MAP,
  ...PIXVERSE_MAP,
  ...VEO_MAP,
  ...MINIMAX_GROK_MAP,
  ...UTILITY_MAP,
};

/** The createTask body for a plane whose settings are already parsed. */
export function toKie(plane: GenerationPlane): KieRequest {
  return toKieFor(plane, getModel(plane.model));
}

/** Same, with the entry in hand — tests and probes call this directly. */
export function toKieFor(plane: GenerationPlane, model: ModelEntry): KieRequest {
  const mapper = MAP[model.id] ?? mapByRoute;
  return mapper(plane, model);
}

export { PlaneError } from "./shared";
