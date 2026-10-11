"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { UseTarget } from "@/generation/attach";
import type { MediaRole } from "@/generation/catalog";

import {
  hasPlane,
  NOTE_LIMIT,
  settingLabel,
  settingValueLabel,
  TILE_TOOLS,
  tileTool,
  type Judged,
  type Verdict,
  VERDICT_KEYS,
  VERDICT_LABELS,
  verdictOfKey,
  VERDICTS,
} from "./data";
import { saveFile } from "./download";
import { timeAgo, type RunRecord } from "./history";
import { typingIn } from "./hotkeys";
import { ModelIcon } from "./model-icon";
import { CheckIcon, CloseIcon, CopyIcon, DownloadIcon, GemIcon, HeartIcon, OpenOutIcon, PlusIcon, RetryIcon, ShuffleIcon, TrashIcon } from "./icons";

/* Backstop only: the exit normally ends on the panel's own animationend. A
   backgrounded tab can defer that event indefinitely, and a dialog that never
   unmounts would trap the studio behind it. */
const EXIT_TIMEOUT_MS = 420;
/* Long enough to be read as a receipt, short enough that the button is back
   under the cursor before the visitor reaches for it again. */
const COPIED_MS = 1600;
/* The note's count appears only once the cap is in sight; a tally over an
   empty field would read as a limit before there is anything to limit. */
const NOTE_COUNT_FROM = NOTE_LIMIT - 100;

/* The relative time in the header answers "when"; this answers "which run",
   so it is written out in full and never abbreviated. */
const CREATED = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

/** The shape the media turned out to be, or null while it has none to report —
    a decoded image always has one, a video only once its metadata lands. */
function shapeOf(media: HTMLImageElement | HTMLVideoElement): number | null {
  const [width, height] =
    media instanceof HTMLVideoElement
      ? [media.videoWidth, media.videoHeight]
      : [media.naturalWidth, media.naturalHeight];
  return width > 0 && height > 0 ? width / height : null;
}

