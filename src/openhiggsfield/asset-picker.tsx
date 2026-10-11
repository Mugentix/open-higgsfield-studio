"use client";

import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { DragEvent } from "react";

import type { MediaItem, MediaRole, ModelEntry } from "@/generation/catalog";

import {
  ASSET_KEYS,
  LIST_ROLES,
  ROLE_KINDS,
  ROLE_LABELS,
  defaultRole,
  numbersInputs,
  productShelf,
  roleNoun,
  rolesOf,
  type AssetKind,
} from "./data";
import type { RunRecord } from "./history";
import { AssetsIcon, AudioIcon, CheckIcon, CloseIcon, GemIcon, PlayBadgeIcon, UploadIcon } from "./icons";
import type { UploadProgress } from "./media-tray";
import type { AssetRecord } from "@/server/asset-actions";
import type { Lineage } from "./media-tray";

type Source = "uploads" | "product" | "generations";

const SOURCES: readonly Source[] = ["uploads", "product", "generations"];

const SOURCE_LABELS: Record<Source, string> = {
  uploads: "Uploads",
  product: "Product",
  generations: "Generations",
};

interface Asset {
  /** The team asset behind an upload, so a shelf can pin it to the product. */
  assetId?: string;
  /** The result behind a generated tile, so the server can hand KIE a copy it
      can fetch instead of a url of our own store. */
  resultId?: string;
  pinned?: boolean;
  url: string;
  kind: AssetKind;
  /** The tile's name — a file name, or the prompt the run was made from. It is
      the alt text and the pointer title: a grey plate has no other handle. */
  title: string;
  /** The run's layered-gradient art, so a tile whose media is slow to arrive or
      has aged off the platform's CDN is still a picture rather than a hole. */
  art?: string;
}

/** Whether a drag carries files at all — as opposed to a strip item being put
    in order, which must not light a drop zone. The files themselves are
    hidden until the drop; the type list is what a hover can see. */
export function hasFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer.types).includes("Files");
}

/** The files a drop delivered, or none when it carried something else. */
export function droppedFiles(event: DragEvent): File[] {
  return hasFiles(event) ? Array.from(event.dataTransfer.files) : [];
}

/** Everything a role can be filled from: files this browser sent to Blob, and
    the finished runs already in the history. Both are public URLs the plane can
    carry, so the picker treats them as one library cut along two tabs. */
