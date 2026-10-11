import { afterEach, describe, expect, it, vi } from "vitest";

import {
  exportNameFor,
  saveZip,
  uniqueEntries,
  zipNameFor,
  type ExportRecord,
} from "@/openhiggsfield/download";
import type { RunRecord } from "@/openhiggsfield/history";

/* Built from local calendar parts so the stamp reads the same in every zone
   the suite happens to run in. */
const DAY = new Date(2026, 8, 28, 15, 30).getTime();
const CTX = { product: "Nike Air", project: "Summer Drop 2026" };

function record(overrides: Partial<ExportRecord> = {}): ExportRecord {
  return {
    id: "res_01hxyzabc123",
    modelId: "nano-banana-pro",
    ratio: "16 / 9",
    kind: "image",
    urls: ["https://cdn.example.com/out/final.png?token=1"],
    createdAt: DAY,
    ...overrides,
  };
}

describe("exportNameFor", () => {
  it("files by product, project, model, format, day and the id's tail", () => {
    expect(exportNameFor(record(), CTX, 0)).toBe(
      "nike-air-summer-drop-2026-nano-banana-pro-16x9-20260928-abc123.png",
    );
  });

  it("slugs every segment to lowercase ascii words", () => {
    const name = exportNameFor(record({ modelId: "Wan 2.7 (Prime)" }), { product: "  ACME & Co.!! ", project: "Q4/Launch" }, 0);
    expect(name).toBe("acme-co-q4-launch-wan-2-7-prime-16x9-20260928-abc123.png");
    expect(name).toMatch(/^[a-z0-9.-]+$/);
    expect(name).not.toMatch(/--/);
  });

  it("folds accents to their base letters instead of losing them", () => {
    expect(exportNameFor(record(), { product: "Beşir Café", project: "Über Léon Ñandú" }, 0)).toMatch(
      /^besir-cafe-uber-leon-nandu-/,
    );
  });

  it("cuts a long product or project name without leaving a trailing dash", () => {
    const long = "A very long product name that keeps going on and on forever";
    const name = exportNameFor(record(), { product: long }, 0);
    const [productPart] = name.split("-nano-banana-pro-");
    expect(productPart!.length).toBeLessThanOrEqual(40);
    expect(productPart).not.toMatch(/-$/);
    expect(name).toBe("a-very-long-product-name-that-keeps-goin-nano-banana-pro-16x9-20260928-abc123.png");
  });

  it("writes the aspect as WxH from either the css or the setting form", () => {
    expect(exportNameFor(record({ ratio: "16 / 9" }), CTX, 0)).toContain("-16x9-");
    expect(exportNameFor(record({ ratio: "9:16" }), CTX, 0)).toContain("-9x16-");
    expect(exportNameFor(record({ ratio: "1 / 1" }), CTX, 0)).toContain("-1x1-");
    expect(exportNameFor(record({ ratio: "auto" }), CTX, 0)).toContain("-auto-");
  });

  it("leaves the aspect out when the run has none", () => {
    expect(exportNameFor(record({ ratio: "" }), CTX, 0)).toBe(
      "nike-air-summer-drop-2026-nano-banana-pro-20260928-abc123.png",
    );
  });

  it("takes the extension from the url, lowercased, past any query or hash", () => {
    expect(exportNameFor(record({ urls: ["https://cdn.example.com/a/b.JPEG?x=1"] }), CTX, 0)).toMatch(/\.jpeg$/);
    expect(exportNameFor(record({ urls: ["https://cdn.example.com/a/b.webp#frag"] }), CTX, 0)).toMatch(/\.webp$/);
    expect(exportNameFor(record({ urls: ["https://cdn.example.com/a/clip.mov"], kind: "video" }), CTX, 0)).toMatch(/\.mov$/);
  });

  it("falls back to the kind when the url names no extension", () => {
    expect(exportNameFor(record({ urls: ["https://cdn.example.com/blob/abc"] }), CTX, 0)).toMatch(/\.png$/);
    expect(exportNameFor(record({ urls: ["https://cdn.example.com/blob/abc"], kind: "video" }), CTX, 0)).toMatch(/\.mp4$/);
    expect(exportNameFor(record({ urls: [] }), CTX, 0)).toMatch(/\.png$/);
    expect(exportNameFor(record({ urls: [], kind: "video" }), CTX, 0)).toMatch(/\.mp4$/);
  });

  it("does not mistake a dotted directory for an extension", () => {
    expect(exportNameFor(record({ urls: ["https://cdn.example.com/v1.2/abc"] }), CTX, 0)).toMatch(/\.png$/);
  });

  it("drops a missing product or project without leaving a gap", () => {
    expect(exportNameFor(record(), { project: "Summer Drop 2026" }, 0)).toBe(
      "summer-drop-2026-nano-banana-pro-16x9-20260928-abc123.png",
    );
    expect(exportNameFor(record(), { product: "Nike Air" }, 0)).toBe(
      "nike-air-nano-banana-pro-16x9-20260928-abc123.png",
    );
    expect(exportNameFor(record(), {}, 0)).toBe("nano-banana-pro-16x9-20260928-abc123.png");
    expect(exportNameFor(record(), { product: "", project: "   " }, 0)).toBe(
      "nano-banana-pro-16x9-20260928-abc123.png",
    );
  });

  it("uses the last six characters of the id, or all of a shorter one", () => {
    expect(exportNameFor(record({ id: "0123456789" }), {}, 0)).toContain("-456789.");
    expect(exportNameFor(record({ id: "ab" }), {}, 0)).toContain("-ab.");
    expect(exportNameFor(record({ id: "req_7f3#0" }), {}, 0)).toContain("-7f3-0.");
  });

  it("stamps the run's own day", () => {
    const newYear = new Date(2027, 0, 1, 0, 5).getTime();
    expect(exportNameFor(record({ createdAt: newYear }), {}, 0)).toContain("-20270101-");
  });

  it("numbers a duplicate from the second copy and leaves the first clean", () => {
    expect(exportNameFor(record(), CTX)).toBe(exportNameFor(record(), CTX, 0));
    expect(exportNameFor(record(), CTX, 0)).toMatch(/-abc123\.png$/);
    expect(exportNameFor(record(), CTX, 1)).toMatch(/-abc123-2\.png$/);
    expect(exportNameFor(record(), CTX, 4)).toMatch(/-abc123-5\.png$/);
  });

  it("accepts a full RunRecord as well", () => {
    const full: RunRecord = {
      ...record(),
      surface: "image",
      modelLabel: "Nano Banana Pro",
      prompt: "a studio shot",
      meta: "",
      status: "completed",
      art: "",
    };
    expect(exportNameFor(full, CTX, 0)).toBe("nike-air-summer-drop-2026-nano-banana-pro-16x9-20260928-abc123.png");
  });
});

