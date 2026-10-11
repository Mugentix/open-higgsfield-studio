import { parseSettings } from "@/generation/catalog/parse-settings";
import type { GenerationPlane, MediaRole, ModelEntry } from "@/generation/catalog/types";

/** A plane as the server sees it after parsePlane: settings filled from the
    entry's defaults, media items in role lists. */
export function plane(
  model: ModelEntry,
  options: {
    prompt?: string;
    settings?: Record<string, unknown>;
    media?: Partial<Record<MediaRole, string[]>>;
  } = {},
): GenerationPlane {
  const media: GenerationPlane["media"] = {};
  for (const [role, urls] of Object.entries(options.media ?? {})) {
    media[role as MediaRole] = (urls ?? []).map((url, index) => ({
      id: `${role}-${index}`,
      url,
      role: role as MediaRole,
    }));
  }
  return {
    model: model.id,
    prompt: { text: options.prompt ?? "a prompt" },
    media,
    settings: parseSettings(model, options.settings ?? {}),
  };
}

export const IMG = "https://files.example.com/ref.png";
export const IMG2 = "https://files.example.com/ref2.png";
export const VID = "https://files.example.com/clip.mp4";
export const AUD = "https://files.example.com/track.wav";
