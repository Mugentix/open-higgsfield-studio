"use client";

import { useRef, useState } from "react";
import type { DragEvent, ReactNode } from "react";

import type { MediaItem, MediaRole, ModelEntry } from "@/generation/catalog";
import { addToRole, replaceRole } from "@/generation/media-roles";
import { useImageMedia, useVideoMedia } from "@/generation/stores/media";
import { uploadMedia } from "@/generation/upload";
import type { AssetRecord } from "@/server/asset-actions";

import { useAssets } from "./asset-data";
import {
  blockedRoles,
  dropRoleFor,
  kindOfFile,
  numberedItems,
  orderHint,
  planeConflict,
  ROLE_ACCEPT,
  ROLE_KINDS,
  ROLE_LABELS,
  ROLE_TAGS,
  roleAccepts,
  roleNoun,
  rolesOf,
} from "./data";
import { AudioIcon, CaretDownIcon, CloseIcon, VideoIcon } from "./icons";
import { uploadPool } from "./upload-pool";

/* Both surfaces' stores are read on every render so the hook order holds
   across a model swap; the one the model's surface names is the tray's. */
function useMedia(model: ModelEntry) {
  const image = useImageMedia();
  const video = useVideoMedia();
  return model.surface === "image"
    ? { state: image, store: useImageMedia }
    : { state: video, store: useVideoMedia };
}

/** Where a batch lands once uploaded: on the plane straight away (a drop on
    the composer), or staged for the picker, which applies the set in one
    press. Either way every file also joins the team's shelf. */
export type UploadTarget = "plane" | "picker";

export type UploadProgress = { done: number; total: number };

/** What stands behind an attached url, when the studio knows: the team asset
    of an upload or the result of a run. The server resolves either to a file. */
export type Lineage = { assetId?: string; resultId?: string };

export interface MediaTray {
  roles: MediaRole[];
  /** The current surface's attachments, so the picker can derive its own caps
      from the same list the strip below renders. */
  items: MediaItem[];
  /** Every file the team holds, newest first. */
  uploads: AssetRecord[];
  /** The URLs the last batch uploaded from the picker, in upload order, and
      the role they were sent for. They go onto the shelf and into the panel's
      selection, not onto the plane — the panel stages the whole set and one
      press applies it. A new array on every arrival, so the panel sees each. */
  staged: string[];
  stagedRole: MediaRole | null;
  uploading: boolean;
  /** Files settled so far out of the batch, while a pool runs. */
  progress: UploadProgress | null;
  /** One line about the files a batch set aside — the wrong kind for the role,
      or more than a single slot takes. Cleared when the next batch begins. */
  note: string | null;
  /** Roles the model cannot take right now, with the reason: on an entry that
      takes either frames or references, the group already on the plane blocks
      the other. Read by the picker's slots, the attach tip and the drops. */
  blocked: Partial<Record<MediaRole, string>>;
  allFull: boolean;
  /** Hidden file input; render it once inside the composer. */
  input: ReactNode;
  /** Set the role the next files take, then open the OS picker. Refuses a
      blocked role with its reason on the error line. */
  begin: (role: MediaRole) => void;
  /** Upload a batch for a role — from a drop, or the OS picker. */
  upload: (role: MediaRole, files: File[], target: UploadTarget) => void;
  /** The role a drop on the composer should fill: the first with room that is
      not blocked and takes the files' kind — a list role when several files
      came at once — else the first with room, else null when every slot is
      taken. */
  dropRole: (files: File[]) => MediaRole | null;
  /** Make the role's inputs exactly these URLs, in this order — the picker
      hands back the set it edited, so one press both attaches and detaches.
      Past the role's cap the first ones are kept and the surplus reported. */
  apply: (role: MediaRole, urls: string[], lineage?: (url: string) => Lineage) => void;
  /** Re-read the team's shelf after something changed it. */
  refreshAssets: () => void;
}

