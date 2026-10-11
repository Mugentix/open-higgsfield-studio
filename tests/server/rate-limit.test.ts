import { eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { envForTests, resetStubs, stubKie, useTestDatabase, type TestDb } from "./harness";

import * as schema from "@/server/db/schema";
import { BUCKET_CAPACITY, BUCKET_REFILL_PER_SECOND, bucketKeyFor, takeToken } from "@/server/rate-limit";

let db: TestDb;

/* One PGlite for the file (boot is the slow part); the bucket table is wiped
   between tests. KIE is stubbed only so that any stray fetch throws. */
beforeAll(async () => {
  envForTests();
  db = await useTestDatabase();
  stubKie();
});

beforeEach(async () => {
  await db.delete(schema.rateBuckets);
});

afterAll(() => resetStubs());

async function bucket(key: string) {
  const row = await db.query.rateBuckets.findFirst({ where: (b, { eq }) => eq(b.key, key) });
  if (!row) throw new Error(`no bucket ${key}`);
  return { ...row, tokens: Number(row.tokens) };
}

async function age(key: string, ms: number): Promise<void> {
  await db
    .update(schema.rateBuckets)
    .set({ updatedAt: new Date(Date.now() - ms) })
    .where(eq(schema.rateBuckets.key, key));
}

async function drain(key: string): Promise<boolean[]> {
  const granted: boolean[] = [];
  for (let i = 0; i < BUCKET_CAPACITY; i++) granted.push((await takeToken(key)).granted);
  return granted;
}

describe("bucketKeyFor", () => {
  it("is a short sha256 prefix that never carries the raw key", () => {
    const raw = "sk-live-0123456789abcdefABCDEF";
    const key = bucketKeyFor(raw);

    expect(key).toBe(`kie:${createHash("sha256").update(raw).digest("hex").slice(0, 16)}`);
    expect(key).toMatch(/^kie:[0-9a-f]{16}$/);
    expect(key).not.toContain(raw);
    expect(key).not.toContain("0123456789");
    expect(key).not.toContain("sk-live");
  });

  it("is stable for one key and distinct across keys", () => {
    expect(bucketKeyFor("alpha")).toBe(bucketKeyFor("alpha"));
    expect(bucketKeyFor("alpha")).not.toBe(bucketKeyFor("alphb"));
  });
});

describe("takeToken", () => {
  it("grants a full burst then denies with a positive retry hint", async () => {
    const key = bucketKeyFor("key-a");

    expect(await drain(key)).toEqual(Array<boolean>(BUCKET_CAPACITY).fill(true));

    const denied = await takeToken(key);
    expect(denied.granted).toBe(false);
    expect(denied.retryAfterMs).toBeGreaterThan(0);
    // One token at the refill rate, plus the 100 ms the caller is told to add.
    expect(denied.retryAfterMs).toBeLessThanOrEqual(Math.ceil(1000 / BUCKET_REFILL_PER_SECOND) + 100);

    const row = await bucket(key);
    expect(row.tokens).toBeGreaterThanOrEqual(0);
    expect(row.tokens).toBeLessThan(1);
    const all = await db.select().from(schema.rateBuckets);
    expect(all.map((b) => b.key)).toEqual([key]);
  });

  it("accounts one token per grant, starting from capacity minus the first", async () => {
    const key = bucketKeyFor("key-small");
    const slow = 0.001;

    expect((await takeToken(key, 3, slow)).granted).toBe(true);
    expect((await bucket(key)).tokens).toBeCloseTo(2, 2);
    expect((await takeToken(key, 3, slow)).granted).toBe(true);
    expect((await bucket(key)).tokens).toBeCloseTo(1, 2);
    expect((await takeToken(key, 3, slow)).granted).toBe(true);
    expect((await bucket(key)).tokens).toBeCloseTo(0, 2);

    const denied = await takeToken(key, 3, slow);
    expect(denied.granted).toBe(false);
    expect(denied.retryAfterMs).toBeGreaterThanOrEqual(900_000);
    expect((await bucket(key)).tokens).toBeCloseTo(0, 2);
  });

  it("refills with time and never above capacity", async () => {
    const key = bucketKeyFor("key-b");
    await drain(key);
    expect((await takeToken(key)).granted).toBe(false);

    // Two seconds of refill is 2 * rate tokens: that many grants, then a denial.
    await age(key, 2000);
    const refilled = Math.floor(2 * BUCKET_REFILL_PER_SECOND);
    const afterTwoSeconds: boolean[] = [];
    for (let i = 0; i < refilled + 2; i++) afterTwoSeconds.push((await takeToken(key)).granted);
    expect(afterTwoSeconds).toEqual([...Array<boolean>(refilled).fill(true), false, false]);

    // A minute idle would be 108 tokens; the bucket caps at capacity.
    await age(key, 60_000);
    expect((await takeToken(key)).granted).toBe(true);
    expect((await bucket(key)).tokens).toBeCloseTo(BUCKET_CAPACITY - 1, 1);
    const rest: boolean[] = [];
    for (let i = 0; i < BUCKET_CAPACITY; i++) rest.push((await takeToken(key)).granted);
    expect(rest).toEqual([...Array<boolean>(BUCKET_CAPACITY - 1).fill(true), false]);
  });

  it("admits at most KIE's 20 task creations in any ten-second window", async () => {
    // A continuously refilled bucket admits capacity + rate * window; sized so
    // a full drain, ten seconds of refill and a second drain stay under 20.
    expect(BUCKET_CAPACITY + 10 * BUCKET_REFILL_PER_SECOND).toBeLessThanOrEqual(20);
    const key = bucketKeyFor("key-window");
    let granted = 0;
    const takeAll = async () => {
      for (;;) {
        if (!(await takeToken(key)).granted) return;
        granted++;
      }
    };
    /* The worst case: a burst, then every token taken the second it refills. */
    await takeAll();
    for (let second = 0; second < 10; second++) {
      await age(key, 1000);
      await takeAll();
    }
    expect(granted).toBeLessThanOrEqual(20);
    expect(granted).toBe(BUCKET_CAPACITY + 10 * BUCKET_REFILL_PER_SECOND);
  });

  it("keeps independent buckets per key", async () => {
    const a = bucketKeyFor("team-a-key");
    const b = bucketKeyFor("team-b-key");
    await drain(a);
    expect((await takeToken(a)).granted).toBe(false);

    expect((await takeToken(b)).granted).toBe(true);
    expect((await takeToken(a)).granted).toBe(false);

    expect((await bucket(b)).tokens).toBeCloseTo(BUCKET_CAPACITY - 1, 1);
    expect((await bucket(a)).tokens).toBeLessThan(1);
    const all = await db.select().from(schema.rateBuckets);
    expect(all.map((row) => row.key).sort()).toEqual([a, b].sort());
    expect(all.map((row) => row.key)).not.toContain("team-a-key");
  });
});