describe("zipNameFor", () => {
  it("files the archive by product, project and today", () => {
    expect(zipNameFor(CTX, DAY)).toBe("nike-air-summer-drop-2026-20260928.zip");
  });

  it("uses whichever word is known, or a plain stem when neither is", () => {
    expect(zipNameFor({ project: "Summer Drop 2026" }, DAY)).toBe("summer-drop-2026-20260928.zip");
    expect(zipNameFor({ product: "Nike Air" }, DAY)).toBe("nike-air-20260928.zip");
    expect(zipNameFor({}, DAY)).toBe("export-20260928.zip");
  });
});

describe("uniqueEntries", () => {
  it("keeps two colliding records apart inside one archive", () => {
    const a = record({ id: "run_a_abc123", urls: ["https://cdn.example.com/a.png"] });
    const b = record({ id: "run_b_abc123", urls: ["https://cdn.example.com/b.png"] });
    const names = [a, b].map((row) => exportNameFor(row, CTX, 0));
    expect(names[0]).toBe(names[1]);

    const entries = uniqueEntries([a, b].map((row, i) => ({ name: names[i]!, url: row.urls[0]! })));
    expect(new Set(entries.map((entry) => entry.name)).size).toBe(2);
    expect(entries[0]!.name).toBe("nike-air-summer-drop-2026-nano-banana-pro-16x9-20260928-abc123.png");
    expect(entries[1]!.name).toBe("nike-air-summer-drop-2026-nano-banana-pro-16x9-20260928-abc123-2.png");
    expect(entries[1]!.url).toBe("https://cdn.example.com/b.png");
  });

  it("numbers every later duplicate and steps past a name already taken", () => {
    const names = uniqueEntries(
      ["a.png", "a.png", "a-2.png", "a.png", "b"].map((name) => ({ name, url: "" })),
    ).map((entry) => entry.name);
    expect(names).toEqual(["a.png", "a-2.png", "a-2-2.png", "a-3.png", "b"]);
    expect(new Set(names).size).toBe(names.length);
  });

  it("returns distinct entries untouched and never mutates the input", () => {
    const input = [{ name: "a.png", url: "1" }, { name: "b.png", url: "2" }, { name: "a.png", url: "3" }];
    const snapshot = structuredClone(input);
    const out = uniqueEntries(input);
    expect(out[0]).toBe(input[0]);
    expect(out[1]).toBe(input[1]);
    expect(out[2]).not.toBe(input[2]);
    expect(input).toEqual(snapshot);
  });
});

