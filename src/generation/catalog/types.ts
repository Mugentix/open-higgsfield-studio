export type Surface = "image" | "video";
export type MediaRole = "start" | "end" | "reference" | "video" | "audio";

export type MediaItem = {
  id: string;
  url: string;
  role: MediaRole;
  /** The team asset or result this url belongs to, when it is one of ours:
      the server records the lineage and resolves the durable copy. */
  assetId?: string;
  resultId?: string;
};

export type SettingField =
  | { type: "enum"; values: readonly string[]; default: string }
  | { type: "range"; min: number; max: number; default: number; step?: number }
  | { type: "boolean"; default: boolean };

/** The shape of one submit, read off the media the plane carries: nothing
    (text), a start frame (image), start and/or end frames (firstLast), or
    references of any kind (reference). */
export type KieShape = "text" | "image" | "firstLast" | "reference";

/** What goes to POST /api/v1/jobs/createTask. */
export type KieRequest = {
  model: string;
  input: Record<string, unknown>;
};

/** How an entry reaches KIE. Everything but `models` is optional: the shared
    mapper in src/generation/to-kie fills in the conventional wire keys. Families
    whose wire is too odd for that register a custom mapper there instead, and
    still list every KIE model id they submit to under `models`, so the studio
    can tell the result's kind from the id KIE echoes back. */
export type KieRoute = {
  /** KIE model id per shape. A shape with no id is not offered by the entry. */
  models: Partial<Record<KieShape, string>>;
  /** Wire key per media role. A "[]" suffix wraps a frame in an array; the
      reference, video and audio roles are always arrays. Defaults: image_url,
      first_frame_url / last_frame_url, image_urls, video_urls, audio_urls. */
  media?: Partial<Record<MediaRole, string>>;
  /** Setting key → wire key. The default is the snake_case of the key; null
      keeps a setting off the wire entirely. */
  keys?: Record<string, string | null>;
  /** Value coercions per setting key, applied after parseSettings — casing,
      numbers that KIE wants as strings, snapping to the values KIE allows. */
  values?: Record<string, (value: unknown) => unknown>;
  /** Settings not sent in a shape, e.g. aspect_ratio once a start frame decides it. */
  omit?: Partial<Record<KieShape, readonly string[]>>;
  /** Constant wire fields, for every shape or one. */
  constants?: Partial<Record<KieShape | "all", Record<string, unknown>>>;
  /** How long the studio waits on a task before calling it lost. Default 10 min. */
  deadlineMs?: number;
  /** false keeps the entry out of the picker until a live probe proved the route. */
  enabled?: boolean;
};

export type KieMapper = (plane: GenerationPlane, model: ModelEntry) => KieRequest;

export type ModelEntry = {
  id: string;
  surface: Surface;
  label: string;
  roles: Partial<Record<MediaRole, number>>;
  settings: Record<string, SettingField>;
  kie: KieRoute;
  /** A setting that already means "results per request". The composer's batch
      control writes it, and it is never also drawn as a settings pill. */
  countKey?: string;
  /** "none" marks a utility that takes no prompt — an upscaler, a background
      remover. The composer hides the textarea and enables Generate on the
      media alone, the plane's prompt text may be empty, and the mapper keeps
      whatever text the studio wrote for the tile off the wire. */
  prompt?: "none";
  /** How a promptless entry signs its tiles and, with a key, earns a row in a
      tile's Use menu beside R/S/E/V: `line` is what was done to the input
      ("Upscale", "Background removed"; the factor is appended from the
      settings), `key` the lower-case letter that runs it on the hovered tile. */
  tool?: { line: string; key?: string };
  /** Frames and references are two products on the wire, never one submit.
      KIE's Seedance 2.5 doc: first_frame_url "cannot be used simultaneously
      with reference_image_urls, reference_video_urls, or reference_audio_urls".
      Set on every entry whose mapper refuses the pair (pickShape in
      to-kie/shared.ts, or the family's own check), so the composer can block
      the second group before the press instead of failing at submit.
      tests/catalog-exclusive.test.ts holds the flag to the mapper. */
  exclusive?: "frames-or-references";
};

export type GenerationPlane = {
  model: string;
  prompt: { text: string };
  media: Partial<Record<MediaRole, MediaItem[]>>;
  settings: Record<string, unknown>;
};
