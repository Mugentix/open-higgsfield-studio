import { MODELS, parseSettings } from "@/generation/catalog";
import type { MediaItem, MediaRole, ModelEntry, Surface } from "@/generation/catalog";

export const SURFACES: readonly Surface[] = ["image", "video"];

export const SURFACE_LABELS: Record<Surface, string> = {
  image: "Image",
  video: "Video",
};

/** What the gallery is scoped to. "assets" is every run, both surfaces;
    "favorites" is every run the visitor kept, both surfaces. */
export type GalleryView = Surface | "assets" | "favorites";

/** Scopes that span both surfaces, so switching to them leaves the model alone. */
export const CROSS_VIEWS = new Set<GalleryView>(["assets", "favorites"]);

export const VIEWS: readonly GalleryView[] = ["image", "video", "assets", "favorites"];

export const VIEW_LABELS: Record<GalleryView, string> = {
  ...SURFACE_LABELS,
  assets: "Assets",
  favorites: "Favorites",
};

export const PROMPT_PLACEHOLDERS: Record<Surface, string> = {
  image: "Describe the image — subject, style, light, lens…",
  video: "Describe the shot — subject, camera move, light, pacing…",
};

/* The pool the empty state draws from. Each line is a whole prompt — subject,
   light, lens or camera move — so a click loads something worth pressing
   Generate on rather than a fragment to finish. */
export const SAMPLES: Record<Surface, string[]> = {
  image: [
    "Portrait of a beekeeper in a sunlit orchard, medium format film, shallow depth of field",
    "Isometric cutaway of a tiny recording studio, warm tungsten light, matte clay render",
    "Editorial still life: brutalist concrete vases with wild poppies, hard noon shadows",
    "Rain-slick alley at midnight, sodium lamps, reflections in every puddle, 35mm",
    "Studio portrait of an elderly luthier holding a half-built violin, single softbox, black backdrop",
    "Aerial top-down of salt evaporation ponds, pink and ochre geometry, midday clarity",
    "Cutaway illustration of a mechanical watch movement, blueprint lines on warm paper",
    "Overgrown modernist house reclaimed by ferns, overcast light, large format detail",
    "Matte ceramic espresso cup on wet slate, rim light, steam caught mid-curl",
    "1970s ski lodge interior, wood paneling and orange wool, low winter sun through glass",
    "Hands kneading dough on floured marble, window light, muted palette, close crop",
    "Desert observatory at blue hour, long exposure, star trails over a white dome",
  ],
  video: [
    "Slow aerial dolly over fog-covered pine forest at dawn, volumetric light through the canopy",
    "Macro shot of ink blooming in water, backlit, ultra slow motion, black backdrop",
    "Handheld tracking shot through a neon market at night, rain on lenses, shallow focus",
    "Locked-off shot of a diner at 3am, one customer, rain outside, sign flickering",
    "Slow push-in on a sculptor's hands shaping wet clay, north-facing window light",
    "Drone orbit around a lighthouse in heavy swell, grey sea, spray hitting the lens",
    "Timelapse of cloud shadows sweeping a canyon rim, golden hour into dusk",
    "Steadicam walk through an empty greenhouse, dust in shafts of light, slow reveal",
    "Whip pan from a spinning record to a dancer mid-turn, tungsten glow, heavy motion blur",
    "Underwater shot of a swimmer breaking the surface, bubbles, sunlight refracting",
    "Static wide of a train crossing a viaduct at dusk, lit windows, long lens compression",
    "Slow tilt down a glass tower facade to a busy crosswalk, overcast city light",
  ],
};

/** A few of the pool in a fresh order, so two visits are not handed the same
    shelf. Called on the client only — picking during render would give the
    server a different set than the hydrating client. */
export function pickSamples(surface: Surface, count = 3): string[] {
  const pool = [...SAMPLES[surface]];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }
  return pool.slice(0, count);
}