export function useMediaTray(
  model: ModelEntry,
  onError: (message: string | null) => void,
): MediaTray {
  const media = useMedia(model);
  const { assets, remember, refresh } = useAssets();
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const [staged, setStaged] = useState<string[]>([]);
  const [stagedRole, setStagedRole] = useState<MediaRole | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const roleRef = useRef<MediaRole>("reference");
  const inputRef = useRef<HTMLInputElement>(null);
  /* Batches up at once: the composer's drop zone never closes, so a second
     drop can start while the first is still going, and the flags above are
     shared by every batch in flight. */
  const inFlight = useRef(0);

  const roles = rolesOf(model);
  const items = media.state.items;
  const counts: Record<string, number> = {};
  for (const role of roles) {
    counts[role] = items.filter((item) => item.role === role).length;
  }
  const allFull = roles.length > 0 && roles.every((role) => counts[role]! >= (model.roles[role] ?? 0));
  const blocked = blockedRoles(model, items);

  async function upload(role: MediaRole, incoming: File[], target: UploadTarget) {
    const reason = blocked[role];
    if (reason) {
      onError(reason);
      return;
    }
    const cap = model.roles[role] ?? 0;
    /* The dialog filtered by MIME; a drop did not. Wrong kinds are set aside
       with one line rather than each failing on the server in turn, and a
       single-slot role takes one file — a second start frame has nowhere to go. */
    const accepted = incoming.filter((file) => roleAccepts(role, file));
    const wrongKind = incoming.length - accepted.length;
    const files = cap <= 1 ? accepted.slice(0, 1) : accepted;
    const surplus = accepted.length - files.length;
    const skipped = skippedLine(wrongKind, surplus, role);
    setNote(skipped);
    /* The picker shows the note itself; a drop on the composer has no panel
       to show it in, so there it takes the error line. */
    if (files.length === 0) {
      if (target === "plane" && skipped) onError(skipped);
      return;
    }

    onError(null);
    /* A batch joining one already up adds its files to the count the label
       reads; only the last batch to finish clears the flags. */
    const first = inFlight.current === 0;
    inFlight.current += 1;
    if (first) setStaged([]);
    setUploading(true);
    setProgress((prev) =>
      prev && !first ? { ...prev, total: prev.total + files.length } : { done: 0, total: files.length },
    );
    /* Three go up at once, so arrivals are out of order; the staged list is
       rebuilt in the files' order on each, and Image 1 stays the first file.
       The role travels with each list, so two batches for two slots at once
       are told apart by the panel. */
    const urls: (string | undefined)[] = new Array(files.length);
    const results = await uploadPool(files, uploadMedia, {
      onSettled: (result, index) => {
        setProgress((prev) => (prev ? { ...prev, done: prev.done + 1 } : prev));
        if (result.error !== undefined || !result.url || !result.assetId) return;
        /* The file outlives this run: it joins the team's shelf, so a reference
           used once can be reached again by anyone without a second upload. */
        remember({
          id: result.assetId,
          url: result.url,
          kind: kindOfFile(result.file),
          name: result.file.name,
          productId: null,
          pin: null,
          createdAt: Date.now(),
        });
        urls[index] = result.url;
        setStagedRole(role);
        setStaged(urls.filter((url): url is string => url !== undefined));
      },
    });
    inFlight.current -= 1;
    if (inFlight.current === 0) {
      setUploading(false);
      setProgress(null);
    }
    refresh();

    const lines: string[] = [];
    const landed = results.filter((result) => result.url && result.assetId);
    const failed = results.filter((result) => result.error !== undefined);
    if (failed.length > 0) {
      const names = failed.map((result) => result.file.name).join(", ");
      const why = failed[0]!.error;
      lines.push(
        failed.length === results.length
          ? `Upload failed for ${names} — ${why}. Retry, or drop the file and generate from the prompt alone.`
          : `Upload failed for ${names} — ${why}. The other ${landed.length} landed on the shelf.`,
      );
    }
    if (target === "plane") {
      if (landed.length > 0) {
        /* The plane may have changed while the files were up — a frame put on
           it from the wall blocks the references they were for — so the rule
           is read again now, not only at the drop. The files are on the shelf
           either way. */
        const reason = blockedRoles(model, media.store.getState().items)[role];
        if (reason) {
          lines.push(`${reason}. The ${landed.length === 1 ? "file is" : "files are"} on the Uploads shelf.`);
        } else {
          const outcome = addToRole(
            media.store,
            role,
            landed.map((result) => ({ url: result.url!, assetId: result.assetId! })),
            cap,
          );
          if (outcome.left > 0) lines.push(surplusLine(model, role, cap));
        }
      }
      if (skipped) lines.push(skipped);
    }
    if (lines.length > 0) onError(lines.join(" "));
  }

  /* accept is set on the element rather than through state: the picker opens in
     the same tick as the choice, before React could re-render it. */
  function begin(role: MediaRole) {
    const reason = blocked[role];
    if (reason) {
      onError(reason);
      return;
    }
    const element = inputRef.current;
    if (!element) return;
    roleRef.current = role;
    element.accept = ROLE_ACCEPT[role];
    element.click();
  }

  const input = (
    <input
      ref={inputRef}
      type="file"
      hidden
      multiple
      onChange={(event) => {
        const files = Array.from(event.target.files ?? []);
        event.target.value = "";
        void upload(roleRef.current, files, "picker");
      }}
    />
  );

  function dropRole(files: File[]): MediaRole | null {
    return dropRoleFor(model, items, files);
  }

  /* A replace, not an append: the panel edits one role's whole set, so what it
     hands back decides both what arrives and what leaves — and in what order,
     because the order ticked is the order the wire numbers. */
  function apply(role: MediaRole, urls: string[], lineage?: (url: string) => Lineage) {
    /* The slot was open when the panel opened; a frame dropped on the composer
       since can have closed it, so the rule is read at the press too. A set
       emptied out is a removal and always goes through. */
    if (urls.length > 0) {
      const reason = blockedRoles(model, media.store.getState().items)[role];
      if (reason) {
        onError(reason);
        return;
      }
    }
    const cap = model.roles[role] ?? 0;
    let set = urls;
    if (cap > 0 && urls.length > cap) {
      set = urls.slice(0, cap);
      onError(surplusLine(model, role, cap));
    }
    replaceRole(media.store, role, set, (url) => {
      const known = lineage?.(url) ?? {};
      if (known.assetId || known.resultId) return known;
      const asset = assets.find((record) => record.url === url);
      return asset ? { assetId: asset.id } : {};
    });
    /* What survived kept its place; walking the set from the front puts every
       item where the panel showed it, so the strip's REF 2 is the panel's 2. */
    const { items: held, move } = media.store.getState();
    set.forEach((url, index) => {
      const item = held.find((entry) => entry.role === role && entry.url === url);
      if (item) move(item.id, index);
    });
  }

  return {
    roles,
    items,
    uploads: assets,
    staged,
    stagedRole,
    uploading,
    progress,
    note,
    blocked,
    allFull,
    input,
    begin,
    upload,
    dropRole,
    apply,
    refreshAssets: refresh,
  };
}

