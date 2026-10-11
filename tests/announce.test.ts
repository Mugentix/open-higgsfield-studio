import { describe, expect, it } from "vitest";

import { runAnnouncement, verdictAnnouncement } from "@/openhiggsfield/announce";
import { VERDICTS, VERDICT_LABELS } from "@/openhiggsfield/data";

/* The app's live region reads these lines to a screen reader when a run
   settles or a letter key makes the team's call, so the wording is pinned
   here: what is said, and when nothing is. */

describe("runAnnouncement", () => {
  it("names the model and counts its results", () => {
    expect(runAnnouncement("Nano Banana Pro", [{ status: "completed" }])).toBe("Nano Banana Pro finished · 1 result");
    expect(runAnnouncement("Nano Banana Pro", [{ status: "completed" }, { status: "completed" }])).toBe(
      "Nano Banana Pro finished · 2 results",
    );
  });

  it("reports a failure with its reason, and a stock reason when the platform gave none", () => {
    expect(runAnnouncement("Seedance 2.5", [{ status: "failed", error: "content flagged" }])).toBe(
      "Seedance 2.5 failed — content flagged",
    );
    expect(runAnnouncement("Seedance 2.5", [{ status: "failed" }])).toBe(
      "Seedance 2.5 failed — the platform reported a failure",
    );
  });

  it("says both when a batch lost some of its results", () => {
    expect(
      runAnnouncement("Nano Banana Pro", [{ status: "completed" }, { status: "failed", error: "timeout" }, { status: "completed" }]),
    ).toBe("Nano Banana Pro finished · 2 results · 1 failed");
  });

  it("says nothing when nothing settled", () => {
    expect(runAnnouncement("Nano Banana Pro", [])).toBeNull();
  });
});

describe("verdictAnnouncement", () => {
  it("leads with the call and ends with the run's words", () => {
    for (const verdict of VERDICTS) {
      expect(verdictAnnouncement(verdict, "a packshot on slate")).toBe(`${VERDICT_LABELS[verdict]} — a packshot on slate`);
    }
  });

  it("says a call was taken back", () => {
    expect(verdictAnnouncement(null, "3 runs")).toBe("Verdict cleared — 3 runs");
  });
});
