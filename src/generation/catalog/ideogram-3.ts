import type { ModelEntry } from "./types";
import { IMAGE_DEADLINE_MS } from "./tokens";
import { upper } from "../to-kie/values";

/* Text goes to v3-text-to-image; a reference goes to ideogram/character,
   which honours exactly one image. Both size by image_size (orientation names,
   no aspect ratio or resolution). The style list is the intersection of the
   two models' enums: v3 adds GENERAL and DESIGN, character adds FICTION, and
   only AUTO and REALISTIC are legal on both. KIE spells these in capitals; the
   catalog keeps the studio's lowercase and lifts the casing on the wire. */
const IDEOGRAM_IMAGE_SIZE = [
  "square",
  "square_hd",
  "portrait_4_3",
  "portrait_16_9",
  "landscape_4_3",
  "landscape_16_9",
] as const;

export const ideogram3: ModelEntry = {
  id: "ideogram-3",
  surface: "image",
  label: "Ideogram 3",
  roles: { reference: 1 },
  settings: {
    imageSize: { type: "enum", values: IDEOGRAM_IMAGE_SIZE, default: "square_hd" },
    renderingSpeed: { type: "enum", values: ["turbo", "balanced", "quality"], default: "balanced" },
    style: { type: "enum", values: ["auto", "realistic"], default: "auto" },
    expandPrompt: { type: "boolean", default: true },
  },
  kie: {
    models: { text: "ideogram/v3-text-to-image", reference: "ideogram/character" },
    media: { reference: "reference_image_urls" },
    values: { renderingSpeed: upper, style: upper },
    deadlineMs: IMAGE_DEADLINE_MS,
  },
};
