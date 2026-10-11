import { blockedRoles } from "@/openhiggsfield/data";

import { MODELS, getModel, type MediaRole, type ModelEntry } from "./catalog";
import { addToRole, type Attachment } from "./media-roles";
import { useActive } from "./stores/active";
import { useImageMedia, useVideoMedia } from "./stores/media";

/* A result on the wall becomes the next run's input in one press. If the
   model in the composer takes the role, it lands there; otherwise the model
   that takes it is picked and switched to, so the press never dead-ends. */

export type UseTarget = { role: MediaRole; label: string; modelLabel?: string };

export const ROLE_WORDS: Record<MediaRole, string> = {
  reference: "Reference",
  start: "Start frame",
  end: "End frame",
  video: "Video input",
  audio: "Audio",
};

const ROLES_BY_KIND: Record<"image" | "video", MediaRole[]> = {
  image: ["reference", "start", "end"],
  video: ["video"],
};

/** The model that takes a role for the composer's current pick: itself when
    it can, else the nearest on the same surface, else any that can. A
    promptless utility is never chosen on the visitor's behalf — "use as
    reference" means a generation from it, not an upscale of it — though one
    already in the composer keeps the slot it declares. */
export function modelFor(role: MediaRole, current: ModelEntry): ModelEntry | null {
  if (current.roles[role]) return current;
  const able = MODELS.filter((entry) => entry.roles[role] && entry.prompt !== "none");
  return able.find((entry) => entry.surface === current.surface) ?? able[0] ?? null;
}

/** What a tile of this kind can be used as, given the model in the composer. */
export function useTargetsFor(kind: "image" | "video", current: ModelEntry): UseTarget[] {
  const targets: UseTarget[] = [];
  for (const role of ROLES_BY_KIND[kind]) {
    const target = modelFor(role, current);
    if (!target) continue;
    targets.push({
      role,
      label: ROLE_WORDS[role],
      ...(target.id !== current.id ? { modelLabel: target.label } : {}),
    });
  }
  return targets;
}

export type AttachOutcome = {
  target: ModelEntry;
  switched: boolean;
  /** The slot was already full; nothing was added. */
  full: boolean;
  /** The target takes either frames or references and already holds the other
      group; nothing was added and the model was not switched. The line says
      what to remove. */
  blocked?: string;
};

/** One input — a result or a shelf asset, with whatever lineage the caller
    knows — into the role, on the model that takes it. On an exclusive entry
    the other group already on the plane blocks the press: the same rule the
    composer's tray disables slots by, read off the target's own store. */
export function attachInput(entry: Attachment, role: MediaRole): AttachOutcome | null {
  const current = getModel(useActive.getState().model);
  const target = modelFor(role, current);
  if (!target) return null;
  const store = target.surface === "image" ? useImageMedia : useVideoMedia;
  const blocked = blockedRoles(target, store.getState().items)[role];
  if (blocked) return { target, switched: false, full: false, blocked };
  if (target.id !== current.id) useActive.getState().setModel(target.id);
  const outcome = addToRole(store, role, [entry], target.roles[role] ?? 0);
  return { target, switched: target.id !== current.id, full: outcome.added === 0 && outcome.left > 0 };
}

export function attachResult(
  item: { id: string; url: string; kind: "image" | "video" },
  role: MediaRole,
): AttachOutcome | null {
  return attachInput({ url: item.url, resultId: item.id }, role);
}