export function Viewer({
  item,
  onClose,
  onReuse,
  onFavorite,
  onDelete,
  onVerdict,
  onNote,
  onPrev,
  onNext,
  targets,
  onUse,
  onVariants,
  onUtility,
  downloadName,
}: {
  item: RunRecord & Judged;
  /** What the file is saved as. Named by the app, which knows the product and
      project the run belongs to; the dialog only knows the run. */
  downloadName: string;
  onClose: () => void;
  onReuse: () => void;
  onFavorite: () => void;
  onDelete: () => void;
  /** The team's call on this run, and the words behind it; null clears each. */
  onVerdict: (verdict: Verdict | null) => void;
  onNote: (note: string | null) => void;
  /** What this run can be used as next, given the model in the composer. */
  targets: UseTarget[];
  onUse: (role: MediaRole) => void;
  onVariants: () => void;
  /** A promptless utility run on this result, by catalog id. */
  onUtility: (modelId: string) => void;
  /* Absent at the ends of the scope, which is how the walk stops. */
  onPrev?: () => void;
  onNext?: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [closing, setClosing] = useState(false);
  const [copied, setCopied] = useState(false);
  /* What the exit was for. Captured at the click so a re-render mid-flight
     cannot swap the action out from under it. */
  const after = useRef(onClose);

  /* Opened off a tile's own button, and the exit hands focus back there —
     unless something else took it first, as Recreate does with the prompt.
     The opener is read once into a ref: React runs this effect twice in
     development, and a second read would find the dialog's own panel. */
  const opener = useRef<HTMLElement | null>(null);
  useEffect(() => {
    opener.current ??= document.activeElement instanceof HTMLElement ? document.activeElement : null;
    ref.current?.showModal();
    // Focus the panel itself so no action button opens pre-ringed.
    panelRef.current?.focus();
    return () => {
      if (document.activeElement === null || document.activeElement === document.body) opener.current?.focus();
    };
  }, []);

  /* The note as typed, or null while the field shows the saved words
     unchanged — so a teammate's edit arriving through the feed is shown, not
     fought. It is handed over when the field is left, and only when it
     differs from what is saved: a refused save leaves the words in the field
     for the next try rather than emptying it. A dialog that unmounts never
     fires blur, so every way out, and every step to the next run, flushes it
     first. */
  const [draft, setDraft] = useState<string | null>(null);
  const noteRef = useRef({ draft, saved: item.note ?? "" });
  noteRef.current = { draft, saved: item.note ?? "" };
  const flushNote = useCallback(() => {
    const { draft, saved } = noteRef.current;
    if (draft === null) return;
    const next = draft.trim();
    if (next !== saved) onNote(next || null);
  }, [onNote]);

  /* Every way out plays the same exit. The dialog stays mounted and open
     while it runs — calling close(), or letting the parent drop it, would cut
     the animation on its first frame. */
  const leave = useCallback(
    (action: () => void) => {
      if (closing) return;
      flushNote();
      after.current = action;
      setClosing(true);
    },
    [closing, flushNote],
  );

  useEffect(() => {
    if (!closing) return;
    const timer = setTimeout(() => after.current(), EXIT_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [closing]);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  const copyPrompt = useCallback(() => {
    /* Rejection is handled rather than caught-and-dropped: the label only ever
       says "Copied" when the write actually landed. */
    void navigator.clipboard.writeText(item.prompt).then(
      () => setCopied(true),
      () => setCopied(false),
    );
  }, [item.prompt]);

  /* The result is served from the platform's own CDN, so `download` on an
     anchor is ignored and a plain click opens a tab instead of saving. The
     bytes are read first and handed over as a blob; the href stays the file
     itself, so right-click → Save link as and the refused-read fallback below
     both have somewhere real to go. Keyed by run rather than a bare flag:
     stepping to the next one mid-save must not land that result on the button
     of a run it was not for. */
  const [save, setSave] = useState<{ id: string; state: "saving" | "failed" } | null>(null);
  const saveState = save?.id === item.id ? save.state : null;

  const [w = 3, h = 2] = item.ratio.split("/").map((n) => Number.parseFloat(n));
  /* The platform rounds results onto its own pixel grid, so a run submitted at
     21:9 can come back 1584×672 — 2.357, not 2.333. The submitted ratio only
     frames the box until the media reports the shape it actually is; leaving
     it in place lets object-fit letterbox the picture and shows the artwork
     underneath as a bright seam along one edge. */
  const [delivered, setDelivered] = useState<number | null>(null);
  /* Stepping to the next run swaps the media under a live dialog, so the state
     measured from the last one is reset here rather than in an effect — a frame
     rendered at the previous run's shape would letterbox the new picture, and a
     "Copied" receipt would sit over a prompt nobody copied. */
  const [shown, setShown] = useState(item.id);
  if (shown !== item.id) {
    setShown(item.id);
    setDelivered(null);
    setCopied(false);
    setDraft(null);
  }
  const note = draft ?? item.note ?? "";
  const aspect = delivered ?? w / h;
  const url = item.urls[0];

  /* Measured on attach as well as on load: the grid has already fetched this
     URL, so the element is usually complete before React can hear its event. */
  const measure = useCallback((media: HTMLImageElement | HTMLVideoElement | null) => {
    if (!media) return;
    const shape = shapeOf(media);
    if (shape !== null) setDelivered(shape);
  }, []);
  /* Older records predate the stored plane; their one-line meta is all the
     output detail that survives, so it stands in for the dial-by-dial list. */
  const facts: Array<[string, string]> = item.settings
    ? Object.entries(item.settings).map(([key, value]) => [
        settingLabel(key),
        settingValueLabel(key, value),
      ])
    : item.meta
      ? [["Output", item.meta]]
      : [];

  return (
    <dialog
      ref={ref}
      aria-label={`Run — ${item.modelLabel}`}
      className="ohf-viewer"
      data-closing={closing || undefined}
      onClose={onClose}
      /* Escape would close the dialog outright, so it is intercepted and
         routed through the same exit as every other dismissal. */
      onCancel={(event) => {
        event.preventDefault();
        leave(onClose);
      }}
      /* The dialog is modal and opens with the panel focused, so everything the
         visitor can reach is inside it — the arrows are read here rather than
         from a listener on the document. Stepping is not a dismissal: the
         dialog stays open and the media is swapped underneath it. */
      onKeyDown={(event) => {
        /* A focused player spends the arrows on seeking, which is what they
           mean once someone is scrubbing a clip; in the note the letters are
           words, and the arrows move the caret. */
        if (event.target instanceof HTMLVideoElement || typingIn(event.target)) return;
        /* A held key repeats; a verdict key would flip the call once per
           repeat, and the arrows would hand the note over mid-step. */
        if (event.repeat) return;
        const key = event.key.toLowerCase();
        const plain = !event.metaKey && !event.ctrlKey && !event.altKey;
        /* W, T and X: the same letters the grid answers to. A call is not a
           dismissal — the dialog stays, the button lights — and the press
           stops here so the grid cannot make it a second time underneath. */
        const verdict = plain && url ? verdictOfKey(key) : undefined;
        if (verdict) {
          event.preventDefault();
          event.stopPropagation();
          onVerdict(item.verdict === verdict ? null : verdict);
          return;
        }
        const role: MediaRole | null = key === "r" ? "reference" : key === "s" ? "start" : key === "e" ? "end" : key === "v" ? "video" : null;
        if (role && plain && targets.some((t) => t.role === role)) {
          event.preventDefault();
          event.stopPropagation();
          leave(() => onUse(role));
          return;
        }
        /* U and B, the same letters the grid answers to: the tool leaves
           through the dialog's exit and lands beside this run. The press stops
           here so the grid's listener cannot run it a second time. */
        const tool = plain && url ? tileTool(item.kind, key) : undefined;
        if (tool) {
          event.preventDefault();
          event.stopPropagation();
          leave(() => onUtility(tool.modelId));
          return;
        }
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        const step = event.key === "ArrowLeft" ? onPrev : onNext;
        if (!step || closing) return;
        event.preventDefault();
        /* The note belongs to the run on screen; it is handed over before
           the next one takes its place. */
        flushNote();
        step();
      }}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className="ohf-dialog-panel ohf-viewer-panel"
        /* Descendants animate too (the sidebar slides, the media fades), so
           only the panel's own animation ends the exit. */
        onAnimationEnd={(event) => {
          if (closing && event.target === event.currentTarget) after.current();
        }}
      >
        {/* The ground around the picture dismisses, the way it does in every
            lightbox; the labelled close in the sidebar is the keyboard path. */}
        <div
          className="ohf-viewer-stage"
          onClick={(event) => {
            if (event.target === event.currentTarget) leave(onClose);
          }}
        >
          <figure
            className="ohf-viewer-figure"
            data-shaped={delivered !== null || undefined}
            style={{ aspectRatio: String(aspect), "--a": aspect.toFixed(4) } as React.CSSProperties}
          >
            <span className="ohf-viewer-art" style={{ background: item.art }} />
            {url ? (
              item.kind === "video" ? (
                <video
                  ref={measure}
                  className="ohf-viewer-media"
                  src={url}
                  controls
                  autoPlay
                  loop
                  playsInline
                  onLoadedMetadata={(event) => measure(event.currentTarget)}
                />
              ) : (
                /* Platform CDN host is not known at build time. */
                /* eslint-disable-next-line @next/next/no-img-element */
                <img
                  ref={measure}
                  className="ohf-viewer-media"
                  src={url}
                  alt={item.prompt}
                  onLoad={(event) => measure(event.currentTarget)}
                />
              )
            ) : (
              <span className="ohf-grain" />
            )}
          </figure>
        </div>

        <aside className="ohf-viewer-side" aria-label="Run details">
          <header className="ohf-viewer-side-head">
            <div className="ohf-viewer-title">
              <h2 className="ohf-viewer-model">
                <ModelIcon modelId={item.modelId} size={18} />
                {item.modelLabel}
              </h2>
              <div className="ohf-viewer-when">{timeAgo(item.createdAt)}</div>
            </div>
            <button
              type="button"
              className="ohf-icon-btn ohf-viewer-close"
              aria-label="Close"
              onClick={() => leave(onClose)}
            >
              <CloseIcon size={13} />
            </button>
          </header>

          <div className="ohf-viewer-side-body">
            <section className="ohf-viewer-block">
              <div className="ohf-viewer-block-head">
                <h3 className="ohf-viewer-label">Prompt</h3>
                <button
                  type="button"
                  className="ohf-viewer-copy"
                  data-done={copied || undefined}
                  onClick={copyPrompt}
                >
                  {copied ? <CheckIcon size={12} /> : <CopyIcon size={12} />}
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
              <p className="ohf-viewer-prompt">{item.prompt}</p>
            </section>

            {/* The team's call and the words behind it, on a run that has a
                file to judge. Toggle buttons rather than a menu: three words
                are the whole vocabulary, and the one that holds is state, so
                it stands lit. */}
            {url && (
              <section className="ohf-viewer-block">
                <h3 className="ohf-viewer-label">Verdict</h3>
                <div className="ohf-viewer-verdicts" role="group" aria-label="Verdict">
                  {VERDICTS.map((verdict) => {
                    const on = item.verdict === verdict;
                    return (
                      <button
                        key={verdict}
                        type="button"
                        className="ohf-btn-solid ohf-viewer-verdict"
                        data-verdict={verdict}
                        data-on={on}
                        aria-pressed={on}
                        title={`${VERDICT_LABELS[verdict]} · ${VERDICT_KEYS[verdict].toUpperCase()}`}
                        onClick={() => onVerdict(on ? null : verdict)}
                      >
                        {VERDICT_LABELS[verdict]}
                        <span className="ohf-viewer-use-hint">{VERDICT_KEYS[verdict].toUpperCase()}</span>
                      </button>
                    );
                  })}
                  {item.verdict && (
                    <button
                      type="button"
                      className="ohf-btn-solid ohf-viewer-verdict ohf-viewer-verdict--clear"
                      onClick={() => onVerdict(null)}
                    >
                      Clear
                    </button>
                  )}
                </div>
                <textarea
                  className="ohf-input ohf-input--area ohf-viewer-note"
                  aria-label="Note"
                  placeholder="Why it won, what to test next — kept when you leave the field"
                  maxLength={NOTE_LIMIT}
                  value={note}
                  onChange={(event) => setDraft(event.target.value)}
                  onBlur={flushNote}
                />
                {note.length >= NOTE_COUNT_FROM && (
                  <span className="ohf-viewer-note-count" aria-hidden>
                    {note.length} / {NOTE_LIMIT}
                  </span>
                )}
              </section>
            )}

            <section className="ohf-viewer-block">
              <h3 className="ohf-viewer-label">Details</h3>
              <dl className="ohf-viewer-facts">
                <div className="ohf-viewer-fact">
                  <dt>Model</dt>
                  <dd>{item.modelLabel}</dd>
                </div>
                {facts.map(([label, value]) => (
                  <div className="ohf-viewer-fact" key={label}>
                    <dt>{label}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
                <div className="ohf-viewer-fact">
                  <dt>Created</dt>
                  <dd>{CREATED.format(item.createdAt)}</dd>
                </div>
              </dl>
            </section>
          </div>

          <footer className="ohf-viewer-side-foot">
            {/* Recreate is the loop the studio is built on: it loads this run's
                model, dials and words back into the composer. */}
            {hasPlane(item) && (
              <button
                type="button"
                className="ohf-cta ohf-viewer-recreate"
                onClick={() => leave(onReuse)}
              >
                <RetryIcon />
                Recreate
              </button>
            )}
            {/* Names the refusal and the way past it: the same press, now
                falling through to the anchor's own navigation, hands the file
                to a tab the browser can save from. */}
            {saveState === "failed" && (
              <p className="ohf-viewer-save-note" role="status">
                The platform’s CDN refused the read. Open the file to save it from the browser.
              </p>
            )}
            {/* The loop, at full size: this run becomes the next one's input
                with one press, and the model that takes it is named when the
                composer's cannot. Variants re-submit the very same plane. */}
            {url && (targets.length > 0 || TILE_TOOLS[item.kind].length > 0) && (
              <div className="ohf-viewer-use" role="group" aria-label="Use this run">
                {targets.map((target) => (
                  <button
                    key={target.role}
                    type="button"
                    className="ohf-btn-solid"
                    title={target.modelLabel ? `Switches to ${target.modelLabel}` : undefined}
                    onClick={() => leave(() => onUse(target.role))}
                  >
                    <PlusIcon size={13} />
                    {target.label}
                    {target.modelLabel && <span className="ohf-viewer-use-hint">{target.modelLabel}</span>}
                  </button>
                ))}
                {hasPlane(item) && (
                  <button type="button" className="ohf-btn-solid" title="Four more from the same plane" onClick={() => leave(onVariants)}>
                    <ShuffleIcon size={13} />
                    Variants ×4
                  </button>
                )}
                {/* Tools work on this result as it is, with the entry's
                    defaults, and land beside it. */}
                {TILE_TOOLS[item.kind].map((tool) => (
                  <button
                    key={tool.modelId}
                    type="button"
                    className="ohf-btn-solid"
                    title={`${tool.label} · ${tool.key.toUpperCase()}`}
                    onClick={() => leave(() => onUtility(tool.modelId))}
                  >
                    <GemIcon size={13} />
                    {tool.label}
                  </button>
                ))}
              </div>
            )}
            <div className="ohf-viewer-foot-row">
              {url && (
                <a
                  className="ohf-btn-solid ohf-viewer-download"
                  data-state={saveState ?? undefined}
                  href={url}
                  download={downloadName}
                  target={saveState === "failed" ? "_blank" : undefined}
                  rel="noreferrer"
                  title={
                    saveState === "failed"
                      ? "The platform’s CDN refused the read — opens the file in a new tab"
                      : "Save the file to this device"
                  }
                  onClick={(event) => {
                    /* Once refused, the press is the fallback: let the anchor
                       navigate rather than fetching the same refusal again. */
                    if (saveState === "failed") return;
                    event.preventDefault();
                    if (saveState === "saving") return;
                    setSave({ id: item.id, state: "saving" });
                    void saveFile(url, downloadName).then((ok) =>
                      setSave(ok ? null : { id: item.id, state: "failed" }),
                    );
                  }}
                >
                  {saveState === "saving" ? (
                    <span className="ohf-spinner" aria-hidden />
                  ) : saveState === "failed" ? (
                    <OpenOutIcon />
                  ) : (
                    <DownloadIcon />
                  )}
                  {saveState === "saving" ? "Saving" : saveState === "failed" ? "Open file" : "Download"}
                </a>
              )}
              {/* Between the two keeping actions, the way it sits between them on
                  the card: the middle is the hardest slot to hit by accident,
                  and this is the one press here that discards a run. It leaves
                  through the same exit as every other dismissal, and the undo
                  bar in the composer catches it. */}
              <button
                type="button"
                className="ohf-icon-btn ohf-viewer-trash"
                aria-label="Delete run"
                title="Delete run"
                onClick={() => leave(onDelete)}
              >
                <TrashIcon size={15} />
              </button>
              {/* The keep lives wherever the run does, so opening one full size
                  does not send the visitor back to the grid to save it. */}
              <button
                type="button"
                className="ohf-icon-btn ohf-viewer-keep"
                data-on={item.favorite === true}
                aria-pressed={item.favorite === true}
                aria-label={item.favorite ? "Remove from favorites" : "Save to favorites"}
                title={item.favorite ? "Remove from favorites" : "Save to favorites"}
                onClick={onFavorite}
              >
                <HeartIcon size={15} filled={item.favorite === true} />
              </button>
            </div>
          </footer>
        </aside>
      </div>
    </dialog>
  );
}
