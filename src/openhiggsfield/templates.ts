/* Prompt templates, the pure half: what a {{variable}} is, which names the
   product fills on its own, how a body lands in the prompt, and the starter
   pack a team copies into its library. No imports, so the server core and the
   composer read one definition — the bargain spend-periods.ts makes. */

export const TEMPLATE_SURFACES = ["image", "video", "any"] as const;
export type TemplateSurface = (typeof TEMPLATE_SURFACES)[number];

export const TEMPLATE_SURFACE_LABELS: Record<TemplateSurface, string> = {
  image: "Image",
  video: "Video",
  any: "Any",
};

export function isTemplateSurface(value: unknown): value is TemplateSurface {
  return (TEMPLATE_SURFACES as readonly unknown[]).includes(value);
}

/* What the actions cut a template down to, and what the forms let in. */
export const TEMPLATE_LIMITS = { title: 80, body: 4000, tags: 10, tag: 24 } as const;

/** A variable is a word in double braces — letters, digits and underscores,
    led by a letter — with spaces inside the braces tolerated. */
const VARIABLE = /\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g;

/** The variables a body asks for, in order of first appearance, each once. */
export function variablesOf(body: string): string[] {
  const seen: string[] = [];
  for (const match of body.matchAll(VARIABLE)) {
    const name = match[1]!;
    if (!seen.includes(name)) seen.push(name);
  }
  return seen;
}

/** The body with every variable it has a value for written in. One without a
    value stays exactly as typed, braces and all, so what could not be filled
    is still visible in the prompt rather than silently gone. */
export function fillTemplate(body: string, values: Readonly<Record<string, string | null | undefined>>): string {
  return body.replace(VARIABLE, (whole: string, name: string) => {
    const value = values[name];
    return typeof value === "string" ? value : whole;
  });
}

/** The names the product answers for without asking. */
export const RESERVED_VARIABLES = ["product", "offer_url", "brand_notes"] as const;
export type ReservedVariable = (typeof RESERVED_VARIABLES)[number];

export function isReservedVariable(name: string): name is ReservedVariable {
  return (RESERVED_VARIABLES as readonly string[]).includes(name);
}

/** The three facts of a product a template can lean on — the shape the
    workspace already carries for each product. */
export type ProductBrief = { name: string; offerUrl: string | null; brandNotes: string | null };

/** What the current product can fill: only the reserved names it holds a value
    for, so an offer url the product never got is asked for like any other
    variable rather than written in as nothing. */
export function reservedValues(product: ProductBrief | null | undefined): Partial<Record<ReservedVariable, string>> {
  if (!product) return {};
  const out: Partial<Record<ReservedVariable, string>> = {};
  const name = product.name.trim();
  if (name) out.product = name;
  const url = product.offerUrl?.trim();
  if (url) out.offer_url = url;
  const notes = product.brandNotes?.trim();
  if (notes) out.brand_notes = notes;
  return out;
}

