import type { GenerationPlane, KieMapper, KieRequest, ModelEntry } from "../catalog/types";
import { PlaneError, mapByRoute, pickShape, urls } from "./shared";

/* Every wire in this family is a plain rename, so each mapper rides
   mapByRoute and only adds the one rule the doc states across two fields,
   which a per-key coercion cannot see. */

/* Hailuo 2.3 Pro: "10 seconds videos are not supported for 1080p resolution." */
function mapHailuo23(plane: GenerationPlane, model: ModelEntry): KieRequest {
  const request = mapByRoute(plane, model);
  if (request.input.resolution === "1080P" && request.input.duration === "10") {
    throw new PlaneError(`${model.label} makes 6 s clips at 1080p`);
  }
  return request;
}

/* MiniMax H3 reference-to-video requires reference_image_urls or
   reference_video_urls; reference_audio_urls cannot ride alone. */
function mapMinimaxH3(plane: GenerationPlane, model: ModelEntry): KieRequest {
  if (
    pickShape(plane, model) === "reference" &&
    urls(plane, "reference").length === 0 &&
    urls(plane, "video").length === 0
  ) {
    throw new PlaneError(`${model.label} needs an image or video reference with the audio`);
  }
  return mapByRoute(plane, model);
}

/* Grok Imagine Video 1.5 takes up to seven images, but one only at 1080p. */
function mapGrokImagineVideo15(plane: GenerationPlane, model: ModelEntry): KieRequest {
  const request = mapByRoute(plane, model);
  if (request.input.resolution === "1080p" && urls(plane, "reference").length > 1) {
    throw new PlaneError(`${model.label} takes one reference at 1080p`);
  }
  return request;
}

export const MINIMAX_GROK_MAP: Record<string, KieMapper> = {
  "minimax-h3": mapMinimaxH3,
  "minimax-hailuo-2.3": mapHailuo23,
  "grok-imagine-video-1.5": mapGrokImagineVideo15,
};