/* The archive is built in node against a stubbed fetch and a stubbed anchor:
   the bytes are real, only the browser's save dialog is stood in for. */
describe("saveZip", () => {
  type Anchor = { href: string; download: string; click: ReturnType<typeof vi.fn> };

  function stubBrowser(bodies: Record<string, string | null>) {
    const anchors: Anchor[] = [];
    const blobs: Blob[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const body = bodies[url];
        if (body === undefined) throw new TypeError("Failed to fetch");
        return body === null ? new Response(null, { status: 403 }) : new Response(body);
      }),
    );
    vi.stubGlobal("document", {
      createElement: () => {
        const anchor: Anchor = { href: "", download: "", click: vi.fn() };
        anchors.push(anchor);
        return anchor;
      },
    });
    const createObjectURL = vi.fn((blob: Blob) => {
      blobs.push(blob);
      return `blob:test/${blobs.length}`;
    });
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", Object.assign(Object.create(URL), { createObjectURL, revokeObjectURL }));
    return { anchors, blobs, createObjectURL, revokeObjectURL };
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("writes every file into one archive, renaming a collision, and offers it under the zip name", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const stub = stubBrowser({
      "https://cdn.example.com/a.png": "bytes-of-a",
      "https://cdn.example.com/b.png": "bytes-of-b",
    });

    const onProgress = vi.fn();
    const ok = await saveZip(
      [
        { name: "same.png", url: "https://cdn.example.com/a.png" },
        { name: "same.png", url: "https://cdn.example.com/b.png" },
      ],
      "nike-air-20260928.zip",
      { onProgress },
    );

    expect(ok).toBe(true);
    expect(onProgress.mock.calls).toEqual([
      [0, 2],
      [1, 2],
      [2, 2],
    ]);
    expect(stub.anchors).toHaveLength(1);
    expect(stub.anchors[0]!.download).toBe("nike-air-20260928.zip");
    expect(stub.anchors[0]!.href).toBe("blob:test/1");
    expect(stub.anchors[0]!.click).toHaveBeenCalledOnce();

    const bytes = new Uint8Array(await stub.blobs[0]!.arrayBuffer());
    expect([bytes[0], bytes[1]]).toEqual([0x50, 0x4b]);
    const text = new TextDecoder("latin1").decode(bytes);
    expect(text).toContain("same.png");
    expect(text).toContain("same-2.png");
    expect(text).toContain("bytes-of-a");
    expect(text).toContain("bytes-of-b");

    expect(stub.revokeObjectURL).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(stub.revokeObjectURL).toHaveBeenCalledWith("blob:test/1");
  });

  it("refuses the whole archive when one file cannot be read", async () => {
    const stub = stubBrowser({
      "https://cdn.example.com/a.png": "bytes-of-a",
      "https://cdn.example.com/b.png": null,
    });
    const ok = await saveZip(
      [
        { name: "a.png", url: "https://cdn.example.com/a.png" },
        { name: "b.png", url: "https://cdn.example.com/b.png" },
      ],
      "export-20260928.zip",
    );
    expect(ok).toBe(false);
    expect(stub.anchors).toHaveLength(0);
    expect(stub.createObjectURL).not.toHaveBeenCalled();
  });

  it("reports a network refusal the same way", async () => {
    const stub = stubBrowser({});
    expect(await saveZip([{ name: "a.png", url: "https://cdn.example.com/gone.png" }], "x.zip")).toBe(false);
    expect(stub.anchors).toHaveLength(0);
  });

  it("has nothing to offer for an empty selection", async () => {
    const stub = stubBrowser({});
    expect(await saveZip([], "x.zip")).toBe(false);
    expect(stub.anchors).toHaveLength(0);
  });
});