const SETTING_LABELS: Record<string, string> = {
  aspectRatio: "Aspect ratio",
  resolution: "Resolution",
  outputFormat: "Format",
  duration: "Duration",
  generateAudio: "Generate audio",
  batchSize: "Batch size",
  enhancePrompt: "Enhance prompt",
  thinking: "Thinking",
  numImages: "Images",
  sound: "Sound",
  cfgScale: "CFG",
  multiShots: "Multi-shot",
  keepOriginalSound: "Keep original sound",
  characterOrientation: "Orientation",
  backgroundSource: "Background",
  quality: "Quality",
  mode: "Mode",
  style: "Style",
  renderingSpeed: "Speed",
  expandPrompt: "Expand prompt",
  promptExtend: "Expand prompt",
  imageSize: "Size",
  audio: "Audio",
  background: "Background",
};

/* A pill carries one word; "Generate audio" is a panel label, not a control on
   a crowded rail. Only keys that read badly at pill length appear here. */
const SETTING_PILL_LABELS: Record<string, string> = {
  generateAudio: "Audio",
  expandPrompt: "Expand",
  promptExtend: "Expand",
};

export function settingLabel(key: string): string {
  return (
    SETTING_LABELS[key] ??
    key.replace(/([A-Z])/g, " $1").replace(/^./, (char) => char.toUpperCase())
  );
}

export function settingPillLabel(key: string): string {
  return SETTING_PILL_LABELS[key] ?? settingLabel(key);
}

/* Values arrive in the platform's own casing. Only the units conventionally
   set in caps are lifted; "720p" and "16:9" are already how they are written. */
export function settingValueLabel(key: string, value: unknown): string {
  if (typeof value === "boolean") return value ? "On" : "Off";
  if (typeof value === "number") return key === "duration" ? `${value}s` : String(value);
  const text = String(value);
  if (text === "auto") return "Auto";
  if (/^\d+k$/.test(text)) return text.toUpperCase();
  if (key === "outputFormat") return text.toUpperCase();
  /* A bare "2" on the rail says nothing; the factor is a multiplier. */
  if (key === "upscaleFactor") return `×${text}`;
  return text;
}

export const ROLE_LABELS: Record<MediaRole, string> = {
  start: "Start frame",
  end: "End frame",
  reference: "Reference",
  video: "Video",
  audio: "Audio",
};

/* Slate tags for the attachment tiles, where the full label will not fit. */
export const ROLE_TAGS: Record<MediaRole, string> = {
  start: "START",
  end: "END",
  reference: "REF",
  video: "VIDEO",
  audio: "AUDIO",
};

/* What a role can hold, in the coarser unit the asset library sorts by. The
   accept string above is the file dialog's business; this is the picker's. */
export type AssetKind = "image" | "video" | "audio";

export const ROLE_KINDS: Record<MediaRole, AssetKind> = {
  start: "image",
  end: "image",
  reference: "image",
  video: "video",
  audio: "audio",
};

/* The picker's confirm button names what it attaches — "Add 2 references",
   "Add start frame" — so each role carries its plural rather than taking an s. */
const ROLE_PLURALS: Record<MediaRole, string> = {
  start: "start frames",
  end: "end frames",
  reference: "references",
  video: "clips",
  audio: "audio tracks",
};

export function roleNoun(role: MediaRole, count: number): string {
  return count === 1 ? ROLE_LABELS[role].toLowerCase() : ROLE_PLURALS[role];
}

/** How many shelf tiles answer to a digit: Alt+1 … Alt+9. */
export const ASSET_KEYS = 9;

/** A product's shelf as the picker draws it and the digit keys count it: the
    files pinned to the product, of one kind, by slot and then newest first.
    One order for both, so the badge on a tile is the key that attaches it. */
export function productShelf<
  T extends { kind: AssetKind; productId: string | null; pin: number | null; createdAt: number },
>(assets: readonly T[], productId: string | null, kind: AssetKind): T[] {
  if (!productId) return [];
  return assets
    .filter((record) => record.kind === kind && record.productId === productId)
    .sort((a, b) => (a.pin ?? 99) - (b.pin ?? 99) || b.createdAt - a.createdAt);
}

