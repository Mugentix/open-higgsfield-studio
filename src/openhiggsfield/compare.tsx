"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent } from "react";

import { VERDICT_LABELS, settingLabel, settingValueLabel, type Judged } from "./data";
import { timeAgo, type RunRecord } from "./history";
import { CloseIcon, DownloadIcon, HeartIcon, PauseIcon, PlayIcon } from "./icons";
import { ModelIcon } from "./model-icon";

/** How many runs stand side by side. Two is the smallest comparison there is;
    past four the columns are too narrow to judge a picture in. */
export const COMPARE_MIN = 2;
export const COMPARE_MAX = 4;

export function canCompare(count: number): boolean {
  return count >= COMPARE_MIN && count <= COMPARE_MAX;
}

/* Backstop only, as in the viewer: the exit normally ends on the panel's own
   animationend, which a backgrounded tab can defer indefinitely. */
const EXIT_TIMEOUT_MS = 420;

/* Written out in full: the header's relative time says "when", this row says
   "which run" when two were made a minute apart. */
const CREATED = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

/** One row of the table: a label, one cell per run, and whether a difference
    between the cells is something to point at. */
export interface CompareRow {
  key: string;
  label: string;
  values: string[];
  /** False for facts that differ by nature — every run has its own clock. */
  compared: boolean;
}

/** The union of every dial the runs were submitted with, each read across the
    columns in the same words the settings panel and the viewer use. A run
    without a dial shows a dash in that row; runs that predate the stored plane
    bring their one-line meta along as "Output", the way the viewer falls back.
    The team's call and its note join only when some run carries one. */
export function compareRows(items: Array<RunRecord & Judged>): CompareRow[] {
  const rows: CompareRow[] = [
    { key: "prompt", label: "Prompt", values: items.map((item) => item.prompt), compared: true },
    { key: "model", label: "Model", values: items.map((item) => item.modelLabel), compared: true },
  ];
  /* The call is usually what the comparison is for, so it sits right under
     the model; a run nobody has judged shows a dash. */
  if (items.some((item) => item.verdict)) {
    rows.push({
      key: "verdict",
      label: "Verdict",
      values: items.map((item) => (item.verdict ? VERDICT_LABELS[item.verdict] : "—")),
      compared: true,
    });
  }
  /* Keys in the order they are first met, so a dial the first run has leads. */
  const keys: string[] = [];
  for (const item of items) {
    for (const key of Object.keys(item.settings ?? {})) {
      if (!keys.includes(key)) keys.push(key);
    }
  }
  for (const key of keys) {
    rows.push({
      key: `setting:${key}`,
      label: settingLabel(key),
      values: items.map((item) => {
        const value = item.settings?.[key];
        return value === undefined ? "—" : settingValueLabel(key, value);
      }),
      compared: true,
    });
  }
  if (items.some((item) => !item.settings)) {
    rows.push({
      key: "meta",
      label: "Output",
      values: items.map((item) => item.meta || "—"),
      compared: true,
    });
  }
  /* Notes are each run's own words: two that differ are not a difference to
     point at. */
  if (items.some((item) => item.note)) {
    rows.push({
      key: "note",
      label: "Note",
      values: items.map((item) => item.note || "—"),
      compared: false,
    });
  }
  rows.push({
    key: "created",
    label: "Created",
    values: items.map((item) => CREATED.format(item.createdAt)),
    compared: false,
  });
  return rows;
}

export function differs(values: string[]): boolean {
  return values.some((value) => value !== values[0]);
}

/** The shape the media turned out to be, or null while it has none to report —
    a decoded image always has one, a video only once its metadata lands. */
function shapeOf(media: HTMLImageElement | HTMLVideoElement): number | null {
  const [width, height] =
    media instanceof HTMLVideoElement
      ? [media.videoWidth, media.videoHeight]
      : [media.naturalWidth, media.naturalHeight];
  return width > 0 && height > 0 ? width / height : null;
}

