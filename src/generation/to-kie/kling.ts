import type { GenerationPlane, KieMapper, KieRequest, ModelEntry } from "../catalog/types";
import { PlaneError, pickShape, settingsInput, urls } from "./shared";

/* kling-3.0/video serves text, start-frame and first/last submits alike. The
   entry's route already carries the tier (`mode`), single-shot (`multi_shots`)
   and the aspect_ratio omission; what the shared mapper cannot say is that
   the frames go positionally: image_urls[0] first, image_urls[1] last. */
function mapKling3(plane: GenerationPlane, model: ModelEntry): KieRequest {
  const shape = pickShape(plane, model);
  const kieModel = model.kie.models[shape];
  if (!kieModel) throw new Error(`${model.id} has no KIE model for the ${shape} shape`);
  const start = urls(plane, "start")[0];
  const end = urls(plane, "end")[0];
  if (end && !start) throw new PlaneError(`${model.label} needs a start frame with the end frame`);
  const input = settingsInput(plane, model, shape);
  if (start) input.image_urls = end ? [start, end] : [start];
  return { model: kieModel, input };
}

/* kling-3.0/motion-control wants a character image and a driving clip, both
   as one-item arrays. The tier is the route's `mode` constant. */
function mapKlingMotion(plane: GenerationPlane, model: ModelEntry): KieRequest {
  const kieModel = model.kie.models.reference;
  if (!kieModel) throw new Error(`${model.id} names no KIE model`);
  const start = urls(plane, "start")[0];
  const video = urls(plane, "video")[0];
  if (!start) throw new PlaneError(`${model.label} needs a start frame of the character`);
  if (!video) throw new PlaneError(`${model.label} needs a video to take the motion from`);
  const input = settingsInput(plane, model, "reference");
  input.input_urls = [start];
  input.video_urls = [video];
  return { model: kieModel, input };
}

/* With a reference video KIE caps the reference images at four. */
const OMNI_REFS_WITH_VIDEO = 4;

/* Three omni models: text, image-to-video for frames and reference-to-video
   for references. Single-shot image mode only takes aspect_ratio "auto".
   Reference mode is a strict oneOf: images only, video only, or video with up
   to four images; audio must be false whenever a video is sent, and a
   video-only submit takes no duration and only aspect_ratio "auto". */
function mapKlingOmni(plane: GenerationPlane, model: ModelEntry): KieRequest {
  const shape = pickShape(plane, model);
  const kieModel = model.kie.models[shape];
  if (!kieModel) throw new Error(`${model.id} has no KIE model for the ${shape} shape`);
  const input = settingsInput(plane, model, shape);
  if (shape === "firstLast") {
    const start = urls(plane, "start")[0];
    const end = urls(plane, "end")[0];
    if (!start) throw new PlaneError(`${model.label} needs a start frame with the end frame`);
    input.image_urls = end ? [start, end] : [start];
    input.aspect_ratio = "auto";
  } else if (shape === "reference") {
    const refs = urls(plane, "reference");
    const video = urls(plane, "video")[0];
    if (!video) {
      input.image_urls = refs;
    } else {
      if (refs.length > OMNI_REFS_WITH_VIDEO) {
        throw new PlaneError(
          `${model.label} takes at most ${OMNI_REFS_WITH_VIDEO} reference images with a video`,
        );
      }
      input.video_urls = [video];
      input.audio = false;
      if (refs.length) {
        input.image_urls = refs;
      } else {
        input.aspect_ratio = "auto";
        delete input.duration;
      }
    }
  }
  return { model: kieModel, input };
}

export const KLING_MAP: Record<string, KieMapper> = {
  "kling-3-std": mapKling3,
  "kling-3-pro": mapKling3,
  "kling-3-4k": mapKling3,
  "kling-3-motion-std": mapKlingMotion,
  "kling-3-motion-pro": mapKlingMotion,
  "kling-3-omni": mapKlingOmni,
};
