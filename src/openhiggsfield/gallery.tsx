"use client";

import { memo, useEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

import type { MediaRole, Surface } from "@/generation/catalog";
import type { UseTarget } from "@/generation/attach";

import { swatchFor } from "./artwork";
import {
  CROSS_VIEWS,
  hasPlane,
  pickSamples,
  SAMPLES,
  TILE_TOOLS,
  tileKeyHint,
  tileTool,
  type GalleryView,
  type Judged,
  type Verdict,
  VERDICT_KEYS,
  VERDICT_LABELS,
  verdictOfKey,
  VERDICTS,
} from "./data";
import type { ActiveRun } from "./openhiggsfield-app";
import {
  ArrowRightIcon,
  CheckIcon,
  DownloadIcon,
  HeartIcon,
  PlayBadgeIcon,
  PlusIcon,
  RetryIcon,
  TrashIcon,
  WarningIcon,
} from "./icons";
import { timeAgo, type RunRecord } from "./history";
import { hotkeysQuiet, menuStep } from "./hotkeys";
import { ModelIcon } from "./model-icon";

const EMPTY: Record<GalleryView, { title: string; hint: string }> = {
  image: {
    title: "Your image runs land here",
    hint: "Describe a subject below, pick a model, press Generate. Every finished run lands on the team's wall, in the project you are in.",
  },
  video: {
    title: "Your video runs land here",
    hint: "Describe the shot below, pick a model, press Generate. Every finished run lands on the team's wall, in the project you are in.",
  },
  assets: {
    title: "Nothing here yet",
    hint: "Image and video runs both land in this grid. Try another project, or clear the filters.",
  },
  favorites: {
    title: "Nothing kept yet",
    hint: "Hover a run and press its heart to keep it here for the whole team.",
  },
};

/* Action labels name the run they act on — tabbing a long grid otherwise
   reads as forty identical "Delete run"s. */
function shortPrompt(prompt: string): string {
  return prompt.length > 48 ? `${prompt.slice(0, 47)}…` : prompt;
}

const GRID_GAP = 14;
const COLUMNS = 4;
/** Every tile is the same 4:3 slot; media is contained so it keeps its own ratio. */
const CARD_RATIO = 4 / 3;

type Slot =
  | { key: string; kind: "run"; run: ActiveRun }
  | { key: string; kind: "item"; item: RunRecord & Judged; index: number };

function slotsOf(runs: ActiveRun[], items: Array<RunRecord & Judged>): Slot[] {
  const slots: Slot[] = runs.map((run) => ({ key: run.id, kind: "run", run }));
  items.forEach((item, index) => {
    if (item.status === "running") {
      slots.push({
        key: item.id,
        kind: "run",
        run: {
          id: item.id,
          surface: item.surface,
          modelLabel: item.modelLabel,
          ratio: item.ratio,
          startedAt: item.createdAt,
        },
      });
      return;
    }
    slots.push({ key: item.id, kind: "item", item, index });
  });
  return slots;
}

function useInnerWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const measure = () => {
      const styles = getComputedStyle(node);
      const pad = parseFloat(styles.paddingLeft) + parseFloat(styles.paddingRight);
      setWidth(Math.max(0, node.clientWidth - pad));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

const Tile = memo(function Tile({
  item,
  index,
  fresh,
  picked,
  selecting,
  onOpen,
  onPick,
  onReuse,
  onFavorite,
  onDownload,
  onDelete,
  onVerdict,
  targets,
  onUse,
  onRemix,
  onVariants,
  onUtility,
  onHover,
}: {
  item: RunRecord & Judged;
  index: number;
  fresh: boolean;
  picked: boolean;
  /* Once anything is picked the grid is in selection mode: every checkbox
     stands, and the card body toggles rather than opens. */
  selecting: boolean;
  onOpen: (id: string) => void;
  onPick: (id: string, index: number, range: boolean) => void;
  onReuse: (item: RunRecord) => void;
  onFavorite: (item: RunRecord) => void;
  onDownload: (item: RunRecord) => Promise<void>;
  onDelete: (item: RunRecord) => void;
  /** The team's call on this run; null takes it back. */
  onVerdict: (item: RunRecord, verdict: Verdict | null) => void;
  /** What this tile can be used as, given the model in the composer. */
  targets: UseTarget[];
  onUse: (item: RunRecord, role: MediaRole) => void;
  onRemix: (item: RunRecord) => void;
  onVariants: (item: RunRecord) => void;
  /** A promptless utility run straight off this tile, by catalog id. */
  onUtility: (item: RunRecord, modelId: string) => void;
  onHover: (id: string | null) => void;
}) {
  const delay = `${Math.min(index * 0.035, 0.28).toFixed(3)}s`;
  /* The Use menu: the one control on a card that opens something. A press
     inside it must reach its row, so only presses elsewhere close it. */
  const [menu, setMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const plusRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!menu) return;
    /* Focus enters the menu as it opens and returns to the button that
       opened it on Escape — the menu-button pattern, so the rows are one
       keystroke away and not a Shift+Tab back through the rail. */
    menuRef.current?.querySelector<HTMLElement>('[role^="menuitem"]')?.focus();
    const close = (event: PointerEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return;
      setMenu(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setMenu(false);
      plusRef.current?.focus();
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menu]);
  const poster = item.urls[0];
  const videoRef = useRef<HTMLVideoElement>(null);
  /* The keep beat is driven from the click, never from mount: a CSS animation
     bound to the saved state alone would re-fire on every scope switch. */
  const [beat, setBeat] = useState(false);
  /* A video is megabytes read over the wire before the browser is handed
     anything, so the press has to say it landed. */
  const [saving, setSaving] = useState(false);
  const saved = item.favorite === true;
  const named = shortPrompt(item.prompt);
  const facts = item.meta ? item.meta.split(" · ") : [];

  /* Top-left, where a selection mark is looked for, and the one control on the
     card that is not about this run alone. It carries the whole checkbox
     semantics rather than a pressed button: a grid of these is a multi-select,
     and a screen reader should hear it as one. */
  const picker = (
    <button
      type="button"
      className="ohf-pick"
      role="checkbox"
      aria-checked={picked}
      aria-label={`Select run — ${named}`}
      title={picked ? "Deselect" : "Select"}
      onClick={(event) => onPick(item.id, index, event.shiftKey)}
    >
      <span className="ohf-pick-box">
        <CheckIcon size={12} />
      </span>
    </button>
  );

  const remove = (
    <button
      type="button"
      className="ohf-tile-act ohf-tile-act--danger"
      aria-label={`Delete run — ${named}`}
      title="Delete run"
      onClick={() => onDelete(item)}
    >
      <TrashIcon size={15} />
    </button>
  );

  if (item.status === "failed") {
    return (
      <div
        className="ohf-tile ohf-tile--failed"
        data-picked={picked}
      >
        <div className="ohf-fail">
          <span className="ohf-fail-ic">
            <WarningIcon />
          </span>
          <span className="ohf-fail-title">{item.modelLabel} didn’t deliver</span>
          <span className="ohf-fail-why">{item.error}</span>
          <button
            type="button"
            className="ohf-btn-solid"
            title="Reuse prompt and settings"
            onClick={() => onReuse(item)}
          >
            <RetryIcon />
            Retry this run
          </button>
        </div>
        {picker}
        <div className="ohf-tile-acts">{remove}</div>
      </div>
    );
  }

  return (
    /* A container, not a button: the card's own actions cannot nest inside the
       control that opens it. The stretched .ohf-tile-open carries the open. */
    <div
      className="ohf-tile"
      data-id={item.id}
      data-fresh={fresh}
      data-picked={picked}
      data-saving={saving || undefined}
      data-menu={menu || undefined}
      data-verdict={item.verdict ?? undefined}
      style={{ "--d": delay } as CSSProperties}
      onMouseEnter={() => {
        onHover(item.id);
        void videoRef.current?.play().catch(() => {});
      }}
      onMouseLeave={() => {
        onHover(null);
        const video = videoRef.current;
        if (!video) return;
        video.pause();
        video.currentTime = 0;
      }}
    >
      {poster &&
        (item.kind === "video" ? (
          <video
            ref={videoRef}
            className="ohf-tile-media"
            src={poster}
            muted
            loop
            playsInline
            preload="metadata"
          />
        ) : (
          /* Platform-hosted result on an arbitrary CDN host; next/image would
             need every provider domain allow-listed up front. */
          /* eslint-disable-next-line @next/next/no-img-element */
          <img className="ohf-tile-media" src={poster} alt={item.prompt} loading="lazy" />
        ))}

      {/* While runs are picked the card is part of a selection, so its body
          extends the selection instead of leaving the grid for the viewer —
          the same bargain every OS file grid makes. */}
      <button
        type="button"
        className="ohf-tile-open"
        onClick={(event) =>
          selecting ? onPick(item.id, index, event.shiftKey) : onOpen(item.id)
        }
        aria-label={
          selecting
            ? `${picked ? "Deselect" : "Select"} run — ${named}`
            : `Open run — ${item.modelLabel}: ${item.prompt}`
        }
      />

      {picker}

      {item.kind === "video" && item.badge && (
        <span className="ohf-tile-badge">
          <PlayBadgeIcon />
          {item.badge}
        </span>
      )}
      {/* The run signs itself only while the card is under the cursor, the same
          bargain the action rail makes — an un-hovered grid is nothing but the
          work. What distinguishes two cards of the same model is the words that
          made them, so the prompt leads; the model joins the stored one-liner's
          facts below, on the plate the rest of the card's chrome uses. */}
      <span className="ohf-tile-caption">
        <span className="ohf-tile-prompt">{item.prompt}</span>
        <span className="ohf-tile-facts">
          <span className="ohf-tile-fact ohf-tile-fact--model">
            <ModelIcon modelId={item.modelId} size={12} />
            {item.modelLabel}
          </span>
          {facts.map((fact) => (
            <span className="ohf-tile-fact" key={fact}>
              {fact}
            </span>
          ))}
        </span>
      </span>

      {/* The team's call, one word in the corner the caption leaves free. It
          shows on a card at rest — the one fact about a run that outranks the
          picture — and the caption lifts above it rather than covering it. */}
      {item.verdict && (
        <span className="ohf-verdict ohf-tile-verdict" data-verdict={item.verdict}>
          {VERDICT_LABELS[item.verdict]}
        </span>
      )}

      {/* Keep sits last, hard against the corner: it is the one action that
          shows on an un-hovered card, and the transient three open to its left
          rather than leaving it stranded mid-edge. Delete leads from the far
          end, the slot furthest from the corner the cursor arrives at. */}
      {/* Use as… : the loop the studio is built for. The menu names the slot
          and, when the model in the composer cannot take it, the model that
          will — one press switches and attaches. */}
      {menu && poster && (
        <div
          className="ohf-menu ohf-tile-menu"
          role="menu"
          aria-label="Use this run"
          ref={menuRef}
          /* The arrows walk the rows and wrap; Enter is the row's own press. */
          onKeyDown={(event) => {
            const rows = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role^="menuitem"]'));
            const to = menuStep(rows.length, rows.indexOf(event.target as HTMLElement), event.key);
            if (to === null) return;
            event.preventDefault();
            rows[to]?.focus();
          }}
        >
          {targets.map((target) => (
            <button
              key={target.role}
              type="button"
              role="menuitem"
              className="ohf-menu-row"
              onClick={() => {
                setMenu(false);
                onUse(item, target.role);
              }}
            >
              <span className="ohf-menu-label">{target.label}</span>
              {target.modelLabel && <span className="ohf-menu-count">{target.modelLabel}</span>}
            </button>
          ))}
          {hasPlane(item) && (
            <>
              <button
                type="button"
                role="menuitem"
                className="ohf-menu-row"
                onClick={() => {
                  setMenu(false);
                  onRemix(item);
                }}
              >
                <span className="ohf-menu-label">Remix</span>
                <span className="ohf-menu-count">prompt + reference</span>
              </button>
              <button
                type="button"
                role="menuitem"
                className="ohf-menu-row"
                onClick={() => {
                  setMenu(false);
                  onVariants(item);
                }}
              >
                <span className="ohf-menu-label">Variants ×4</span>
                <span className="ohf-menu-count">same plane</span>
              </button>
            </>
          )}
          {/* Tools run on the result itself, with the entry's defaults, and
              land beside it: nothing to type, nothing to attach. */}
          {TILE_TOOLS[item.kind].map((tool) => (
            <button
              key={tool.modelId}
              type="button"
              role="menuitem"
              className="ohf-menu-row"
              onClick={() => {
                setMenu(false);
                onUtility(item, tool.modelId);
              }}
            >
              <span className="ohf-menu-label">{tool.label}</span>
              <span className="ohf-menu-count">{tool.key.toUpperCase()}</span>
            </button>
          ))}
          {/* The team's call, off a hairline under the uses: judging a run is
              a different act from feeding it back in. The word that holds is
              checked, and pressing it again takes the call back. */}
          <div className="ohf-menu-verdicts" role="group" aria-label="Verdict">
            {VERDICTS.map((verdict) => (
              <button
                key={verdict}
                type="button"
                role="menuitemradio"
                aria-checked={item.verdict === verdict}
                className="ohf-menu-row"
                data-verdict={verdict}
                onClick={() => {
                  setMenu(false);
                  onVerdict(item, item.verdict === verdict ? null : verdict);
                }}
              >
                <span className="ohf-menu-label">{VERDICT_LABELS[verdict]}</span>
                <span className="ohf-menu-count">{VERDICT_KEYS[verdict].toUpperCase()}</span>
              </button>
            ))}
            {item.verdict && (
              <button
                type="button"
                role="menuitem"
                className="ohf-menu-row"
                onClick={() => {
                  setMenu(false);
                  onVerdict(item, null);
                }}
              >
                <span className="ohf-menu-label">Clear verdict</span>
              </button>
            )}
          </div>
        </div>
      )}

      <div className="ohf-tile-acts">
        {remove}
        {poster && (
          <button
            ref={plusRef}
            type="button"
            className="ohf-tile-act"
            aria-label={`Use as input — ${named}`}
            aria-haspopup="menu"
            aria-expanded={menu}
            title={`Use as input (${tileKeyHint(item.kind)})`}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => setMenu((open) => !open)}
          >
            <PlusIcon size={15} />
          </button>
        )}
        <button
          type="button"
          className="ohf-tile-act"
          aria-label={`Reuse prompt and settings — ${named}`}
          title="Reuse prompt and settings"
          onClick={() => onReuse(item)}
        >
          <RetryIcon size={15} />
        </button>
        {/* Absent on a run the platform returned no file for — there would be
            nothing to save. The press is guarded rather than disabled: a
            disabled button drops the focus that is holding this rail open. */}
        {poster && (
          <button
            type="button"
            className="ohf-tile-act"
            aria-label={saving ? `Saving — ${named}` : `Download run — ${named}`}
            title={saving ? "Saving" : "Download"}
            onClick={() => {
              if (saving) return;
              setSaving(true);
              void onDownload(item).finally(() => setSaving(false));
            }}
          >
            {saving ? <span className="ohf-spinner" aria-hidden /> : <DownloadIcon size={15} />}
          </button>
        )}
        <button
          type="button"
          className="ohf-tile-act"
          data-on={saved}
          data-beat={beat || undefined}
          aria-pressed={saved}
          aria-label={`${saved ? "Remove from favorites" : "Save to favorites"} — ${named}`}
          title={saved ? "Remove from favorites" : "Save to favorites"}
          onClick={() => {
            if (!saved) setBeat(true);
            onFavorite(item);
          }}
          onAnimationEnd={() => setBeat(false)}
        >
          <HeartIcon size={16} filled={saved} />
        </button>
      </div>
    </div>
  );
});