export function Compare({
  items,
  onClose,
  onFavorite,
  onDownload,
}: {
  /** Two to four runs, in the order they were picked. */
  items: Array<RunRecord & Judged>;
  onClose: () => void;
  onFavorite: (id: string, keep: boolean) => void;
  /** Resolves when the save has been offered or refused; the app names the
      file and reports a refusal, the same contract the grid's cards use. */
  onDownload: (item: RunRecord) => Promise<void>;
}) {
  const shown = items.slice(0, COMPARE_MAX);
  const ref = useRef<HTMLDialogElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [closing, setClosing] = useState(false);
  /* What the exit was for. Captured at the click so a re-render mid-flight
     cannot swap the action out from under it. */
  const after = useRef(onClose);

  /* Opened from the selection bar's Compare, and the exit hands focus back
     there — unless something else took it first. The opener is read once
     into a ref: React runs this effect twice in development, and a second
     read would find the dialog's own panel. */
  const opener = useRef<HTMLElement | null>(null);
  useEffect(() => {
    opener.current ??= document.activeElement instanceof HTMLElement ? document.activeElement : null;
    ref.current?.showModal();
    // Focus the panel itself so no column or action opens pre-ringed.
    panelRef.current?.focus();
    return () => {
      if (document.activeElement === null || document.activeElement === document.body) opener.current?.focus();
    };
  }, []);

  /* Every way out plays the same exit. The dialog stays mounted and open
     while it runs — calling close(), or letting the parent drop it, would cut
     the animation on its first frame. */
  const leave = useCallback(
    (action: () => void) => {
      if (closing) return;
      after.current = action;
      setClosing(true);
    },
    [closing],
  );

  useEffect(() => {
    if (!closing) return;
    const timer = setTimeout(() => after.current(), EXIT_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [closing]);

  /* The clips in the columns are one set: they start, stop and resume from one
     control, so the same moment can be frozen in every column at once. The
     elements themselves are the record of what is playing — the label follows
     their events rather than a flag of its own, so a clip the browser refused
     to start is never reported as running. */
  const videos = useRef(new Map<string, HTMLVideoElement>());
  const [playing, setPlaying] = useState(false);
  const hasVideo = shown.some((item) => item.kind === "video" && item.urls[0]);

  const register = useCallback((id: string, video: HTMLVideoElement | null) => {
    if (video) videos.current.set(id, video);
    else videos.current.delete(id);
  }, []);

  const syncPlaying = useCallback(() => {
    setPlaying([...videos.current.values()].some((video) => !video.paused));
  }, []);

  const togglePlayback = useCallback(() => {
    const all = [...videos.current.values()];
    const anyPlaying = all.some((video) => !video.paused);
    for (const video of all) {
      if (anyPlaying) video.pause();
      else void video.play().catch(() => {});
    }
  }, []);

  /* The column the arrows walk from. Kept after focus moves to the toolbar so
     a press there continues from the column the visitor was on, and drawn as a
     tint down the whole column so the head's ring and the cells below read as
     one thing. */
  const heads = useRef<Array<HTMLTableCellElement | null>>([]);
  const [current, setCurrent] = useState<number | null>(null);

  const onKeyDown = (event: KeyboardEvent<HTMLDialogElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target instanceof HTMLElement ? event.target : null;
    /* The clips carry no controls of their own here, so Space is free to be
       the toolbar's toggle from anywhere in the panel. A focused button spends
       it on its own press. */
    if (event.key === " " && hasVideo && !target?.closest("button, a")) {
      event.preventDefault();
      togglePlayback();
      return;
    }
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    const delta = event.key === "ArrowLeft" ? -1 : 1;
    const inColumn = target?.closest<HTMLElement>("[data-col]")?.dataset.col;
    /* From outside the columns the first press lands on the nearer end, or on
       the column last walked to. At either end the walk stops rather than
       wrapping, so the edge of the set can be felt. */
    const from = inColumn !== undefined ? Number(inColumn) : current;
    const next = from === null ? (delta > 0 ? 0 : shown.length - 1) : from + delta;
    if (next < 0 || next >= shown.length) return;
    event.preventDefault();
    heads.current[next]?.focus();
  };

  const rows = compareRows(shown);
  const n = shown.length;

  return (
    <dialog
      ref={ref}
      aria-label={`Compare ${n} runs`}
      className="ohf-compare"
      data-closing={closing || undefined}
      onClose={onClose}
      /* Escape would close the dialog outright, so it is intercepted and
         routed through the same exit as every other dismissal. */
      onCancel={(event) => {
        event.preventDefault();
        leave(onClose);
      }}
      onKeyDown={onKeyDown}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className="ohf-dialog-panel ohf-compare-panel"
        style={{ "--n": n } as CSSProperties}
        /* Descendants animate too (the figures pop in), so only the panel's
           own animation ends the exit. */
        onAnimationEnd={(event) => {
          if (closing && event.target === event.currentTarget) after.current();
        }}
      >
        <header className="ohf-compare-head">
          <div className="ohf-compare-title">
            <h2 className="ohf-compare-heading">Compare</h2>
            <p className="ohf-compare-sub">
              {n} runs · ← → moves between columns
              {hasVideo && " · Space plays and pauses"}
            </p>
          </div>
          <div className="ohf-compare-tools">
            {hasVideo && (
              <button
                type="button"
                className="ohf-btn-solid ohf-compare-play"
                aria-label={playing ? "Pause all clips" : "Play all clips"}
                onClick={togglePlayback}
              >
                {playing ? <PauseIcon size={14} /> : <PlayIcon size={14} />}
                {playing ? "Pause" : "Play"}
              </button>
            )}
            <button
              type="button"
              className="ohf-icon-btn ohf-compare-close"
              aria-label="Close"
              title="Close · Esc"
              onClick={() => leave(onClose)}
            >
              <CloseIcon size={13} />
            </button>
          </div>
        </header>

        <div className="ohf-compare-body ohf-scroll">
          {/* One table, not one per column: a dial is judged by reading it
              across, so every run's value for it sits on the same line. The
              runs are the columns — their media stands in the column heads —
              and the dials are the rows. */}
          <table className="ohf-compare-table">
            <colgroup>
              <col className="ohf-compare-col-label" />
              {shown.map((item, index) => (
                <col key={item.id} data-on={current === index || undefined} />
              ))}
            </colgroup>
            <thead>
              <tr>
                <td />
                {shown.map((item, index) => (
                  <Column
                    key={item.id}
                    item={item}
                    index={index}
                    count={n}
                    headRef={(cell) => {
                      heads.current[index] = cell;
                    }}
                    onFocusColumn={() => setCurrent(index)}
                    onVideo={register}
                    onPlayback={syncPlaying}
                    onFavorite={onFavorite}
                    onDownload={onDownload}
                  />
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const diff = row.compared && differs(row.values);
                return (
                  <tr key={row.key} className={diff ? "ohf-compare-diff" : undefined}>
                    <th scope="row">
                      {row.label}
                      {diff && <span className="ohf-sr"> — differs</span>}
                    </th>
                    {row.values.map((value, index) => (
                      <td
                        key={shown[index]!.id}
                        className={row.key === "prompt" ? "ohf-compare-prompt" : undefined}
                      >
                        {value}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </dialog>
  );
}

/* One run's column head: the media at the ratio it was submitted at, then the
   model and the two keeping actions. The cell itself takes focus so the arrows
   have somewhere to land that is not a button. */
function Column({
  item,
  index,
  count,
  headRef,
  onFocusColumn,
  onVideo,
  onPlayback,
  onFavorite,
  onDownload,
}: {
  item: RunRecord & Judged;
  index: number;
  count: number;
  headRef: (cell: HTMLTableCellElement | null) => void;
  onFocusColumn: () => void;
  onVideo: (id: string, video: HTMLVideoElement | null) => void;
  onPlayback: () => void;
  onFavorite: (id: string, keep: boolean) => void;
  onDownload: (item: RunRecord) => Promise<void>;
}) {
  const [saving, setSaving] = useState(false);
  const [w = 3, h = 2] = item.ratio.split("/").map((part) => Number.parseFloat(part));
  /* The submitted ratio frames the box until the media reports the shape it
     actually is — the platform rounds results onto its own pixel grid, and a
     box left at the submitted ratio would letterbox the picture over a seam
     of the artwork underneath. */
  const [delivered, setDelivered] = useState<number | null>(null);
  const aspect = delivered ?? w / h;
  const url = item.urls[0];
  const kept = item.favorite === true;

  /* Measured on attach as well as on load: the grid has already fetched this
     URL, so the element is usually complete before React can hear its event. */
  const measure = useCallback((media: HTMLImageElement | HTMLVideoElement | null) => {
    if (!media) return;
    const shape = shapeOf(media);
    if (shape !== null) setDelivered(shape);
  }, []);

  const attachVideo = useCallback(
    (video: HTMLVideoElement | null) => {
      onVideo(item.id, video);
      measure(video);
    },
    [item.id, onVideo, measure],
  );

  return (
    <th
      ref={headRef}
      scope="col"
      tabIndex={0}
      data-col={index}
      className="ohf-compare-col"
      aria-label={`Run ${index + 1} of ${count} — ${item.modelLabel}${item.verdict ? ` — ${VERDICT_LABELS[item.verdict]}` : ""}`}
      onFocus={onFocusColumn}
    >
      <figure
        className="ohf-compare-figure"
        data-shaped={delivered !== null || undefined}
        style={{ aspectRatio: String(aspect), "--a": aspect.toFixed(4) } as CSSProperties}
      >
        <span className="ohf-compare-art" style={{ background: item.art }} />
        {url ? (
          item.kind === "video" ? (
            /* No controls of their own: the toolbar is the one control, so a
               clip paused by hand cannot fall out of step with the others. */
            <video
              ref={attachVideo}
              className="ohf-compare-media"
              src={url}
              muted
              loop
              autoPlay
              playsInline
              preload="metadata"
              onLoadedMetadata={(event) => measure(event.currentTarget)}
              onPlay={onPlayback}
              onPause={onPlayback}
            />
          ) : (
            /* Platform CDN host is not known at build time. */
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              ref={measure}
              className="ohf-compare-media"
              src={url}
              alt={item.prompt}
              onLoad={(event) => measure(event.currentTarget)}
            />
          )
        ) : (
          <span className="ohf-grain" />
        )}
      </figure>
      <div className="ohf-compare-meta">
        <div className="ohf-compare-name">
          <h3 className="ohf-compare-model">
            <ModelIcon modelId={item.modelId} size={16} />
            {item.modelLabel}
          </h3>
          {/* The call rides the time line, in the word's own colour: which
              column won is read before any dial is. */}
          <div className="ohf-compare-when">
            {timeAgo(item.createdAt)}
            {item.verdict && (
              <>
                {" · "}
                <span className="ohf-verdict" data-verdict={item.verdict}>
                  {VERDICT_LABELS[item.verdict]}
                </span>
              </>
            )}
          </div>
        </div>
        <div className="ohf-compare-acts">
          {/* Absent on a run the platform returned no file for. The press is
              guarded rather than disabled while saving, so the button keeps the
              focus that is walking the columns. */}
          {url && (
            <button
              type="button"
              className="ohf-icon-btn ohf-compare-act"
              aria-label={saving ? "Saving" : "Download run"}
              title={saving ? "Saving" : "Download"}
              onClick={() => {
                if (saving) return;
                setSaving(true);
                void onDownload(item).finally(() => setSaving(false));
              }}
            >
              {saving ? <span className="ohf-spinner" aria-hidden /> : <DownloadIcon size={14} />}
            </button>
          )}
          <button
            type="button"
            className="ohf-icon-btn ohf-compare-act ohf-compare-keep"
            data-on={kept}
            aria-pressed={kept}
            aria-label={kept ? "Remove from favorites" : "Save to favorites"}
            title={kept ? "Remove from favorites" : "Save to favorites"}
            onClick={() => onFavorite(item.id, !kept)}
          >
            <HeartIcon size={14} filled={kept} />
          </button>
        </div>
      </div>
    </th>
  );
}
