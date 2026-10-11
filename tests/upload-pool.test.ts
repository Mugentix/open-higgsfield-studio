import { describe, expect, it } from "vitest";

import { UPLOAD_CONCURRENCY, uploadPool } from "@/openhiggsfield/upload-pool";

/* A batch of references goes up three at a time. The pool must hand results
   back in the files' order however they finish, never let one refused file
   sink the batch, and never hold more than its limit in flight. */

function file(name: string): File {
  return new File(["x"], name, { type: "image/png" });
}

/* A worker whose completions the test releases by hand, so the order they
   finish in is chosen, not raced. */
function gate() {
  const pending = new Map<string, { resolve: (url: string) => void; reject: (error: Error) => void }>();
  const started: string[] = [];
  let inFlight = 0;
  let peak = 0;
  const work = (entry: File) =>
    new Promise<{ url: string; assetId: string }>((resolve, reject) => {
      started.push(entry.name);
      inFlight++;
      peak = Math.max(peak, inFlight);
      pending.set(entry.name, {
        resolve: (url) => {
          inFlight--;
          resolve({ url, assetId: `asset-${entry.name}` });
        },
        reject: (error) => {
          inFlight--;
          reject(error);
        },
      });
    });
  const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  return {
    work,
    started,
    peak: () => peak,
    async finish(name: string) {
      pending.get(name)!.resolve(`https://files.example.com/${name}`);
      pending.delete(name);
      await tick();
    },
    async fail(name: string, message: string) {
      pending.get(name)!.reject(new Error(message));
      pending.delete(name);
      await tick();
    },
    tick,
  };
}

describe("uploadPool", () => {
  it("defaults to three in flight", () => {
    expect(UPLOAD_CONCURRENCY).toBe(3);
  });

  it("keeps the files' order in the results whatever order they finish in", async () => {
    const g = gate();
    const files = ["a", "b", "c", "d", "e"].map(file);
    const settled: string[] = [];
    const run = uploadPool(files, g.work, { onSettled: (result) => settled.push(result.file.name) });
    await g.tick();
    expect(g.started).toEqual(["a", "b", "c"]);
    await g.finish("c");
    await g.finish("a");
    await g.finish("e");
    await g.finish("b");
    await g.finish("d");
    const results = await run;
    expect(results.map((result) => result.file.name)).toEqual(["a", "b", "c", "d", "e"]);
    expect(results.map((result) => result.url)).toEqual(
      ["a", "b", "c", "d", "e"].map((name) => `https://files.example.com/${name}`),
    );
    expect(results.every((result) => result.error === undefined)).toBe(true);
    /* onSettled fires as each finishes, so a caller can stage a url early. */
    expect(settled).toEqual(["c", "a", "e", "b", "d"]);
  });

  it("never holds more than the limit in flight", async () => {
    const g = gate();
    const files = ["a", "b", "c", "d", "e", "f", "g"].map(file);
    const run = uploadPool(files, g.work);
    await g.tick();
    expect(g.started).toHaveLength(3);
    await g.finish("a");
    expect(g.started).toHaveLength(4);
    await g.finish("b");
    await g.finish("c");
    expect(g.started).toHaveLength(6);
    for (const name of ["d", "e", "f", "g"]) await g.finish(name);
    await run;
    expect(g.peak()).toBeLessThanOrEqual(3);
    expect(g.started).toEqual(["a", "b", "c", "d", "e", "f", "g"]);
  });

  it("honours a smaller limit", async () => {
    const g = gate();
    const run = uploadPool(["a", "b", "c"].map(file), g.work, { concurrency: 1 });
    await g.tick();
    expect(g.started).toEqual(["a"]);
    await g.finish("a");
    expect(g.started).toEqual(["a", "b"]);
    await g.finish("b");
    await g.finish("c");
    await run;
    expect(g.peak()).toBe(1);
  });

  it("reports one failure as one result and carries on with the rest", async () => {
    const g = gate();
    const run = uploadPool(["a", "b", "c", "d"].map(file), g.work);
    await g.tick();
    await g.fail("b", "the store refused the file (413)");
    await g.finish("a");
    await g.finish("c");
    await g.finish("d");
    const results = await run;
    expect(results.map((result) => result.file.name)).toEqual(["a", "b", "c", "d"]);
    expect(results[1]).toEqual({ file: results[1]!.file, error: "the store refused the file (413)" });
    expect(results[1]!.url).toBeUndefined();
    expect(results[0]).toMatchObject({ url: "https://files.example.com/a", assetId: "asset-a" });
    expect(results[3]).toMatchObject({ url: "https://files.example.com/d", assetId: "asset-d" });
  });

  it("resolves an empty batch to an empty list", async () => {
    const g = gate();
    expect(await uploadPool([], g.work)).toEqual([]);
    expect(g.started).toEqual([]);
  });
});
