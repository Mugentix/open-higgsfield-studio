import { describe, expect, it } from "vitest";

import { parsePlane } from "@/generation/parse-plane";

/* The plane is what the browser sends; every field is read back against the
   catalog before it is trusted. nano-banana-pro (reference cap 8, image) and
   seedance-2 (start 1, end 1, reference 9, video) are the fixtures. */

const IMG = "https://media.test/t/team/u/2026/09/a.png";

function plane(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { model: "nano-banana-pro", prompt: { text: "a red mug" }, media: {}, settings: {}, ...overrides };
}

describe("parsePlane: shape", () => {
  it("reads a minimal plane and fills the model's default settings", () => {
    const out = parsePlane(plane());
    expect(out).toEqual({
      model: "nano-banana-pro",
      prompt: { text: "a red mug" },
      media: {},
      settings: { aspectRatio: "1:1", resolution: "1k", outputFormat: "png" },
    });
  });

  it("trims the prompt", () => {
    expect(parsePlane(plane({ prompt: { text: "  spaced  " } })).prompt.text).toBe("spaced");
  });

  it("rejects a plane that is not an object", () => {
    expect(() => parsePlane(null)).toThrow("Invalid generation");
    expect(() => parsePlane([])).toThrow("Invalid generation");
    expect(() => parsePlane("nano-banana-pro")).toThrow("Invalid generation");
  });

  it("rejects a missing or malformed prompt", () => {
    expect(() => parsePlane(plane({ prompt: undefined }))).toThrow("Invalid prompt");
    expect(() => parsePlane(plane({ prompt: "a red mug" }))).toThrow("Invalid prompt");
  });

  it("rejects media and settings that are not objects", () => {
    expect(() => parsePlane(plane({ media: [] }))).toThrow("Invalid media");
    expect(() => parsePlane(plane({ settings: "1:1" }))).toThrow("Invalid settings");
  });
});

describe("parsePlane: model", () => {
  it("rejects an unknown model", () => {
    expect(() => parsePlane(plane({ model: "definitely-not-a-model" }))).toThrow("Unknown model: definitely-not-a-model");
  });

  it("rejects a model that is not a string", () => {
    expect(() => parsePlane(plane({ model: 42 }))).toThrow("Invalid model");
    expect(() => parsePlane(plane({ model: undefined }))).toThrow("Invalid model");
  });

  it("does not resolve legacy aliases here: the id must be a catalog id", () => {
    expect(() => parsePlane(plane({ model: "Nano Banana Pro" }))).toThrow(/Unknown model/);
  });
});

describe("parsePlane: empty prompt", () => {
  it("rejects an empty or blank prompt for a model that takes one", () => {
    expect(() => parsePlane(plane({ prompt: { text: "" } }))).toThrow("Prompt is required");
    expect(() => parsePlane(plane({ prompt: { text: "   " } }))).toThrow("Prompt is required");
    expect(() => parsePlane(plane({ prompt: {} }))).toThrow("Prompt is required");
    expect(() => parsePlane(plane({ model: "seedance-2", prompt: { text: "" } }))).toThrow("Prompt is required");
  });

  it("allows an empty prompt for a promptless utility and keeps the text empty", () => {
    const out = parsePlane(
      plane({ model: "topaz-upscale", prompt: { text: "" }, media: { reference: [{ url: IMG }] } }),
    );
    expect(out.prompt.text).toBe("");
    expect(out.settings).toEqual({ upscaleFactor: "2" });
    expect(parsePlane(plane({ model: "remove-background", prompt: {} })).prompt.text).toBe("");
  });

  it("still trims and keeps a synthetic tile line a utility plane carries", () => {
    expect(parsePlane(plane({ model: "crisp-upscale", prompt: { text: " Crisp upscale " } })).prompt.text).toBe("Crisp upscale");
  });
});

describe("parsePlane: prompt length", () => {
  it("accepts exactly 30000 characters", () => {
    expect(parsePlane(plane({ prompt: { text: "x".repeat(30_000) } })).prompt.text).toHaveLength(30_000);
  });

  it("rejects 30001 characters", () => {
    expect(() => parsePlane(plane({ prompt: { text: "x".repeat(30_001) } }))).toThrow("Prompt longer than 30000 characters");
  });

  it("measures after trimming, so padding does not push a prompt over", () => {
    expect(parsePlane(plane({ prompt: { text: `  ${"x".repeat(30_000)}  ` } })).prompt.text).toHaveLength(30_000);
  });
});

describe("parsePlane: media urls", () => {
  it.each([
    ["ftp://files.test/a.png"],
    ["javascript:alert(1)"],
    ["data:image/png;base64,AAAA"],
    ["file:///etc/passwd"],
    ["//media.test/a.png"],
    ["media.test/a.png"],
    ["https://media.test/with space.png"],
    [""],
  ])("rejects the non-http url %j", (url) => {
    expect(() => parsePlane(plane({ media: { reference: [{ url }] } }))).toThrow("Invalid reference media url");
  });

  it("rejects a url that is not a string", () => {
    expect(() => parsePlane(plane({ media: { reference: [{ url: 7 }] } }))).toThrow("Invalid reference media url");
    expect(() => parsePlane(plane({ media: { reference: [{}] } }))).toThrow("Invalid reference media url");
  });

  it("rejects a media item that is not an object and a role list that is not an array", () => {
    expect(() => parsePlane(plane({ media: { reference: [IMG] } }))).toThrow("Invalid reference media");
    expect(() => parsePlane(plane({ media: { reference: { url: IMG } } }))).toThrow("Invalid reference media");
  });

  it("accepts http and https, case-insensitively", () => {
    const out = parsePlane(plane({ media: { reference: [{ url: "HTTP://media.test/a.png" }, { url: IMG }] } }));
    expect(out.media.reference?.map((item) => item.url)).toEqual(["HTTP://media.test/a.png", IMG]);
  });

  it("names the role in the error", () => {
    expect(() => parsePlane(plane({ model: "seedance-2", media: { start: [{ url: "nope" }] } }))).toThrow("Invalid start media url");
  });
});

