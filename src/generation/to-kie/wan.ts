import type { GenerationPlane, KieMapper, KieRequest, ModelEntry } from "../catalog/types";
import { PlaneError, mapByRoute, settingsInput, urls } from "./shared";

/* Wan 3.0 is one KIE model per tier for text, frames and references, and the
   two media branches are exclusive on the wire: first_frame_url with an
   optional last_frame_url, or the reference_image_urls / reference_video_urls
   / reference_audio_urls lists, never both. The doc's file and link branches
   have no catalog role and are never sent. Wan 2.6 and 2.7 are plain renames
   and ride the shared mapper. */
function mapWan3(plane: GenerationPlane, model: ModelEntry): KieRequest {
  const kieModel = model.kie.models.text;
  if (!kieModel) throw new Error(`${model.id} names no KIE model`);
  const start = urls(plane, "start")[0];
  const end = urls(plane, "end")[0];
  const refs = urls(plane, "reference");
  const videos = urls(plane, "video");
  const audios = urls(plane, "audio");
  const hasRefs = refs.length > 0 || videos.length > 0 || audios.length > 0;

  if (end && !start) throw new PlaneError(`${model.label} needs a start frame with the end frame`);
  if (start && hasRefs) throw new PlaneError(`${model.label} takes either frames or references, not both`);

  const input = settingsInput(plane, model, start ? "firstLast" : hasRefs ? "reference" : "text");
  if (start) {
    /* The frame decides the picture's shape; the doc's frame examples all say
       adaptive, and a fixed ratio would crop the frame the visitor chose. */
    input.aspect_ratio = "adaptive";
    input.first_frame_url = start;
    if (end) input.last_frame_url = end;
  } else {
    if (refs.length) input.reference_image_urls = refs;
    if (videos.length) {
      /* Input clips plus output must fit in 30 s, and the clips may total 15. */
      if (Number(input.duration) > 15) {
        throw new PlaneError(`${model.label} takes at most 15 s with reference videos`);
      }
      input.reference_video_urls = videos;
    }
    if (audios.length) input.reference_audio_urls = audios;
  }
  return { model: kieModel, input };
}

/* The image-to-video doc shows first-only, first-and-last and clip-only
   bodies and never a last frame alone. */
function mapWan27(plane: GenerationPlane, model: ModelEntry): KieRequest {
  if (urls(plane, "end").length && !urls(plane, "start").length) {
    throw new PlaneError(`${model.label} needs a start frame with the end frame`);
  }
  return mapByRoute(plane, model);
}

/** Custom mappers for the wan family, keyed by catalog id. */
export const WAN_MAP: Record<string, KieMapper> = {
  "wan-2.7": mapWan27,
  "wan-3": mapWan3,
  "wan-3-prime": mapWan3,
};
