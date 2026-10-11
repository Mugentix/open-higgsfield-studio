import { describe, expect, it } from "vitest";

import { COMPARE_MAX, COMPARE_MIN, canCompare, compareRows, differs } from "@/openhiggsfield/compare";
import type { RunRecord } from "@/openhiggsfield/history";

/* The dialog's table is judged by reading a dial across the columns, so the
   rows it builds are pinned here: which facts appear, in what order, and
   which differences are worth pointing at. */

function run(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: "res_1",
    surface: "image",
    modelId: "nano-banana-pro",
    modelLabel: "Nano Banana Pro",
    prompt: "A packshot on slate",
    ratio: "16 / 9",
    meta: "2K · PNG",
    kind: "image",
    urls: ["https://cdn.example.com/a.png"],
    status: "completed",
    art: "",
    createdAt: Date.UTC(2026, 8, 28, 12, 0),
    settings: { aspectRatio: "16:9", resolution: "2K" },
    ...overrides,
  };
}

describe("canCompare", () => {
  it("takes two to four runs and nothing outside that", () => {
    expect(canCompare(0)).toBe(false);
    expect(canCompare(1)).toBe(false);
    expect(canCompare(COMPARE_MIN)).toBe(true);
    expect(canCompare(3)).toBe(true);
    expect(canCompare(COMPARE_MAX)).toBe(true);
    expect(canCompare(COMPARE_MAX + 1)).toBe(false);
  });
});

describe("compareRows", () => {
  it("leads with prompt and model, then every dial in first-met order, then the clock", () => {
    const rows = compareRows([
      run(),
      run({ id: "res_2", settings: { aspectRatio: "9:16", resolution: "2K", outputFormat: "png" } }),
    ]);
    expect(rows.map((row) => row.key)).toEqual([
      "prompt",
      "model",
      "setting:aspectRatio",
      "setting:resolution",
      "setting:outputFormat",
      "created",
    ]);
    expect(rows.map((row) => row.label)).toEqual(["Prompt", "Model", "Aspect ratio", "Resolution", "Format", "Created"]);
  });

  it("reads the values in the settings panel's own words and dashes a dial a run lacks", () => {
    const rows = compareRows([run(), run({ id: "res_2", settings: { aspectRatio: "9:16", outputFormat: "png" } })]);
    const byKey = new Map(rows.map((row) => [row.key, row.values]));
    expect(byKey.get("setting:aspectRatio")).toEqual(["16:9", "9:16"]);
    expect(byKey.get("setting:resolution")).toEqual(["2K", "—"]);
    expect(byKey.get("setting:outputFormat")).toEqual(["—", "PNG"]);
  });

  it("adds an Output row only when a run predates the stored plane", () => {
    const withPlanes = compareRows([run(), run({ id: "res_2" })]);
    expect(withPlanes.some((row) => row.key === "meta")).toBe(false);

    const legacy = compareRows([run(), run({ id: "res_2", settings: undefined, meta: "1K · JPG" })]);
    const output = legacy.find((row) => row.key === "meta");
    expect(output?.label).toBe("Output");
    expect(output?.values).toEqual(["2K · PNG", "1K · JPG"]);
  });

  it("never marks the clock as a difference", () => {
    const rows = compareRows([run(), run({ id: "res_2", createdAt: Date.UTC(2026, 8, 28, 12, 5) })]);
    const created = rows.find((row) => row.key === "created");
    expect(created?.compared).toBe(false);
    expect(rows.filter((row) => row.key !== "created").every((row) => row.compared)).toBe(true);
  });
});

describe("differs", () => {
  it("is true only when some column disagrees with the first", () => {
    expect(differs(["16:9", "9:16"])).toBe(true);
    expect(differs(["2K", "2K", "2K"])).toBe(false);
    expect(differs(["2K", "2K", "—"])).toBe(true);
    expect(differs(["alone"])).toBe(false);
  });
});
