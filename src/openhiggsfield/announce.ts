/* What the studio says out loud. A screen reader hears nothing when a run
   settles on a wall that may be scrolled away, or when a letter key makes the
   team's call on a tile — both are silent changes to the grid — so the app
   carries one polite live region and these lines are what it reads. Pure,
   so the wording is pinned by a test. */

import { VERDICT_LABELS, type Verdict } from "./data";

/** How one result of a request ended, as the wall records it. */
export type RunOutcome = { status: "completed" | "failed"; error?: string };

/** One line for a request that settled: "Nano Banana Pro finished · 2
    results", or the failure and its reason. A batch that lost some of its
    results says both. Null when nothing settled, so nothing is read. */
export function runAnnouncement(modelLabel: string, outcomes: readonly RunOutcome[]): string | null {
  const done = outcomes.filter((outcome) => outcome.status === "completed").length;
  const failed = outcomes.filter((outcome) => outcome.status === "failed");
  if (done === 0 && failed.length === 0) return null;
  if (done === 0) return `${modelLabel} failed — ${failed[0]?.error ?? "the platform reported a failure"}`;
  const results = `${done} ${done === 1 ? "result" : "results"}`;
  return failed.length > 0
    ? `${modelLabel} finished · ${results} · ${failed.length} failed`
    : `${modelLabel} finished · ${results}`;
}

/** One line for a call made or taken back: "Winner — a packshot on slate",
    "Verdict cleared — 3 runs". The subject is the run's own words, or the
    count when the call was made on a selection. */
export function verdictAnnouncement(verdict: Verdict | null, subject: string): string {
  return `${verdict ? VERDICT_LABELS[verdict] : "Verdict cleared"} — ${subject}`;
}