/** The label a fill field carries: "offer_url" reads as "Offer url". */
export function variableLabel(name: string): string {
  const words = name.replace(/_+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Where a filled body goes: over the prompt, or after it when the visitor
    asked to append and there is something to append to. A blank line between,
    so two templates stay two paragraphs. */
export function insertIntoPrompt(current: string, body: string, append: boolean): string {
  const kept = current.trimEnd();
  if (!append || kept.length === 0) return body;
  return `${kept}\n\n${body}`;
}

/** A body on one line for a row's preview: every run of whitespace, line
    breaks included, folded to one space. */
export function oneLine(body: string): string {
  return body.replace(/\s+/g, " ").trim();
}

/** Whether a template answers a search: the words are looked for in the title,
    the body and the tags, case-insensitively. An empty query matches all. */
export function matchesTemplate(
  template: { title: string; body: string; tags: readonly string[] },
  query: string,
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return `${template.title} ${template.body} ${template.tags.join(" ")}`.toLowerCase().includes(q);
}

/** Tags as typed in one field, comma-separated: trimmed, lower-cased, with
    empty and repeated ones dropped. */
export function parseTags(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(",")) {
    const tag = raw.trim().toLowerCase();
    if (tag && !out.includes(tag)) out.push(tag);
  }
  return out;
}

export type StarterTemplate = {
  title: string;
  body: string;
  tags: readonly string[];
  surface: TemplateSurface;
};

/* The shapes a direct-response team shoots over and over, short and
   model-agnostic: each names the subject, the light and the frame and leaves
   the model's own dials to the composer. {{product}}, {{offer_url}} and
   {{brand_notes}} come from the product; the few other variables are the
   one detail each shape cannot guess. Copied into the team's library with one
   press, then edited there like anything else. */
export const STARTER_TEMPLATES: readonly StarterTemplate[] = [
  {
    title: "Product hero shot",
    surface: "image",
    tags: ["packshot", "hero"],
    body: "{{product}} on a clean seamless surface, soft studio key light with a gentle rim, packshot framing, label legible, no props, no text.",
  },
  {
    title: "Problem → agitate → solve hook",
    surface: "video",
    tags: ["hook", "pas"],
    body: "Open tight on someone stuck with the problem {{product}} solves. Hold the frustration a beat, then cut to the moment {{product}} fixes it. Handheld, natural light, a real home.",
  },
  {
    title: "Us vs them split",
    surface: "image",
    tags: ["comparison"],
    body: "Split frame with one hard vertical divide. Left: the old way, cluttered and dim. Right: {{product}}, clean and bright. Same angle and scale on both sides, no text.",
  },
  {
    title: "UGC testimonial talking head",
    surface: "video",
    tags: ["ugc", "testimonial"],
    body: "A real customer talks to a phone camera about {{product}}, eye level, kitchen or bathroom at home, slight handheld wobble, warm daylight, {{product}} in frame.",
  },
  {
    title: "Before / after",
    surface: "image",
    tags: ["before-after"],
    body: "Two panels, identical framing and light. Left: before. Right: after using {{product}}. Neutral background; the change is the only difference between them.",
  },
  {
    title: "Founder story",
    surface: "video",
    tags: ["founder", "story"],
    body: "The founder of {{product}} in their workshop, speaking to camera about why they built it. Medium shot, practical light, the product on the bench beside them.",
  },
  {
    title: "Unboxing",
    surface: "video",
    tags: ["unboxing"],
    body: "Overhead shot of hands opening the {{product}} box on a wooden table. Slow reveal, tissue paper, soft window light, unhurried pacing.",
  },
  {
    title: "Feature callout",
    surface: "image",
    tags: ["feature", "macro"],
    body: "Macro close-up of the {{feature}} on {{product}}, shallow depth of field, one directional light raking across the detail, dark backdrop.",
  },
  {
    title: "Lifestyle in use",
    surface: "any",
    tags: ["lifestyle"],
    body: "{{product}} in use in a real {{setting}}, candid and mid-action, golden hour, 35mm look, nobody looking at the camera. Keep to the brand notes: {{brand_notes}}",
  },
  {
    title: "Social proof wall",
    surface: "image",
    tags: ["social-proof", "reviews"],
    body: "A wall of {{product}} reviews as printed cards pinned to a corkboard, rows of five stars, warm office light, the product on a shelf beneath.",
  },
  {
    title: "Offer + CTA end card",
    surface: "image",
    tags: ["end-card", "cta"],
    body: "End card for {{product}}: the product centred on a solid brand-colour field, generous empty space above and below for a headline and {{offer_url}}, no other text.",
  },
  {
    title: "Objection handler",
    surface: "video",
    tags: ["objection"],
    body: "Someone says the top objection to {{product}} out loud — “{{objection}}” — and a friend answers it in one line while holding the product. Kitchen, daylight, two-shot.",
  },
];