/* Mirrors the allow-list in src/app/api/upload/route.ts. */
export const ROLE_ACCEPT: Record<MediaRole, string> = {
  start: "image/jpeg,image/png,image/webp,image/gif",
  end: "image/jpeg,image/png,image/webp,image/gif",
  reference: "image/jpeg,image/png,image/webp,image/gif",
  video: "video/mp4,video/quicktime",
  audio: "audio/wav,audio/x-wav,audio/mpeg",
};

/** Whether the file dialog's allow-list for the role covers this file — the
    same test the dialog applied, for files that arrive by drop instead. */
export function roleAccepts(role: MediaRole, file: { type: string }): boolean {
  return ROLE_ACCEPT[role].split(",").includes(file.type);
}

/** The browser reports a MIME type; the shelf sorts by the coarse kind the
    picker's tabs are cut along. */
export function kindOfFile(file: { type: string }): AssetKind {
  if (file.type.startsWith("video/")) return "video";
  if (file.type.startsWith("audio/")) return "audio";
  return "image";
}

export function rolesOf(model: ModelEntry): MediaRole[] {
  return Object.keys(model.roles) as MediaRole[];
}

/* The wire carries two groups: a frame is one url under its own key, while
   the reference, video and audio roles are ordered lists the prompt addresses
   by position. The strip numbers the lists; the exclusive entries refuse the
   two groups together. */
export const FRAME_ROLES: readonly MediaRole[] = ["start", "end"];
export const LIST_ROLES: readonly MediaRole[] = ["reference", "video", "audio"];

/** The roles the composer must refuse right now, each with the line that says
    why. On an entry declaring `exclusive`, every frame role is blocked while a
    reference of any kind is attached, and every list role while a frame is —
    the same refusal pickShape in to-kie/shared.ts makes at submit, raised to
    the moment of attaching. Everything else is open. */
export function blockedRoles(
  model: ModelEntry,
  items: readonly MediaItem[],
): Partial<Record<MediaRole, string>> {
  if (model.exclusive !== "frames-or-references") return {};
  const held = new Set<MediaRole>();
  for (const item of items) if (model.roles[item.role]) held.add(item.role);
  const frames = FRAME_ROLES.filter((role) => held.has(role));
  const refs = LIST_ROLES.filter((role) => held.has(role));
  const blocked: Partial<Record<MediaRole, string>> = {};
  for (const role of rolesOf(model)) {
    const isFrame = FRAME_ROLES.includes(role);
    const other = isFrame ? refs : frames;
    if (other.length === 0) continue;
    const remove = isFrame
      ? "the references"
      : frames.length > 1
        ? "the frames"
        : `the ${roleNoun(frames[0]!, 1)}`;
    const add = isFrame ? `${role === "end" ? "an" : "a"} ${roleNoun(role, 1)}` : roleNoun(role, 2);
    blocked[role] = `${model.label} takes either frames or references — remove ${remove} to add ${add}`;
  }
  return blocked;
}

/** A tile published from a skill run carries no plane: its model id names
    the skill ("agent:<slug>"), nothing the composer could replay. It is still
    a picture, so it attaches as an input like any other result. */
export function hasPlane(record: { modelId: string }): boolean {
  return !record.modelId.startsWith("agent:");
}

/** The refusal a plane already carries: an exclusive entry holding a frame
    and a reference at once — attached before the rule was raised, or carried
    over from another model — cannot be sent, and Generate says so before
    pickShape would. Null when the plane is sendable. */
export function planeConflict(model: ModelEntry, items: readonly MediaItem[]): string | null {
  if (model.exclusive !== "frames-or-references") return null;
  const held = new Set<MediaRole>();
  for (const item of items) if (model.roles[item.role]) held.add(item.role);
  const frames = FRAME_ROLES.filter((role) => held.has(role));
  const refs = LIST_ROLES.filter((role) => held.has(role));
  if (frames.length === 0 || refs.length === 0) return null;
  const frameWord = frames.length > 1 ? "the frames" : `the ${roleNoun(frames[0]!, 1)}`;
  return `${model.label} takes either frames or references — remove ${frameWord} or the references before generating`;
}

