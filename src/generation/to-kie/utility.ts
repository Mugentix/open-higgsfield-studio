import type { GenerationPlane, KieMapper, KieRequest, MediaRole, ModelEntry } from "../catalog/types";
import { PlaneError, firstUrl, settingsInput } from "./shared";

/* Utilities — upscalers, the background remover — take one input and no
   prompt. The shared mapper would send the reference and video roles as
   lists and always write `prompt`, so this one sends the single url as a
   string under the route's key for the entry's only role, keeps the studio's
   synthetic tile text off the wire, and lets settingsInput carry the rest
   (upscale_factor, already the string KIE types it). */

/* What the missing input is called, by the role the entry declares for it. */
const INPUT_NOUN: Partial<Record<MediaRole, string>> = {
  reference: "an image",
  video: "a video",
};

function mapUtility(plane: GenerationPlane, model: ModelEntry): KieRequest {
  const kieModel = model.kie.models.reference;
  if (!kieModel) throw new Error(`${model.id} names no KIE model`);
  const role = (Object.keys(model.roles) as MediaRole[])[0];
  const key = role && model.kie.media?.[role];
  if (!role || !key) throw new Error(`${model.id} declares no input role with a wire key`);

  const url = firstUrl(plane, role);
  if (!url) throw new PlaneError(`${model.label} needs ${INPUT_NOUN[role] ?? "an input"} to work on`);

  const input = settingsInput(plane, model, "reference");
  delete input.prompt;
  input[key] = url;
  return { model: kieModel, input };
}

export const UTILITY_MAP: Record<string, KieMapper> = {
  "topaz-upscale": mapUtility,
  "crisp-upscale": mapUtility,
  "remove-background": mapUtility,
  "topaz-video-upscale": mapUtility,
};