export const Gallery = memo(function Gallery({
  view,
  surface,
  items,
  runs,
  freshIds,
  picked,
  onOpen,
  onPick,
  onReuse,
  onFavorite,
  onDownload,
  onDelete,
  onVerdict,
  onStarter,
  onEndReached,
  imageTargets,
  videoTargets,
  onUse,
  onRemix,
  onVariants,
  onUtility,
  galleryRef,
}: {
  view: GalleryView;
  surface: Surface;
  items: Array<RunRecord & Judged>;
  runs: ActiveRun[];
  freshIds: string[];
  picked: ReadonlySet<string>;
  onOpen: (id: string) => void;
  onPick: (id: string, index: number, range: boolean) => void;
  onReuse: (item: RunRecord) => void;
  onFavorite: (item: RunRecord) => void;
  onDownload: (item: RunRecord) => Promise<void>;
  onDelete: (item: RunRecord) => void;
  onVerdict: (item: RunRecord, verdict: Verdict | null) => void;
  onStarter: (prompt: string) => void;
  onEndReached?: () => void;
  imageTargets: UseTarget[];
  videoTargets: UseTarget[];
  onUse: (item: RunRecord, role: MediaRole) => void;
  onRemix: (item: RunRecord) => void;
  onVariants: (item: RunRecord) => void;
  onUtility: (item: RunRecord, modelId: string) => void;
  galleryRef: RefObject<HTMLDivElement | null>;
}) {
  /* R, S, E and V on the card under the cursor (or holding focus) attach it
     without a trip to the menu: reference, start, end, video. U and B run a
     tool on it the same way: upscale, background. W, T and X make the team's
     call on it — winner, testing, killed — and the same letter again takes
     the call back. */
  const [hovered, setHovered] = useState<string | null>(null);
  const hoveredRef = useRef<string | null>(null);
  hoveredRef.current = hovered;
  const itemsRef = useRef(items);
  itemsRef.current = items;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      /* A held key repeats; a tool key would submit a paid run per repeat. */
      if (event.repeat || event.metaKey || event.ctrlKey || event.altKey) return;
      const key = event.key.toLowerCase();
      const role: MediaRole | null = key === "r" ? "reference" : key === "s" ? "start" : key === "e" ? "end" : key === "v" ? "video" : null;
      const verdict = verdictOfKey(key);
      /* A tool key is looked up against the tile's kind below; here it only
         has to be a key some tile answers to. */
      if (!role && !verdict && !tileTool("image", key) && !tileTool("video", key)) return;
      /* Quiet while typing, and under a dialog — the viewer, compare, the key
         prompt — where the grid is not the surface on top: the viewer answers
         these letters for itself, and the tile last hovered is hidden under
         the modal. */
      if (hotkeysQuiet(event)) return;
      const focusedTile = document.activeElement?.closest<HTMLElement>(".ohf-tile[data-id]")?.dataset.id ?? null;
      const id = focusedTile ?? hoveredRef.current;
      if (!id) return;
      const item = itemsRef.current.find((entry) => entry.id === id);
      if (!item || item.status !== "completed" || !item.urls[0]) return;
      if (verdict) {
        event.preventDefault();
        onVerdict(item, item.verdict === verdict ? null : verdict);
        return;
      }
      if (role) {
        const allowed = (item.kind === "video" ? videoTargets : imageTargets).some((t) => t.role === role);
        if (!allowed) return;
        event.preventDefault();
        onUse(item, role);
        return;
      }
      const tool = tileTool(item.kind, key);
      if (!tool) return;
      event.preventDefault();
      onUtility(item, tool.modelId);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [imageTargets, videoTargets, onUse, onUtility, onVerdict]);

  const selecting = picked.size > 0;
  const panel = {
    id: "ohf-panel",
    role: "tabpanel",
    "aria-labelledby": `ohf-tab-${view}`,
    className: "ohf-gallery ohf-scroll",
  } as const;

  if (items.length === 0 && runs.length === 0) {
    return (
      <div {...panel} ref={galleryRef}>
        <Empty view={view} surface={surface} onStarter={onStarter} key={view} />
      </div>
    );
  }

  return (
    <div {...panel} ref={galleryRef}>
      <VirtualizedGrid
        key={view}
        scrollRef={galleryRef}
        selecting={selecting}
        runs={runs}
        items={items}
        freshIds={freshIds}
        picked={picked}
        onOpen={onOpen}
        onPick={onPick}
        onReuse={onReuse}
        onFavorite={onFavorite}
        onDownload={onDownload}
        onDelete={onDelete}
        onVerdict={onVerdict}
        onEndReached={onEndReached}
        imageTargets={imageTargets}
        videoTargets={videoTargets}
        onUse={onUse}
        onRemix={onRemix}
        onVariants={onVariants}
        onUtility={onUtility}
        onHover={setHovered}
      />
    </div>
  );
});