/** The role a drop on the composer fills. Slots with room that the plane does
    not block come first; when only blocked slots have room, one of those is
    handed back so the upload refuses with the reason rather than the drop
    going silent. Within the pool the files' kind picks the role — and a batch
    can only mean a list role, so several images pass the one-slot start frame
    for the references, while a single image still lands on the frame. Null
    when every slot is taken. */
export function dropRoleFor(
  model: ModelEntry,
  items: readonly MediaItem[],
  files: readonly { type: string }[],
): MediaRole | null {
  const kind = files[0] ? kindOfFile(files[0]) : null;
  const blocked = blockedRoles(model, items);
  const room = rolesOf(model).filter(
    (role) => items.filter((item) => item.role === role).length < (model.roles[role] ?? 0),
  );
  const open = room.filter((role) => !blocked[role]);
  const pool = open.length > 0 ? open : room;
  const ofKind = pool.filter((role) => ROLE_KINDS[role] === kind);
  const lists = ofKind.filter((role) => (model.roles[role] ?? 0) > 1);
  return (files.length > 1 ? lists[0] : undefined) ?? ofKind[0] ?? pool[0] ?? null;
}

/** Whether an entry's list roles hold more than one item in all. Below that a
    "1" says nothing — an upscaler's single image is not Image 1 of anything —
    so neither the strip nor the picker numbers it. */
export function numbersInputs(roles: ModelEntry["roles"]): boolean {
  let slots = 0;
  for (const role of LIST_ROLES) slots += roles[role] ?? 0;
  return slots > 1;
}

export type NumberedItem = {
  item: MediaItem;
  n?: number;
  /** Whether assemblePlane sends it: the store keeps what a wider model took,
      but each role goes to KIE only up to this entry's cap. */
  sent: boolean;
};

/** Each attachment with the position the wire gives it: "REF 2" is
    reference_image_urls[1], exactly what the prompt's "Image 2" means to the
    model. Counted per role in the order held; frames carry no number, nothing
    is numbered on an entry whose lists hold one item in all, and an item past
    the role's cap is not sent, so it carries no number either. */
export function numberedItems(items: readonly MediaItem[], roles: ModelEntry["roles"]): NumberedItem[] {
  const numbered = numbersInputs(roles);
  const counts: Partial<Record<MediaRole, number>> = {};
  return items.map((item) => {
    const at = counts[item.role] ?? 0;
    counts[item.role] = at + 1;
    const sent = at < (roles[item.role] ?? 0);
    if (!numbered || !sent || !LIST_ROLES.includes(item.role)) return { item, sent };
    return { item, n: at + 1, sent };
  });
}

/* How the prompt names a list role's first item, per KIE's docs for the
   families that take several: Seedance's "Image 1 / Video 1 / Audio 1",
   Flux and Happy Horse's "image 1". */
const ORDER_WORDS: Record<MediaRole, string> = {
  start: "",
  end: "",
  reference: "Image 1",
  video: "Video 1",
  audio: "Audio 1",
};

/** The line under the strip once a numbered input is attached: how to point
    the prompt at what the numerals show. Derived from the roles the entry
    declares, so a references-only model is not told about Audio 1. */
export function orderHint(model: ModelEntry): string {
  const names = LIST_ROLES.filter((role) => model.roles[role]).map((role) => ORDER_WORDS[role]);
  if (names.length <= 1) return "Refer to references as Image 1, Image 2… in the prompt.";
  return `Refer to inputs as ${names.join(", ")} in the prompt.`;
}

export function defaultRole(model: ModelEntry): MediaRole {
  if (model.surface === "image" && model.roles.reference) return "reference";
  if (model.roles.start) return "start";
  return rolesOf(model)[0] ?? "reference";
}

const RATIO = /^(\d+):(\d+)$/;

/** The mini rectangle a ratio value draws, scaled into a 14px optical box —
    null when the value is not a ratio ("auto"), so the caller can reserve the
    slot or draw a plain frame instead. */
