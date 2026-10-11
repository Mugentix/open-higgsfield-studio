import type { GenerationPlane, ModelEntry } from "./catalog/types";

/* One press, several placements. The plane the composer assembled is the
   primary; every extra ratio is the same plane rendered again with only
   aspectRatio changed, so a 1:1 feed post, a 4:5 and a 9:16 story leave the
   studio together under one batch. */

/** Results one press may fan out to across every format — formats × batch.
    Each unit is a real platform request, so the ceiling stays modest. */
export const FORMATS_CAP = 12;

/** The ratios a model offers, or null when its output size is not a setting
    (the input decides it) and there is nothing to fan out over. */
export function aspectRatiosOf(model: ModelEntry): readonly string[] | null {
  const field = model.settings.aspectRatio;
  return field?.type === "enum" ? field.values : null;
}

/** The chosen extra ratios the model still offers, in the catalog's order and
    without repeats. The formats store keeps whatever was toggled; the catalog
    decides at read time what of it is real, so a ratio an entry no longer
    lists simply falls away instead of failing the submit. */
export function ratiosFor(model: ModelEntry, chosen: readonly string[]): string[] {
  const offered = aspectRatiosOf(model);
  if (!offered) return [];
  return offered.filter((ratio) => chosen.includes(ratio));
}

/** One plane per format, the source plane first as the primary, then a copy
    per extra ratio with settings.aspectRatio overridden. The primary's own
    ratio and repeats are skipped; the source plane is never touched. */
export function planesFor(plane: GenerationPlane, ratios: readonly string[]): GenerationPlane[] {
  const planes: GenerationPlane[] = [plane];
  for (const ratio of ratios) {
    if (planes.some((entry) => entry.settings.aspectRatio === ratio)) continue;
    planes.push({ ...plane, settings: { ...plane.settings, aspectRatio: ratio } });
  }
  return planes;
}