describe("parsePlane: role caps", () => {
  it("keeps at most the model's cap for a role (nano-banana-pro reference: 8)", () => {
    const list = Array.from({ length: 12 }, (_, i) => ({ id: `ref-${i}`, url: `${IMG}?n=${i}` }));
    const out = parsePlane(plane({ media: { reference: list } }));
    expect(out.media.reference).toHaveLength(8);
    expect(out.media.reference?.map((item) => item.id)).toEqual(list.slice(0, 8).map((item) => item.id));
  });

  it("keeps one start and one end frame for seedance-2 and drops the rest", () => {
    const out = parsePlane(
      plane({
        model: "seedance-2",
        media: {
          start: [{ url: `${IMG}?s=1` }, { url: `${IMG}?s=2` }],
          end: [{ url: `${IMG}?e=1` }, { url: `${IMG}?e=2` }],
        },
      }),
    );
    expect(out.media.start).toEqual([{ id: "start-0", url: `${IMG}?s=1`, role: "start" }]);
    expect(out.media.end).toEqual([{ id: "end-0", url: `${IMG}?e=1`, role: "end" }]);
  });

  it("drops a role the model does not offer at all (cap 0) instead of failing", () => {
    const out = parsePlane(plane({ media: { start: [{ url: IMG }], audio: [{ url: IMG }] } }));
    expect(out.media).toEqual({});
  });

  it("does not emit a role whose list was empty", () => {
    expect(parsePlane(plane({ media: { reference: [] } })).media).toEqual({});
  });

  it("ignores keys that are not media roles", () => {
    const out = parsePlane(plane({ media: { reference: [{ url: IMG }], mask: [{ url: "nope" }] } }));
    expect(Object.keys(out.media)).toEqual(["reference"]);
  });

  it("still validates the first item past the cap before it stops reading", () => {
    /* Nine items on a cap of eight: the ninth is checked, then the loop stops.
       This documents the current order (validate, then cap) rather than a
       promise; a bad url that far down is rejected, not silently dropped. */
    const list = Array.from({ length: 8 }, (_, i) => ({ url: `${IMG}?n=${i}` }));
    expect(() => parsePlane(plane({ media: { reference: [...list, { url: "nope" }] } }))).toThrow("Invalid reference media url");
  });
});

describe("parsePlane: lineage", () => {
  it("keeps assetId, resultId and the item id when they are strings", () => {
    const out = parsePlane(
      plane({
        media: {
          reference: [
            { id: "one", url: IMG, assetId: "asset-1" },
            { id: "two", url: IMG, resultId: "result-1" },
            { id: "three", url: IMG, assetId: "asset-2", resultId: "result-2" },
          ],
        },
      }),
    );
    expect(out.media.reference).toEqual([
      { id: "one", url: IMG, role: "reference", assetId: "asset-1" },
      { id: "two", url: IMG, role: "reference", resultId: "result-1" },
      { id: "three", url: IMG, role: "reference", assetId: "asset-2", resultId: "result-2" },
    ]);
  });

  it("drops a non-string assetId or resultId and mints an id when none is given", () => {
    const out = parsePlane(plane({ media: { reference: [{ url: IMG, assetId: 12, resultId: null, id: 5 }] } }));
    expect(out.media.reference).toEqual([{ id: "reference-0", url: IMG, role: "reference" }]);
    expect(out.media.reference?.[0]).not.toHaveProperty("assetId");
    expect(out.media.reference?.[0]).not.toHaveProperty("resultId");
  });

  it("overrides whatever role the item claimed with the list it sits in", () => {
    const out = parsePlane(plane({ media: { reference: [{ url: IMG, role: "start" }] } }));
    expect(out.media.reference?.[0]?.role).toBe("reference");
  });
});

describe("parsePlane: settings", () => {
  it("rejects a value outside the model's enum", () => {
    expect(() => parsePlane(plane({ settings: { aspectRatio: "7:3" } }))).toThrow("Invalid aspectRatio");
  });

  it("rejects a range value outside the model's bounds", () => {
    expect(() => parsePlane(plane({ model: "seedance-2", settings: { duration: 99 } }))).toThrow("Invalid duration");
  });

  it("drops settings the model does not declare and defaults the ones it does", () => {
    const out = parsePlane(plane({ settings: { resolution: "4k", nonsense: true, duration: 99 } }));
    expect(out.settings).toEqual({ aspectRatio: "1:1", resolution: "4k", outputFormat: "png" });
  });

  it("falls back to the default when a setting has the wrong type", () => {
    const out = parsePlane(plane({ model: "seedance-2", settings: { duration: "10", generateAudio: "no" } }));
    expect(out.settings).toMatchObject({ duration: 5, generateAudio: true });
  });
});