function VirtualizedGrid({
  scrollRef,
  selecting,
  runs,
  items,
  freshIds,
  picked,
  onOpen,
  onPick,
  onReuse,
  onFavorite,
  onDownload,
  onDelete,
  onVerdict,
  onEndReached,
  imageTargets,
  videoTargets,
  onUse,
  onRemix,
  onVariants,
  onUtility,
  onHover,
}: {
  scrollRef: RefObject<HTMLDivElement | null>;
  selecting: boolean;
  runs: ActiveRun[];
  items: Array<RunRecord & Judged>;
  freshIds: string[];
  picked: ReadonlySet<string>;
  onOpen: (id: string) => void;
  onPick: (id: string, index: number, range: boolean) => void;
  onReuse: (item: RunRecord) => void;
  onFavorite: (item: RunRecord) => void;
  onDownload: (item: RunRecord) => Promise<void>;
  onDelete: (item: RunRecord) => void;
  onVerdict: (item: RunRecord, verdict: Verdict | null) => void;
  onEndReached?: () => void;
  imageTargets: UseTarget[];
  videoTargets: UseTarget[];
  onUse: (item: RunRecord, role: MediaRole) => void;
  onRemix: (item: RunRecord) => void;
  onVariants: (item: RunRecord) => void;
  onUtility: (item: RunRecord, modelId: string) => void;
  onHover: (id: string | null) => void;
}) {
  const width = useInnerWidth(scrollRef);
  const slots = useMemo(() => slotsOf(runs, items), [runs, items]);
  const rows = Math.max(1, Math.ceil(slots.length / COLUMNS));

  const virtualizer = useVirtualizer({
    count: rows,
    getScrollElement: () => scrollRef.current,
    estimateSize: (row) => {
      if (width <= 0) return 240;
      const col = (width - GRID_GAP * (COLUMNS - 1)) / COLUMNS;
      return col / CARD_RATIO + (row === rows - 1 ? 0 : GRID_GAP);
    },
    overscan: 4,
  });

  useEffect(() => {
    virtualizer.measure();
  }, [width, slots, virtualizer]);

  /* The next page is asked for while the last rows are still coming into
     view, so a long wall scrolls without a seam. */
  const virtualRows = virtualizer.getVirtualItems();
  const lastVisible = virtualRows[virtualRows.length - 1]?.index ?? -1;
  useEffect(() => {
    if (onEndReached && rows > 0 && lastVisible >= rows - 2) onEndReached();
  }, [lastVisible, rows, onEndReached]);

  return (
    <div className="ohf-grid-window" style={{ height: virtualizer.getTotalSize() }}>
      {virtualizer.getVirtualItems().map((row) => {
        const from = row.index * COLUMNS;
        const slice = slots.slice(from, from + COLUMNS);
        return (
          <div
            key={row.key}
            className="ohf-grid"
            data-selecting={selecting}
            style={
              {
                "--ohf-cols": COLUMNS,
                transform: `translateY(${row.start}px)`,
              } as CSSProperties
            }
          >
            {slice.map((slot) =>
              slot.kind === "run" ? (
                <RunningTile key={slot.key} run={slot.run} />
              ) : (
                <Tile
                  key={slot.key}
                  item={slot.item}
                  index={slot.index}
                  fresh={freshIds.includes(slot.item.id)}
                  picked={picked.has(slot.item.id)}
                  selecting={selecting}
                  onOpen={onOpen}
                  onPick={onPick}
                  onReuse={onReuse}
                  onFavorite={onFavorite}
                  onDownload={onDownload}
                  onDelete={onDelete}
                  onVerdict={onVerdict}
                  targets={slot.item.kind === "video" ? videoTargets : imageTargets}
                  onUse={onUse}
                  onRemix={onRemix}
                  onVariants={onVariants}
                  onUtility={onUtility}
                  onHover={onHover}
                />
              ),
            )}
          </div>
        );
      })}
    </div>
  );
}

