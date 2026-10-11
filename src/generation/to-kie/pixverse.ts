import type { GenerationPlane, KieMapper, KieRequest, ModelEntry } from "../catalog/types";
import { PlaneError, firstUrl, pickShape, settingsInput, urls } from "./shared";

/* A different KIE product per shape, each with its own media key: the start
   frame as a one-item image_urls list, a transition as first_ and
   last_frame_image_url (both required), and references as objects the prompt
   can address by @ref_name. Settings ride the route's keys and omits. */
function mapPixverse(plane: GenerationPlane, model: ModelEntry): KieRequest {
  const shape = pickShape(plane, model);
  const kieModel = model.kie.models[shape];
  if (!kieModel) throw new Error(`${model.id} has no KIE model for the ${shape} shape`);
  const input = settingsInput(plane, model, shape);
  if (shape === "image") {
    input.image_urls = urls(plane, "start");
  } else if (shape === "firstLast") {
    const start = firstUrl(plane, "start");
    const end = firstUrl(plane, "end");
    if (!start || !end) throw new PlaneError(`${model.label} needs a start frame with the end frame`);
    input.first_frame_image_url = start;
    input.last_frame_image_url = end;
  } else if (shape === "reference") {
    input.image_references = urls(plane, "reference").map((image_url, index) => ({
      image_url,
      type: "subject",
      ref_name: `ref${index + 1}`,
    }));
  }
  return { model: kieModel, input };
}

export const PIXVERSE_MAP: Record<string, KieMapper> = {
  "pixverse-6": mapPixverse,
};