export function AssetPicker({
  model,
  items,
  uploads,
  history,
  staged,
  stagedRole,
  uploading,
  progress,
  note,
  blocked,
  productId,
  onUpload,
  onDrop,
  onApply,
  onPin,
  onClose,
}: {
  model: ModelEntry;
  /** The current surface's attachments. They are what the panel opens holding:
      a role's inputs are edited here, not only added to. */
  items: MediaItem[];
  uploads: AssetRecord[];
  history: RunRecord[];
  /** The last batch uploaded from here, in upload order, and its role. */
  staged: string[];
  stagedRole: MediaRole | null;
  uploading: boolean;
  progress: UploadProgress | null;
  /** The tray's one line about files a batch set aside. */
  note: string | null;
  /** Slots the model refuses right now, with the reason. */
  blocked: Partial<Record<MediaRole, string>>;
  /** The product the composer is in: its shelf is the third tab. */
  productId: string | null;
  onUpload: (role: MediaRole) => void;
  /** Files dropped on the panel, for the slot it is editing. */
  onDrop: (role: MediaRole, files: File[]) => void;
  onApply: (role: MediaRole, urls: string[], lineage?: (url: string) => Lineage) => void;
  /** Put a file on the product's shelf, or take it off. */
  onPin: (assetId: string, pinned: boolean) => void;
  onClose: () => void;
}) {
  const roles = rolesOf(model);
  /* The panel opens on a slot it can fill: the model's usual one unless the
     plane already blocks it, then the first that is open. */
  const [role, setRole] = useState<MediaRole>(() => {
    const usual = defaultRole(model);
    return blocked[usual] ? roles.find((entry) => !blocked[entry]) ?? usual : usual;
  });
  /* null until the visitor picks a shelf: the panel opens on whichever one
     actually holds something, so someone who has generated all day and
     uploaded nothing does not land on an empty tab. */
  const [source, setSource] = useState<Source | null>(null);
  /* The role's inputs as this panel would leave them — seeded with what is
     already on the plane, so an attached tile opens marked and can be pressed
     off again. An array, not a Set: the order picked is the order attached,
     and it is the number the wire gives each one. */
  const [selected, setSelected] = useState<string[]>(() => urlsOf(items, role));
  const [over, setOver] = useState(false);
  const tabsRef = useRef<HTMLDivElement>(null);
  const overDepth = useRef(0);

  const kind = ROLE_KINDS[role];
  const max = model.roles[role] ?? 0;
  const current = useMemo(() => urlsOf(items, role), [items, role]);
  const room = Math.max(0, max - selected.length);
  /* The wire numbers this slot's items, so the marks count the picks. */
  const numbered = numbersInputs(model.roles) && LIST_ROLES.includes(role);

  const uploadAssets = useMemo(
    () =>
      uploads
        .filter((record) => record.kind === kind)
        .map((record) => ({
          url: record.url,
          kind: record.kind,
          title: record.name,
          assetId: record.id,
          pinned: productId !== null && record.productId === productId,
        })),
    [uploads, kind, productId],
  );

  /* The product's own shelf: packshots, logos, the references every angle
     starts from. Pinned from the Uploads shelf, in the order the digit keys
     count them — the same helper the app's Alt+1…9 reads. */
  const productAssets = useMemo(
    () =>
      productShelf(uploads, productId, kind).map((record) => ({
        url: record.url,
        kind: record.kind,
        title: record.name,
        assetId: record.id,
        pinned: true,
      })),
    [uploads, kind, productId],
  );

  /* One record can carry several media, and each is its own attachable frame. */
  const runAssets = useMemo(() => {
    const out: Asset[] = [];
    for (const record of history) {
      if (record.status !== "completed" || record.kind !== kind) continue;
      for (const url of record.urls) out.push({ url, kind, title: record.prompt, art: record.art, resultId: record.id });
    }
    return out;
  }, [history, kind]);

  const shelf: Source =
    source ??
    (productAssets.length > 0
      ? "product"
      : uploadAssets.length === 0 && runAssets.length > 0
        ? "generations"
        : "uploads");
  const assets = shelf === "uploads" ? uploadAssets : shelf === "product" ? productAssets : runAssets;

  // The dialog takes focus on the control that scopes it, not on the grid.
  useEffect(() => {
    tabsRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus();
  }, []);

  /* A batch uploaded from inside the panel joins the selection rather than the
     plane: one press still applies the whole set. The ref holds whatever was
     staged before this panel opened, so reopening does not re-select it. */
  const seen = useRef(staged);

  /* Every shelf knows what stands behind its tiles — an upload's asset, a
     run's result — and the plane carries that along so the server resolves the
     file rather than trusting a url. */
  const lineageOf = (url: string): Lineage => {
    const hit: Asset | undefined =
      uploadAssets.find((asset) => asset.url === url) ??
      productAssets.find((asset) => asset.url === url) ??
      runAssets.find((asset) => asset.url === url);
    return hit ? { ...(hit.assetId ? { assetId: hit.assetId } : {}), ...(hit.resultId ? { resultId: hit.resultId } : {}) } : {};
  };
  const applyNow = (urls: string[]) => onApply(role, urls, lineageOf);

  /* A new role is a new library and a new set — a start frame cannot follow the
     switch to audio — so the shelf and the selection are both re-seeded. */
  function pickRole(next: MediaRole) {
    setRole(next);
    setSource(null);
    setSelected(urlsOf(items, next));
  }

  /* The plane can close this slot while the panel is open — a frame dropped on
     the composer body blocks the references being picked here — so the panel
     moves to the first slot still open rather than keep editing one the plane
     now refuses; the chip it left carries the reason. */
  useEffect(() => {
    if (!blocked[role]) return;
    const open = roles.find((entry) => !blocked[entry]);
    if (open) pickRole(open);
  }, [blocked, role]);

  /* Start and end are a pair: attaching the start should land on the empty end
     slot instead of closing, so the second frame is one more click, not a
     reopen plus a confirm. */
  function advanceOrClose(filled: MediaRole) {
    if (filled === "start" && (model.roles.end ?? 0) > 0 && !blocked.end) {
      const endUsed = items.filter((item) => item.role === "end").length;
      if (endUsed < (model.roles.end ?? 0)) {
        pickRole("end");
        return;
      }
    }
    onClose();
  }

  function commit(urls: string[]) {
    applyNow(urls);
    if (max > 0 && urls.length >= max) {
      advanceOrClose(role);
      return;
    }
    onClose();
  }

  useEffect(() => {
    if (staged === seen.current) return;
    seen.current = staged;
    /* Sent for another slot while the panel moved on: they are on the shelf,
       and that is where they stay until picked. */
    if (staged.length === 0 || stagedRole !== role) return;
    if (max === 1) {
      const url = staged[staged.length - 1]!;
      setSelected([url]);
      commit([url]);
      return;
    }
    /* The batch joins the end of the set in the files' order, whatever order
       the uploads finished in — the tray keeps it so — and goes onto the plane
       at once: a file uploaded for this slot is wanted in it, and a press of
       Generate before the panel closes must not find the strip empty. The
       panel stays open so the set can still be trimmed. */
    const next = [...selected.filter((url) => !staged.includes(url)), ...staged];
    setSelected(next);
    applyNow(next);
  }, [staged]);

  function toggle(url: string) {
    if (max === 1) {
      const next = selected.includes(url) ? [] : [url];
      setSelected(next);
      applyNow(next);
      if (next.length === 1) advanceOrClose(role);
      return;
    }
    setSelected((prev) =>
      prev.includes(url) ? prev.filter((entry) => entry !== url) : [...prev, url],
    );
  }

  const onTabKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const from = SOURCES.indexOf(shelf);
    const to =
      event.key === "ArrowRight"
        ? (from + 1) % SOURCES.length
        : event.key === "ArrowLeft"
          ? (from - 1 + SOURCES.length) % SOURCES.length
          : -1;
    if (to < 0) return;
    event.preventDefault();
    setSource(SOURCES[to]!);
    tabsRef.current?.querySelectorAll<HTMLElement>('[role="tab"]')[to]?.focus();
  };

  /* Files dragged anywhere over the panel land in the slot it is editing. The
     depth counter survives the enter/leave pairs every child fires. */
  const dragProps = {
    onDragEnter: (event: DragEvent<HTMLDivElement>) => {
      if (!hasFiles(event)) return;
      overDepth.current += 1;
      setOver(true);
    },
    onDragOver: (event: DragEvent<HTMLDivElement>) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    },
    onDragLeave: (event: DragEvent<HTMLDivElement>) => {
      if (!hasFiles(event)) return;
      overDepth.current = Math.max(0, overDepth.current - 1);
      if (overDepth.current === 0) setOver(false);
    },
    onDrop: (event: DragEvent<HTMLDivElement>) => {
      const files = droppedFiles(event);
      overDepth.current = 0;
      setOver(false);
      if (files.length === 0) return;
      event.preventDefault();
      event.stopPropagation();
      onDrop(role, files);
    },
  };

  const empty = emptyCopy(shelf, kind);
  const canUpload = room > 0 && !uploading;
  const progressLabel =
    progress && progress.total > 1
      ? `Uploading ${Math.min(progress.done + 1, progress.total)} of ${progress.total}`
      : "Uploading…";
  const uploadTip = uploading
    ? progressLabel
    : room > 0
      ? max > 1
        ? `Upload ${roleNoun(role, 2)} from this device`
        : `Upload a ${roleNoun(role, 1)} from this device`
      : `Every ${roleNoun(role, 1)} slot is taken — press one off to free it`;

  /* The button states the difference it will make, so a set edited down reads
     as a removal rather than as an "Add" that removes. */
  const picked = new Set(selected);
  const added = selected.filter((url) => !current.includes(url)).length;
  const dropped = current.filter((url) => !picked.has(url)).length;
  const applyLabel =
    added && dropped
      ? `Replace ${roleNoun(role, Math.max(added, dropped))}`
      : added
        ? `Add ${added > 1 ? `${added} ` : ""}${roleNoun(role, added)}`
        : dropped
          ? `Remove ${dropped > 1 ? `${dropped} ` : ""}${roleNoun(role, dropped)}`
          : "Done";

  return (
    <div
      className={`ohf-popover ohf-popover--assets${over ? " ohf-drop--over" : ""}`}
      role="dialog"
      aria-label="Add input"
      {...dragProps}
    >
      <div className="ohf-assets-head">
        <div
          className="ohf-assets-tabs"
          role="tablist"
          aria-label="Asset source"
          ref={tabsRef}
          onKeyDown={onTabKeyDown}
        >
          {SOURCES.map((id) => {
            const active = id === shelf;
            const count = id === "uploads" ? uploadAssets.length : id === "product" ? productAssets.length : runAssets.length;
            return (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={active}
                tabIndex={active ? 0 : -1}
                className="ohf-assets-tab"
                onClick={() => setSource(id)}
              >
                {SOURCE_LABELS[id]}
                <span className="ohf-assets-tab-count">{count}</span>
              </button>
            );
          })}
        </div>

        <button
          type="button"
          className="ohf-icon-btn ohf-icon-btn--ghost ohf-picker-close"
          aria-label="Close"
          title="Close"
          onClick={onClose}
        >
          <CloseIcon size={13} />
        </button>
      </div>

      {/* Which slot this panel is editing. Models declaring one role need no
          switch — the footer already names what is being changed. A slot the
          plane blocks stays visible but cannot be picked; the tip says why. */}
      {roles.length > 1 && (
        <div className="ohf-assets-roles" role="group" aria-label="Input slot">
          {roles.map((entry) => {
            const used =
              entry === role ? selected.length : items.filter((item) => item.role === entry).length;
            const reason = blocked[entry];
            return (
              <button
                key={entry}
                type="button"
                className="ohf-chip ohf-chip--role"
                aria-pressed={entry === role}
                disabled={reason !== undefined}
                title={reason}
                onClick={() => pickRole(entry)}
              >
                {ROLE_LABELS[entry]}
                <span className="ohf-chip-count">
                  {used}/{model.roles[entry] ?? 0}
                </span>
              </button>
            );
          })}
        </div>
      )}

      <div className="ohf-assets-body ohf-scroll">
        {assets.length === 0 ? (
          <div className="ohf-picker-empty">
            <span className="ohf-picker-empty-ic">
              {shelf === "uploads" ? <UploadIcon size={15} /> : <AssetsIcon size={15} />}
            </span>
            <span className="ohf-picker-empty-title">{empty.title}</span>
            <span className="ohf-picker-empty-hint">{empty.hint}</span>
            {shelf === "uploads" && (
              <button
                type="button"
                className="ohf-btn-solid"
                disabled={!canUpload}
                onClick={() => onUpload(role)}
              >
                <UploadIcon />
                {uploading ? progressLabel : max > 1 ? "Upload files" : "Upload file"}
              </button>
            )}
          </div>
        ) : (
          <div className="ohf-assets-grid">
            {shelf === "uploads" && (
              <button
                type="button"
                className="ohf-asset ohf-asset--upload"
                disabled={!canUpload}
                title={uploadTip}
                aria-label={uploadTip}
                onClick={() => onUpload(role)}
              >
                {uploading ? <span className="ohf-spinner" aria-hidden /> : <UploadIcon size={17} />}
                <span className="ohf-asset-upload-label">
                  {uploading ? progressLabel : max > 1 ? "Upload files" : "Upload file"}
                </span>
              </button>
            )}

            {assets.map((asset, index) => {
              const on = picked.has(asset.url);
              /* Alt+N attaches the shelf's Nth image as a reference from
                 anywhere in the studio; the badge is that key. Only the image
                 shelf, since a reference is a picture. */
              const hotkey = shelf === "product" && kind === "image" && index < ASSET_KEYS ? index + 1 : undefined;
              return (
                <AssetTile
                  key={asset.url}
                  asset={asset}
                  picked={on}
                  order={on && numbered ? selected.indexOf(asset.url) + 1 : undefined}
                  blocked={!on && room === 0}
                  hotkey={hotkey}
                  onToggle={toggle}
                  onPin={
                    asset.assetId && productId && (shelf === "uploads" || shelf === "product")
                      ? () => onPin(asset.assetId!, !asset.pinned)
                      : undefined
                  }
                />
              );
            })}
          </div>
        )}
      </div>

      {note && (
        <p className="ohf-assets-note" role="status">
          {note}
        </p>
      )}

      <div className="ohf-assets-foot">
        <span className="ohf-assets-tally">
          {selected.length} of {max} {roleNoun(role, max)}
        </span>
        {/* Never disabled: with no change left to apply it is simply the way
            out, and the panel always offers one press that ends the task. */}
        <button
          type="button"
          className="ohf-btn-accent"
          data-quiet={added + dropped === 0}
          onClick={() => commit(selected)}
        >
          {applyLabel}
        </button>
      </div>
    </div>
  );
}