function skippedLine(wrongKind: number, surplus: number, role: MediaRole): string | null {
  const parts: string[] = [];
  const files = (count: number) => `${count} file${count === 1 ? "" : "s"}`;
  if (wrongKind > 0) parts.push(`${files(wrongKind)} skipped — not ${ROLE_KINDS[role] === "audio" ? "audio" : `${ROLE_KINDS[role]}s`}`);
  if (surplus > 0) parts.push(`${files(surplus)} skipped — one ${roleNoun(role, 1)} at a time`);
  return parts.length ? parts.join("; ") : null;
}

function surplusLine(model: ModelEntry, role: MediaRole, cap: number): string {
  return `${model.label} takes ${cap} ${roleNoun(role, cap)}; the first ${cap} were attached.`;
}

/* A strip drag carries the item's id under its own type, so the composer's
   file drop zone can tell a reorder from a drop of files. */
const STRIP_MIME = "application/x-ohf-strip-item";

/** Attached inputs, above the prompt — the frames read before the words do.
    List roles carry the number the wire gives them, and can be put in order
    here: the chevrons on hover, or a drag within the role. */
export function MediaStrip({ model }: { model: ModelEntry }) {
  const media = useMedia(model);
  const [dragging, setDragging] = useState<string | null>(null);
  const items = media.state.items.filter((item) => model.roles[item.role]);
  if (items.length === 0) return null;

  const numbered = numberedItems(items, model.roles);
  const hint = numbered.some((entry) => entry.n !== undefined);
  /* Both groups on an exclusive plane: the line under the strip names the
     refusal where the inputs are, so the disabled Generate is no mystery. */
  const conflict = planeConflict(model, items);
  const dragged = dragging ? items.find((item) => item.id === dragging) : undefined;

  return (
    <>
      <ul className="ohf-strip">
        {numbered.map(({ item, n, sent }) => {
          const siblings = items.filter((entry) => entry.role === item.role);
          const at = siblings.indexOf(item);
          const orderable = siblings.length > 1;
          const noun = ROLE_LABELS[item.role].toLowerCase();
          const name = n !== undefined ? `${noun} ${n}` : sent ? noun : `unsent ${noun}`;
          /* The slate reads "REF 2" to the eye; the reader hears the place in
             full — "Reference 2 of 3" — from a line the slate hides behind. */
          const sentCount = numbered.filter((entry) => entry.item.role === item.role && entry.n !== undefined).length;
          const spoken =
            n !== undefined ? `${ROLE_LABELS[item.role]} ${n} of ${sentCount}` : sent ? ROLE_LABELS[item.role] : `Unsent ${noun}`;
          const over = dragged !== undefined && dragged.role === item.role && dragged.id !== item.id;
          /* Held past the role's cap — carried over from a wider model — the
             item is not sent: assemblePlane stops at the cap. It is dimmed,
             tagged OVER, and given no number to promise a place it does not
             have; a drag can still bring it inside the cap. */
          const cap = model.roles[item.role] ?? 0;
          const unsentTip = sent ? undefined : `${model.label} sends ${cap} ${roleNoun(item.role, cap)} — this one is not sent`;
          return (
            <li
              key={item.id}
              className="ohf-strip-item"
              data-dragging={dragging === item.id || undefined}
              data-over={over || undefined}
              data-unsent={!sent || undefined}
              title={unsentTip}
              draggable={orderable}
              onDragStart={(event: DragEvent<HTMLLIElement>) => {
                if (!orderable) return;
                event.dataTransfer.setData(STRIP_MIME, item.id);
                event.dataTransfer.effectAllowed = "move";
                setDragging(item.id);
              }}
              onDragOver={(event) => {
                if (!over) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
              }}
              onDrop={(event) => {
                if (!dragged || dragged.role !== item.role) return;
                event.preventDefault();
                event.stopPropagation();
                media.state.move(dragged.id, at);
                setDragging(null);
              }}
              onDragEnd={() => setDragging(null)}
            >
              <span className="ohf-strip-tile">
                {item.role === "audio" || item.role === "video" ? (
                  <span className="ohf-strip-glyph">
                    {item.role === "audio" ? <AudioIcon size={20} /> : <VideoIcon size={20} />}
                  </span>
                ) : (
                  /* Blob-hosted user upload; next/image would proxy an arbitrary
                     remote host for a 56px thumb. */
                  /* eslint-disable-next-line @next/next/no-img-element */
                  <img
                    className="ohf-strip-thumb"
                    src={item.url}
                    alt=""
                    draggable={false}
                    onError={(event) => {
                      event.currentTarget.style.visibility = "hidden";
                    }}
                  />
                )}
                <span className="ohf-strip-tag" aria-hidden>
                  {sent ? ROLE_TAGS[item.role] : "OVER"}
                  {n !== undefined && <span className="ohf-strip-num">{n}</span>}
                </span>
                <span className="ohf-sr">{spoken}</span>
              </span>
              {orderable && sent && (
                <>
                  <button
                    type="button"
                    className="ohf-strip-move ohf-strip-move--earlier"
                    aria-label={`Move ${name} earlier`}
                    title="Move earlier"
                    disabled={at === 0}
                    onClick={() => media.state.move(item.id, at - 1)}
                  >
                    <CaretDownIcon size={10} />
                  </button>
                  <button
                    type="button"
                    className="ohf-strip-move ohf-strip-move--later"
                    aria-label={`Move ${name} later`}
                    title="Move later"
                    disabled={at === siblings.length - 1}
                    onClick={() => media.state.move(item.id, at + 1)}
                  >
                    <CaretDownIcon size={10} />
                  </button>
                </>
              )}
              <button
                type="button"
                className="ohf-strip-remove"
                aria-label={`Remove ${name}`}
                onClick={() => media.state.remove(item.id)}
              >
                <CloseIcon size={10} />
              </button>
            </li>
          );
        })}
      </ul>
      {conflict ? (
        <p className="ohf-strip-hint ohf-strip-hint--warn" role="alert">
          {conflict}
        </p>
      ) : (
        hint && <p className="ohf-strip-hint">{orderHint(model)}</p>
      )}
    </>
  );
}