/* First run of the session. No placeholder scenery — the invitation carries
   itself, and the three starters are the only thing on the ground because they
   are the only thing here that is real: sample prompts, each showing the light
   its seed would make. One click loads the
   composer; pressing Generate stays the visitor’s call. Only the surface
   scopes offer them: a starter writes one surface’s prompt, and Assets and
   Favorites span both and are stocked from the other scopes, so they state the
   gesture instead. */
function Empty({
  view,
  surface,
  onStarter,
}: {
  view: GalleryView;
  surface: Surface;
  onStarter: (prompt: string) => void;
}) {
  const thumbRatio = surface === "image" ? "4 / 3" : "16 / 9";
  /* Reshuffled on every page load, and only after mount — picking during
     render would hand the hydrating client a different three than the server
     wrote. Until the picks land the server's three hold their space unseen, so
     the invitation never jumps up the panel to make room for them. */
  const [samples, setSamples] = useState<string[] | null>(null);
  useEffect(() => setSamples(pickSamples(surface)), [surface]);

  return (
    <div className="ohf-empty">
      <div className="ohf-empty-copy">
        <h2 className="ohf-empty-title">{EMPTY[view].title}</h2>
        <p className="ohf-empty-hint">{EMPTY[view].hint}</p>

        {!CROSS_VIEWS.has(view) && (
          <ul
            className="ohf-empty-starters"
            style={samples ? undefined : { visibility: "hidden" }}
          >
            {(samples ?? SAMPLES[surface].slice(0, 3)).map((sample) => (
              <li key={sample}>
                <button type="button" className="ohf-starter" onClick={() => onStarter(sample)}>
                  <span
                    className="ohf-starter-thumb"
                    style={{ background: swatchFor(surface, sample), aspectRatio: thumbRatio }}
                  >
                    <span className="ohf-grain" style={{ opacity: 0.24 }} />
                  </span>
                  <span className="ohf-starter-text">{sample}</span>
                  <span className="ohf-starter-go">
                    <ArrowRightIcon />
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function RunningTile({ run }: { run: ActiveRun }) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const tick = () => setElapsed(Math.floor((Date.now() - run.startedAt) / 1000));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [run.startedAt]);

  return (
    <div
      className="ohf-skeleton"
      role="status"
      aria-label={`${run.modelLabel} rendering`}
    >
      <span className="ohf-skeleton-label">Rendering</span>
      <span className="ohf-skeleton-clock">
        {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, "0")}
      </span>
    </div>
  );
}

export function runSubtitle(item: RunRecord): string {
  return timeAgo(item.createdAt);
}