function urlsOf(items: MediaItem[], role: MediaRole): string[] {
  return items.filter((item) => item.role === role).map((item) => item.url);
}

function emptyCopy(source: Source, kind: AssetKind): { title: string; hint: string } {
  if (source === "product") {
    return {
      title: "Nothing on this product's shelf",
      hint: "Pin an upload from the Uploads shelf and it is one press away in every project of the product.",
    };
  }
  if (source === "uploads") {
    return {
      title: "Nothing uploaded yet",
      hint: "Files you send from this device stay on this shelf for the next run too. Drop several at once.",
    };
  }
  if (kind === "audio") {
    return {
      title: "Runs never return audio",
      hint: "Attach an audio track from this device instead — it lands on the Uploads shelf.",
    };
  }
  return {
    title: `No finished ${kind} runs yet`,
    hint: `Every ${kind} you generate lands here, ready to feed the next run.`,
  };
}

/* Video assets preview on hover, the same reflex the gallery teaches, so the
   tile carries its own element and its own ref. */
const AssetTile = memo(function AssetTile({
  asset,
  picked,
  order,
  blocked,
  hotkey,
  onToggle,
  onPin,
}: {
  asset: Asset;
  picked: boolean;
  /** The 1-based place this pick takes in the slot's list — what the model
      will call it — where the slot is one the wire numbers. */
  order?: number;
  blocked: boolean;
  /** The digit that attaches this tile from the keyboard, when it has one. */
  hotkey?: number;
  onToggle: (url: string) => void;
  onPin?: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const title = hotkey ? `${asset.title} · Alt+${hotkey} attaches it as a reference` : asset.title;

  return (
    <span className="ohf-asset-wrap">
    {onPin && (
      <button
        type="button"
        className="ohf-asset-pin"
        data-on={asset.pinned === true}
        aria-pressed={asset.pinned === true}
        aria-label={asset.pinned ? "Take off the product shelf" : "Pin to the product shelf"}
        title={asset.pinned ? "On the product shelf" : "Pin to the product shelf"}
        onClick={(event) => {
          event.stopPropagation();
          onPin();
        }}
      >
        <GemIcon size={11} />
      </button>
    )}
    <button
      type="button"
      className="ohf-asset"
      data-picked={picked}
      disabled={blocked}
      title={order ? `${title} · ${order}` : title}
      aria-pressed={picked}
      aria-label={order ? `${title}, input ${order}` : title}
      onClick={() => onToggle(asset.url)}
      onMouseEnter={() => void videoRef.current?.play().catch(() => {})}
      onMouseLeave={() => {
        const video = videoRef.current;
        if (!video) return;
        video.pause();
        video.currentTime = 0;
      }}
    >
      <span className="ohf-asset-art" style={asset.art ? { background: asset.art } : undefined} />

      {asset.kind === "video" ? (
        <video
          ref={videoRef}
          className="ohf-asset-media"
          src={asset.url}
          muted
          loop
          playsInline
          preload="metadata"
        />
      ) : asset.kind === "audio" ? (
        <span className="ohf-asset-glyph">
          <AudioIcon size={20} />
        </span>
      ) : (
        /* Blob and platform CDN hosts both; next/image would need every
           provider domain allow-listed up front for a 112px thumb. */
        /* eslint-disable-next-line @next/next/no-img-element */
        <img className="ohf-asset-media" src={asset.url} alt="" loading="lazy" />
      )}

      {asset.kind === "video" && (
        <span className="ohf-asset-kind" aria-hidden>
          <PlayBadgeIcon size={8} />
        </span>
      )}

      {hotkey && (
        <kbd className="ohf-asset-key" aria-hidden>
          {hotkey}
        </kbd>
      )}

      {/* One mark for one state: the tile is in the set this panel will apply.
          Where the slot is numbered the mark is the number itself, so the
          visitor sees which becomes Image 1 before pressing Add. */}
      <span className={`ohf-asset-mark${order ? " ohf-asset-mark--num" : ""}`} aria-hidden>
        {order ?? <CheckIcon size={12} />}
      </span>
    </button>
    </span>
  );
});
