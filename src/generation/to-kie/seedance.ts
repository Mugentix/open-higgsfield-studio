import type { GenerationPlane, KieMapper, KieRequest, ModelEntry } from "../catalog/types";
import { PlaneError, settingsInput, urls } from "./shared";

/* One KIE model per Seedance tier covers text, frames and references, but the
   three are exclusive scenarios on the wire: a start frame (with an optional
   end frame) or reference_* lists, never both. Frames use first_frame_url and
   last_frame_url; references use reference_image_urls, reference_video_urls
   and reference_audio_urls. */
function mapSeedance(plane: GenerationPlane, model: ModelEntry): KieRequest {
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
    input.first_frame_url = start;
    if (end) input.last_frame_url = end;
  } else {
    if (refs.length) input.reference_image_urls = refs;
    if (videos.length) input.reference_video_urls = videos;
    if (audios.length) input.reference_audio_urls = audios;
  }
  return { model: kieModel, input };
}

/* KIE has no video-edit endpoint for Seedance 2.5. The closest documented
   route is the 2.5 model with the source clip as the first reference video and
   duration -1, which the doc reserves for "video-editing tasks" and matches
   the input's length. Approximate by design; the label says Edit, the wire is
   reference-to-video. */
function mapSeedanceEdit(plane: GenerationPlane, model: ModelEntry): KieRequest {
  const kieModel = model.kie.models.reference;
  if (!kieModel) throw new Error(`${model.id} names no KIE model`);
  const [video, ...extraVideos] = urls(plane, "video");
  if (!video) throw new PlaneError(`${model.label} needs the video to edit`);
  const refs = urls(plane, "reference");
  const audios = urls(plane, "audio");
  const input = settingsInput(plane, model, "reference");
  input.duration = -1;
  input.aspect_ratio = "adaptive";
  input.reference_video_urls = [video, ...extraVideos];
  if (refs.length) input.reference_image_urls = refs;
  if (audios.length) input.reference_audio_urls = audios;
  return { model: kieModel, input };
}

export const SEEDANCE_MAP: Record<string, KieMapper> = {
  "seedance-2": mapSeedance,
  "seedance-2-fast": mapSeedance,
  "seedance-2-mini": mapSeedance,
  "seedance-2.5": mapSeedance,
  "seedance-2.5-edit": mapSeedanceEdit,
};
