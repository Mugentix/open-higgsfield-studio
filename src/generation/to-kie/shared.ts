import type {
  GenerationPlane,
  KieRequest,
  KieRoute,
  KieShape,
  MediaRole,
  ModelEntry,
} from "../catalog/types";

/** The urls the plane carries for a role, in the order they were attached. */
export function urls(plane: GenerationPlane, role: MediaRole): string[] {
  return (plane.media[role] ?? []).map((item) => item.url);
}

export function firstUrl(plane: GenerationPlane, role: MediaRole): string | undefined {
  return urls(plane, role)[0];
}

export function snake(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

/** A plane the entry cannot serve as attached — the composer shows the text. */
export class PlaneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlaneError";
  }
}

type Present = { start: boolean; end: boolean; refs: boolean };

function present(plane: GenerationPlane): Present {
  return {
    start: urls(plane, "start").length > 0,
    end: urls(plane, "end").length > 0,
    refs:
      urls(plane, "reference").length > 0 ||
      urls(plane, "video").length > 0 ||
      urls(plane, "audio").length > 0,
  };
}

/** Which KIE model the attached media calls for. Frames and references are
    different products on every KIE model, so a plane carrying both is refused
    rather than quietly trimmed. */
export function pickShape(plane: GenerationPlane, model: ModelEntry): KieShape {
  const has = present(plane);
  const offers = model.kie.models;
  if (has.start || has.end) {
    if (has.refs) throw new PlaneError(`${model.label} takes either frames or references, not both`);
    if (has.start && !has.end && offers.image) return "image";
    if (offers.firstLast) return "firstLast";
    if (offers.image && has.start) return "image";
    throw new PlaneError(
      has.start ? `${model.label} takes no start frame` : `${model.label} needs a start frame with the end frame`,
    );
  }
  if (has.refs) {
    if (offers.reference) return "reference";
    throw new PlaneError(`${model.label} takes no references`);
  }
  if (offers.text) return "text";
  throw new PlaneError(`${model.label} needs ${needs(offers)}`);
}

function needs(offers: KieRoute["models"]): string {
  const wants: string[] = [];
  if (offers.image || offers.firstLast) wants.push("a start frame");
  if (offers.reference) wants.push("a reference");
  return wants.join(" or ") || "media it cannot take";
}

/** The settings part of the wire body: every parsed setting under its wire
    key, coerced, minus what the shape omits, plus the route's constants. */
export function settingsInput(
  plane: GenerationPlane,
  model: ModelEntry,
  shape: KieShape,
): Record<string, unknown> {
  const route = model.kie;
  const omit = new Set(route.omit?.[shape] ?? []);
  const input: Record<string, unknown> = { prompt: plane.prompt.text };
  for (const [key, raw] of Object.entries(plane.settings)) {
    if (omit.has(key)) continue;
    const wire = route.keys && key in route.keys ? route.keys[key] : snake(key);
    if (wire === null || wire === undefined) continue;
    const coerce = route.values?.[key];
    input[wire] = coerce ? coerce(raw) : raw;
  }
  Object.assign(input, route.constants?.all, route.constants?.[shape]);
  return input;
}

const DEFAULT_MEDIA: Record<KieShape, Partial<Record<MediaRole, string>>> = {
  text: {},
  image: { start: "image_url" },
  firstLast: { start: "first_frame_url", end: "last_frame_url" },
  reference: { reference: "image_urls", video: "video_urls", audio: "audio_urls" },
};

const SHAPE_ROLES: Record<KieShape, readonly MediaRole[]> = {
  text: [],
  image: ["start", "end"],
  firstLast: ["start", "end"],
  reference: ["reference", "video", "audio"],
};

const LIST_ROLES = new Set<MediaRole>(["reference", "video", "audio"]);

/** The media part of the wire body for a shape. */
export function mediaInput(
  plane: GenerationPlane,
  model: ModelEntry,
  shape: KieShape,
): Record<string, unknown> {
  const keys = { ...DEFAULT_MEDIA[shape], ...model.kie.media };
  const input: Record<string, unknown> = {};
  for (const role of SHAPE_ROLES[shape]) {
    const list = urls(plane, role);
    if (list.length === 0) continue;
    const key = keys[role];
    if (!key) {
      /* An end frame on a model whose image shape has no key for it: the
         catalog declared the role, so the wire must name it. */
      if (role === "end" && shape === "image") {
        throw new PlaneError(`${model.label} takes no end frame`);
      }
      throw new Error(`${model.id} declares the ${role} role but names no wire key for it`);
    }
    if (key.endsWith("[]")) input[key.slice(0, -2)] = list;
    else if (LIST_ROLES.has(role)) input[key] = list;
    else input[key] = list[0];
  }
  return input;
}

/** The shared mapper: shape from the media, model id from the route, body from
    settings and media. Enough for every family whose wire is a plain rename. */
export function mapByRoute(plane: GenerationPlane, model: ModelEntry): KieRequest {
  const shape = pickShape(plane, model);
  const kieModel = model.kie.models[shape];
  if (!kieModel) throw new Error(`${model.id} has no KIE model for the ${shape} shape`);
  return {
    model: kieModel,
    input: { ...settingsInput(plane, model, shape), ...mediaInput(plane, model, shape) },
  };
}
