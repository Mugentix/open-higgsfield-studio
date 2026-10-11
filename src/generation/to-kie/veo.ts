import type { GenerationPlane, KieMapper, KieRequest, KieShape, ModelEntry } from "../catalog/types";
import { PlaneError, pickShape, settingsInput, urls } from "./shared";

/* One KIE model serves every shape; the mode is a generation_type flag and
   the frames are positions in image_urls, [start] or [start, last]. References
   ride the same list under REFERENCE_2_VIDEO, which the doc pins to 8 seconds
   whatever the slider says. */
const GENERATION_TYPE: Record<KieShape, string> = {
  text: "TEXT_2_VIDEO",
  image: "FIRST_AND_LAST_FRAMES_2_VIDEO",
  firstLast: "FIRST_AND_LAST_FRAMES_2_VIDEO",
  reference: "REFERENCE_2_VIDEO",
};

function mapVeo(plane: GenerationPlane, model: ModelEntry): KieRequest {
  const shape = pickShape(plane, model);
  const kieModel = model.kie.models[shape];
  if (!kieModel) throw new Error(`${model.id} has no KIE model for the ${shape} shape`);
  const input = settingsInput(plane, model, shape);
  input.generation_type = GENERATION_TYPE[shape];
  if (shape === "image" || shape === "firstLast") {
    const start = urls(plane, "start");
    if (start.length === 0) throw new PlaneError(`${model.label} needs a start frame with the end frame`);
    input.image_urls = [...start, ...urls(plane, "end")];
  } else if (shape === "reference") {
    input.image_urls = urls(plane, "reference");
    input.duration = 8;
  }
  return { model: kieModel, input };
}

export const VEO_MAP: Record<string, KieMapper> = {
  "veo-3.1": mapVeo,
};