export function ratioBox(value: string): { width: number; height: number } | null {
  const match = RATIO.exec(value);
  if (!match) return null;
  const w = Number(match[1]);
  const h = Number(match[2]);
  const scale = 14 / Math.max(w, h);
  return { width: Math.max(5, Math.round(w * scale)), height: Math.max(5, Math.round(h * scale)) };
}

export function ratioToCss(value: unknown, fallback: string): string {
  const match = RATIO.exec(String(value ?? ""));
  return match ? `${match[1]} / ${match[2]}` : fallback;
}

/* Two roles share one word — a start and an end frame are both frames — so the
   phrases dedupe before they are listed. */
const ROLE_PHRASES: Record<MediaRole, string> = {
  start: "frames",
  end: "frames",
  reference: "references",
  video: "clips",
  audio: "audio",
};

function joinPhrases(parts: string[]): string {
  if (parts.length < 2) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} or ${parts[parts.length - 1]}`;
}

/** The line under a model's name in the picker, derived from the entry itself:
    what it makes, what it takes, where its allow-lists top out. The catalog
    stays the only place a model's truth is written down. */
export function describeModel(model: ModelEntry): string {
  const noun = model.surface === "image" ? "Images" : "Video";
  const inputs = [...new Set(rolesOf(model).map((role) => ROLE_PHRASES[role]))];
  const source =
    model.prompt === "none"
      ? `${noun} from ${joinPhrases(inputs.map((phrase) => phrase.replace(/^a /, "one ")))}, no prompt`
      : inputs.length
        ? `${noun} from a prompt, ${joinPhrases(inputs)}`
        : `${noun} from a prompt`;

  const limits: string[] = [];
  const resolution = model.settings.resolution;
  /* The catalog declares resolutions in ascending order, so the ceiling is the
     last value it lists. */
  if (resolution?.type === "enum" && resolution.values.length > 0) {
    const top = resolution.values[resolution.values.length - 1]!;
    limits.push(`to ${settingValueLabel("resolution", top)}`);
  }
  const duration = model.settings.duration;
  if (duration?.type === "range") limits.push(`${duration.min}–${duration.max}s`);

  return limits.length ? `${source} · ${limits.join(", ")}` : source;
}

/* The composer shows one batch control whatever the model is: where the
   catalog names a `countKey` it writes that setting and the platform answers
   with that many media; every other model is submitted once per result. The
   key named there is claimed by the batch control and never also drawn as a
   settings pill, so the studio's count and the model's own can never disagree. */
export type CountSetting = {
  key: string;
  /** How the value is written back: an enum stores the count as the string the
      catalog declared, a range stores it as a number. */
  kind: "enum" | "range";
  /** Every count the model allows, ascending. The control walks this list, so a
      model offering only 1 or 4 can never be left on an illegal 2. */
  counts: number[];
};

export function countSetting(model: ModelEntry): CountSetting | null {
  const key = model.countKey;
  if (!key) return null;
  const field = model.settings[key];
  if (field?.type === "range") {
    const counts: number[] = [];
    for (let n = field.min; n <= field.max; n++) counts.push(n);
    return { key, kind: "range", counts };
  }
  if (field?.type === "enum") {
    const counts = field.values.map(Number).filter(Number.isInteger).sort((a, b) => a - b);
    if (counts.length > 0) return { key, kind: "enum", counts };
  }
  return null;
}

/* The two or three facts that summarise a run at a glance, in the same casing
   the settings panel and the viewer write them — the grid draws these as
   separate chips by splitting on the separator. */
export function metaOf(model: ModelEntry, values: Record<string, unknown>): string {
  const label = (key: string) =>
    values[key] === undefined ? null : settingValueLabel(key, values[key]);
  const size = values.resolution !== undefined ? label("resolution") : label("quality");
  const audio = values.generateAudio === true || values.audio === true || values.sound === true;
  const parts =
    model.surface === "image"
      ? [size, label("outputFormat")]
      : [size, label("duration"), audio ? "Audio" : null];
  return parts.filter(Boolean).join(" · ");
}

/* A utility run has no prompt, so the studio writes its own tile line — what
   was done to the input, and by how much. The entry names the line; a factor
   in the settings is appended; an entry without a line signs with its label.
   The mapper keeps the line off the wire. */
export function utilityLine(model: ModelEntry, values: Record<string, unknown>): string {
  const line = model.tool?.line ?? model.label;
  const factor = values.upscaleFactor;
  return typeof factor === "string" ? `${line} ×${factor}` : line;
}

/* The tools a finished tile runs in one press, by the kind of media it is:
   every promptless entry that declares a key, submitted with its defaults, so
   the row's label and the tile's caption come from the same line. The key is
   the letter as event.key reports it, lower-case. */
export type TileTool = { modelId: string; label: string; key: string };

function toolsFor(kind: "image" | "video"): readonly TileTool[] {
  const tools: TileTool[] = [];
  for (const entry of MODELS) {
    if (entry.prompt !== "none" || !entry.tool?.key) continue;
    const roles = rolesOf(entry);
    if (roles.length !== 1 || ROLE_KINDS[roles[0]!] !== kind) continue;
    tools.push({ modelId: entry.id, label: utilityLine(entry, parseSettings(entry, {})), key: entry.tool.key });
  }
  return tools;
}

export const TILE_TOOLS: Record<"image" | "video", readonly TileTool[]> = {
  image: toolsFor("image"),
  video: toolsFor("video"),
};

export function tileTool(kind: "image" | "video", key: string): TileTool | undefined {
  return TILE_TOOLS[kind].find((tool) => tool.key === key);
}

/** The letters a tile answers to, for the hint on its Use control. */
export function tileKeyHint(kind: "image" | "video"): string {
  return ["R", "S", "E", "V", ...TILE_TOOLS[kind].map((tool) => tool.key.toUpperCase())].join(" · ");
}

export function durationBadge(values: Record<string, unknown>): string | undefined {
  if (typeof values.duration !== "number") return undefined;
  return formatClock(values.duration);
}

export function formatClock(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = Math.max(0, Math.round(totalSeconds - m * 60));
  return `${m}:${String(s).padStart(2, "0")}`;
}

/* ---------- verdicts ---------- */

/* The team's call on a creative: three words, stored on the result as typed
   here and asked for by the same word in the filter. Null until someone makes
   it; team-wide, like a favorite, so whoever spoke last is what the row keeps. */
export type Verdict = "winner" | "testing" | "killed";

export const VERDICTS: readonly Verdict[] = ["winner", "testing", "killed"];

export const VERDICT_LABELS: Record<Verdict, string> = {
  winner: "Winner",
  testing: "Testing",
  killed: "Killed",
};

/** The letter each verdict answers to on a hovered tile and in the viewer, as
    event.key reports it, lower-case — the same convention as TileTool.key. W
    and T lead their words; X, the cross, is killed. */
export const VERDICT_KEYS: Record<Verdict, string> = {
  winner: "w",
  testing: "t",
  killed: "x",
};

export function isVerdict(value: unknown): value is Verdict {
  return typeof value === "string" && (VERDICTS as readonly string[]).includes(value);
}

export function verdictOfKey(key: string): Verdict | undefined {
  return VERDICTS.find((verdict) => VERDICT_KEYS[verdict] === key);
}

/** The facet's fourth answer: tiles nobody has judged yet. */
export type VerdictFilter = Verdict | "none";

export const VERDICT_FILTERS: readonly VerdictFilter[] = [...VERDICTS, "none"];

export const VERDICT_FILTER_LABELS: Record<VerdictFilter, string> = {
  winner: "Winners",
  testing: "Testing",
  killed: "Killed",
  none: "No verdict",
};

export function isVerdictFilter(value: unknown): value is VerdictFilter {
  return value === "none" || isVerdict(value);
}

/** How far a note runs; the action refuses anything longer. */
export const NOTE_LIMIT = 500;

/** What a record carries of the call: every tile does, a legacy RunRecord
    never did. The grid, the viewer and Compare read it off whatever they are
    handed, so the older shape still fits them. */
export type Judged = { verdict?: Verdict | null; note?: string | null };
