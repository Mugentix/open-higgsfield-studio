"use client";

import { useRef } from "react";
import type { CSSProperties } from "react";

import { COMPARE_MAX, COMPARE_MIN, canCompare } from "./compare";
import type { Judged, Verdict } from "./data";
import type { RunRecord } from "./history";
import { CloseIcon, CompareIcon, DownloadIcon, HeartIcon, PlayBadgeIcon, TrashIcon } from "./icons";

/** How many runs the count stack shows before it stops drawing new sheets. */
const STACK = 3;

export interface SaveProgress {
  done: number;
  total: number;
}

/* The composer's replacement, not a second floating layer: while runs are
   picked the dock carries this instead, in the same slot and against the same
   bottom edge, so the swap reads as one control becoming another.

   It stays mounted once the studio has ever had a selection — the bar has to
   be present to animate away, and it needs the last non-empty selection to
   avoid flashing "0 selected" on its way out. */
export function SelectionBar({
  records,
  saving,
  onCompare,
  onDownload,
  onFavorite,
  onVerdict,
  onDelete,
  onClose,
}: {
  records: Array<RunRecord & Judged>;
  saving: SaveProgress | null;
  onCompare: () => void;
  onDownload: () => void;
  onFavorite: () => void;
  /** The team's call on the whole selection; null takes it back. */
  onVerdict: (verdict: Verdict | null) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const on = records.length > 0;
  /* The exiting bar keeps saying what it was acting on. */
  const held = useRef(records);
  if (on) held.current = records;
  const shown = held.current;

  const count = shown.length;
  const saveable = shown.filter((record) => record.urls[0]).length;
  const allKept = shown.every((record) => record.favorite === true);
  const allWinners = shown.every((record) => record.verdict === "winner");
  const allKilled = shown.every((record) => record.verdict === "killed");
  const noun = count === 1 ? "run" : "runs";
  /* A set already called is released by the same press, as the heart releases
     a kept set — which is what a pressed control has to mean. */
  const winnerLabel = allWinners
    ? `Take back winner on ${count} ${noun}`
    : `Mark ${count} ${noun} ${count === 1 ? "a winner" : "winners"}`;
  const killLabel = allKilled ? `Take back killed on ${count} ${noun}` : `Kill ${count} ${noun}`;

  /* Several files travel as one archive; the tip says so, since "Download"
     on its own promises the files themselves. */
  const downloadLabel = saving
    ? `Saving ${saving.done} of ${saving.total}`
    : saveable === 0
      ? "Nothing here to download"
      : saveable < count
        ? `Download ${saveable} of ${count}${saveable > 1 ? " as one zip" : ""}`
        : saveable > 1
          ? `Download ${count} as one zip`
          : "Download";
  const comparable = canCompare(count);
  const compareLabel = comparable
    ? "Compare side by side"
    : `Pick ${COMPARE_MIN} to ${COMPARE_MAX} runs to compare`;

  return (
    /* A labelled group rather than role="toolbar": the toolbar pattern promises
       arrow-key navigation between its controls, and five buttons the visitor
       can already tab through do not need a second set of keys to learn. */
    <div
      className="ohf-selbar"
      role="group"
      aria-label="Bulk actions"
      data-on={on}
      inert={!on}
    >
      {/* Picking is done in the grid and reported here, so the count says so
          out loud rather than leaving the change silent. */}
      <p className="ohf-selbar-count" role="status">
        <span className="ohf-selstack" aria-hidden>
          {shown.slice(-STACK).map((record, index, sheets) => (
            <span
              key={record.id}
              className="ohf-selchip"
              style={{ "--z": sheets.length - 1 - index, background: record.art } as CSSProperties}
            >
              {record.kind === "image" && record.urls[0] ? (
                /* Platform CDN host, same as the grid: next/image would need
                   every provider domain allow-listed up front. */
                /* eslint-disable-next-line @next/next/no-img-element */
                <img src={record.urls[0]} alt="" />
              ) : (
                record.kind === "video" && (
                  <span className="ohf-selchip-play">
                    <PlayBadgeIcon size={7} />
                  </span>
                )
              )}
            </span>
          ))}
        </span>
        {/* One phrase, one flex item — the stack's gap must not open between
            the number and the word it counts. */}
        <span className="ohf-selbar-text">
          <span className="ohf-selbar-n" key={count}>
            {count}
          </span>{" "}
          selected
        </span>
      </p>

      <span className="ohf-selbar-rule" aria-hidden />

      {/* Reads the picked runs against each other; the number of columns the
          dialog can hold is its own to say. */}
      <span className="ohf-selbar-slot ohf-tip" data-tip={compareLabel}>
        <button
          type="button"
          className="ohf-selact ohf-selact--wide"
          disabled={!comparable}
          aria-label={compareLabel}
          onClick={onCompare}
        >
          <CompareIcon size={15} />
          <span className="ohf-selact-label">Compare</span>
        </button>
      </span>

      <span className="ohf-selbar-slot ohf-tip" data-tip={downloadLabel}>
        <button
          type="button"
          className="ohf-selact ohf-selact--wide"
          disabled={saveable === 0 || saving !== null}
          aria-label={downloadLabel}
          onClick={onDownload}
        >
          {saving ? <span className="ohf-spinner" aria-hidden /> : <DownloadIcon size={15} />}
          <span className="ohf-selact-label">
            {saving ? `${saving.done}/${saving.total}` : "Download"}
          </span>
        </button>
      </span>

      {/* The team's call in bulk — the two ends of it, which is what a set is
          marked as together; Testing is called one run at a time, from the
          card or the viewer. Words, not glyphs: there is no picture for
          "winner" that reads faster than the word. */}
      <button
        type="button"
        className="ohf-selact ohf-selact--word ohf-tip"
        data-tip={winnerLabel}
        data-on={allWinners}
        aria-pressed={allWinners}
        aria-label={winnerLabel}
        onClick={() => onVerdict(allWinners ? null : "winner")}
      >
        <span className="ohf-selact-label">Winner</span>
      </button>

      <button
        type="button"
        className="ohf-selact ohf-selact--word ohf-selact--kill ohf-tip"
        data-tip={killLabel}
        data-on={allKilled}
        aria-pressed={allKilled}
        aria-label={killLabel}
        onClick={() => onVerdict(allKilled ? null : "killed")}
      >
        <span className="ohf-selact-label">Kill</span>
      </button>

      <button
        type="button"
        className="ohf-selact ohf-tip"
        data-tip={
          allKept ? `Remove ${count} ${noun} from favorites` : `Save ${count} ${noun} to favorites`
        }
        data-on={allKept}
        aria-pressed={allKept}
        aria-label={allKept ? "Remove from favorites" : "Save to favorites"}
        onClick={onFavorite}
      >
        <HeartIcon size={16} filled={allKept} />
      </button>

      <button
        type="button"
        className="ohf-selact ohf-selact--danger ohf-tip"
        data-tip={`Delete ${count} ${noun}`}
        aria-label={`Delete ${count} ${noun}`}
        onClick={onDelete}
      >
        <TrashIcon size={15} />
      </button>

      <span className="ohf-selbar-rule" aria-hidden />

      <button
        type="button"
        className="ohf-selact ohf-selact--quiet ohf-tip ohf-tip--end"
        data-tip="Clear selection · Esc"
        aria-label="Clear selection"
        onClick={onClose}
      >
        <CloseIcon size={14} />
      </button>
    </div>
  );
}
