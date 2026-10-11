import { getModel, parseSettings } from "./catalog";
import type { GenerationPlane, MediaItem, MediaRole } from "./catalog/types";

const ROLES: readonly MediaRole[] = ["start", "end", "reference", "video", "audio"];
const MAX_PROMPT = 30_000;
const URL_RE = /^https?:\/\/\S+$/i;

/** A plane arrives from the browser as JSON; nothing in it is trusted until
    it has been read back against the catalog. */
export function parsePlane(data: unknown): GenerationPlane {
  const raw = asObject(data, "Invalid generation");
  if (typeof raw.model !== "string") throw new Error("Invalid model");
  const model = getModel(raw.model);

  const prompt = asObject(raw.prompt, "Invalid prompt");
  const text = typeof prompt.text === "string" ? prompt.text.trim() : "";
  /* A utility works on its input alone, so its plane may say nothing; every
     other model needs the words. */
  if (!text && model.prompt !== "none") throw new Error("Prompt is required");
  if (text.length > MAX_PROMPT) throw new Error(`Prompt longer than ${MAX_PROMPT} characters`);

  const media: GenerationPlane["media"] = {};
  const rawMedia = raw.media === undefined ? {} : asObject(raw.media, "Invalid media");
  for (const role of ROLES) {
    const list = rawMedia[role];
    if (list === undefined) continue;
    if (!Array.isArray(list)) throw new Error(`Invalid ${role} media`);
    const cap = model.roles[role] ?? 0;
    const items: MediaItem[] = [];
    for (const item of list) {
      const record = asObject(item, `Invalid ${role} media`);
      if (typeof record.url !== "string" || !URL_RE.test(record.url)) {
        throw new Error(`Invalid ${role} media url`);
      }
      if (items.length >= cap) break;
      items.push({
        id: typeof record.id === "string" ? record.id : `${role}-${items.length}`,
        url: record.url,
        role,
        ...(typeof record.assetId === "string" ? { assetId: record.assetId } : {}),
        ...(typeof record.resultId === "string" ? { resultId: record.resultId } : {}),
      });
    }
    if (items.length) media[role] = items;
  }

  return {
    model: model.id,
    prompt: { text },
    media,
    settings: parseSettings(model, asObject(raw.settings ?? {}, "Invalid settings")),
  };
}

function asObject(value: unknown, message: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}
