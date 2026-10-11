import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { envForTests, resetStubs, seedTeam, stubKie, useMemoryStore, useTestDatabase, type MemoryStore, type TestDb } from "./harness";

import * as schema from "@/server/db/schema";
import { RETRY_LADDER_MS, backoffMs, claim, complete, enqueue, fail, type Job } from "@/server/jobs/queue";
import { DRAIN_LOCK_STALE_MS, kickJobs, runJobs, startDevWorker } from "@/server/jobs/runner";

let db: TestDb;
let store: MemoryStore;

const HOUR = 60 * 60_000;
const LEASE_MS = 120_000;

/* PGlite needs a couple of seconds to boot, so one database serves the file
   and the jobs table is wiped between tests; a job references nothing but an
   optional team. KIE is stubbed only so that any stray fetch throws. */
beforeAll(async () => {
  envForTests();
  db = await useTestDatabase();
  stubKie();
});

beforeEach(async () => {
  await db.delete(schema.jobs);
  store = useMemoryStore({ public: true });
  globalThis.__ohfJobsRunning = false;
});

afterEach(() => {
  vi.restoreAllMocks();
  if (globalThis.__ohfDevWorker) clearInterval(globalThis.__ohfDevWorker);
  globalThis.__ohfDevWorker = undefined;
  globalThis.__ohfJobsRunning = false;
});

afterAll(() => resetStubs());

async function jobRow(type: string, dedupeKey: string) {
  const row = await db.query.jobs.findFirst({
    where: (j, { and, eq }) => and(eq(j.type, type), eq(j.dedupeKey, dedupeKey)),
  });
  if (!row) throw new Error(`no job ${type}/${dedupeKey}`);
  return row;
}

function putObject(key: string): void {
  store.objects.set(key, { bytes: new Uint8Array([1, 2, 3]), contentType: "image/png" });
}

function jobFor(row: { id: string }, dedupeKey: string, attempts: number, maxAttempts = 6): Job {
  return { id: row.id, teamId: null, type: "purge_media", dedupeKey, payload: { key: dedupeKey }, attempts, maxAttempts };
}

describe("enqueue", () => {
  it("collapses the same (type, dedupe key) into one row carrying the latest payload", async () => {
    await enqueue("purge_media", "t/a/1.png", { key: "t/a/1.png", v: 1 });
    await enqueue("purge_media", "t/a/1.png", { key: "t/a/1.png", v: 2 });
    await enqueue("mirror_result", "t/a/1.png", { resultId: "r1" });

    const all = await db.select().from(schema.jobs).orderBy(schema.jobs.type);
    expect(all).toHaveLength(2);
    expect(all[1]).toMatchObject({
      type: "purge_media",
      dedupeKey: "t/a/1.png",
      teamId: null,
      status: "queued",
      attempts: 0,
      maxAttempts: 6,
      payload: { key: "t/a/1.png", v: 2 },
      lastError: null,
      lockedUntil: null,
      lockedBy: null,
    });
    expect(all[0]).toMatchObject({ type: "mirror_result", dedupeKey: "t/a/1.png", payload: { resultId: "r1" } });
  });

  it("keeps the team and honours runAfter and maxAttempts", async () => {
    const team = await seedTeam(db);
    const later = new Date(Date.now() + HOUR);
    await enqueue("purge_media", "a", { key: "a" }, { teamId: team.teamId, runAfter: later, maxAttempts: 2 });

    const row = await jobRow("purge_media", "a");
    expect(row.teamId).toBe(team.teamId);
    expect(row.maxAttempts).toBe(2);
    expect(row.runAfter.getTime()).toBe(later.getTime());
  });

  it.each(["done", "dead"] as const)("re-enqueue of a %s job resets it to queued with attempts 0 and the new payload", async (terminal) => {
    await enqueue("purge_media", "a", { key: "a", v: 1 });
    const [job] = await claim(1, "w1");
    if (terminal === "done") await complete(job!.id);
    else expect(await fail({ ...job!, attempts: job!.maxAttempts }, "gave up")).toBe("dead");
    const before = await jobRow("purge_media", "a");
    expect(before.status).toBe(terminal);
    expect(before.attempts).toBe(terminal === "done" ? 1 : 1);

    const due = new Date(Date.now() - 1000);
    await enqueue("purge_media", "a", { key: "a", v: 2 }, { runAfter: due });

    const all = await db.select().from(schema.jobs);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      id: job!.id,
      status: "queued",
      attempts: 0,
      payload: { key: "a", v: 2 },
      lastError: null,
    });
    expect(all[0]!.runAfter.getTime()).toBe(due.getTime());
    expect(all[0]!.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());
  });

  it("re-enqueue of a running job leaves its status, lease, attempts and schedule alone", async () => {
    await enqueue("purge_media", "a", { key: "a", v: 1 });
    const [job] = await claim(1, "w1");
    const running = await jobRow("purge_media", "a");
    expect(running.status).toBe("running");

    await enqueue("purge_media", "a", { key: "a", v: 2 }, { runAfter: new Date(Date.now() + HOUR) });

    const all = await db.select().from(schema.jobs);
    expect(all).toHaveLength(1);
    const after = all[0]!;
    expect(after.id).toBe(job!.id);
    expect(after.status).toBe("running");
    expect(after.attempts).toBe(1);
    expect(after.lockedBy).toBe("w1");
    expect(after.lockedUntil?.getTime()).toBe(running.lockedUntil?.getTime());
    expect(after.runAfter.getTime()).toBe(running.runAfter.getTime());
  });

  it("re-enqueue of a queued job keeps its attempts but takes the new schedule", async () => {
    await enqueue("purge_media", "a", { key: "a" });
    const [job] = await claim(1, "w1");
    expect(await fail(job!, "first try")).toBe("retry");
    const backedOff = await jobRow("purge_media", "a");
    expect(backedOff).toMatchObject({ status: "queued", attempts: 1, lastError: "first try" });

    const now = new Date();
    await enqueue("purge_media", "a", { key: "a" }, { runAfter: now });

    const row = await jobRow("purge_media", "a");
    expect(row).toMatchObject({ status: "queued", attempts: 1, lastError: null });
    expect(row.runAfter.getTime()).toBe(now.getTime());
  });
});

describe("claim", () => {
  it("takes only due jobs, oldest first, and leases them to the worker", async () => {
    const team = await seedTeam(db);
    await enqueue("purge_media", "late", { key: "late" }, { runAfter: new Date(Date.now() + HOUR) });
    await enqueue("purge_media", "b", { key: "b" }, { runAfter: new Date(Date.now() - 2000) });
    await enqueue("purge_media", "a", { key: "a" }, { runAfter: new Date(Date.now() - 3000), teamId: team.teamId });
    await enqueue("purge_media", "c", { key: "c" }, { runAfter: new Date(Date.now() - 1000) });

    const before = Date.now();
    const claimed = await claim(2, "worker-1");
    const after = Date.now();

    expect(claimed.map((j) => j.dedupeKey)).toEqual(["a", "b"]);
    expect(claimed[0]).toEqual({
      id: expect.any(String),
      teamId: team.teamId,
      type: "purge_media",
      dedupeKey: "a",
      payload: { key: "a" },
      attempts: 1,
      maxAttempts: 6,
    });
    expect(claimed[1]!.teamId).toBeNull();

    for (const key of ["a", "b"]) {
      const row = await jobRow("purge_media", key);
      expect(row).toMatchObject({ status: "running", lockedBy: "worker-1", attempts: 1 });
      expect(row.lockedUntil!.getTime()).toBeGreaterThanOrEqual(before + LEASE_MS - 1000);
      expect(row.lockedUntil!.getTime()).toBeLessThanOrEqual(after + LEASE_MS + 1000);
    }
    expect(await jobRow("purge_media", "c")).toMatchObject({ status: "queued", attempts: 0, lockedBy: null, lockedUntil: null });
    expect(await jobRow("purge_media", "late")).toMatchObject({ status: "queued", attempts: 0, lockedBy: null });

    const rest = await claim(10, "worker-1");
    expect(rest.map((j) => j.dedupeKey)).toEqual(["c"]);
    expect(await claim(10, "worker-1")).toEqual([]);
    expect(await jobRow("purge_media", "late")).toMatchObject({ status: "queued", attempts: 0 });
  });

  it("does not hand a leased job to a second worker", async () => {
    await enqueue("purge_media", "a", { key: "a" });
    const [first] = await claim(1, "w1");
    expect(first?.attempts).toBe(1);
    expect(await claim(1, "w2")).toEqual([]);
    expect(await jobRow("purge_media", "a")).toMatchObject({ status: "running", lockedBy: "w1", attempts: 1 });
  });

  it("reclaims a running job whose lease has run out", async () => {
    await enqueue("purge_media", "a", { key: "a" });
    const [first] = await claim(1, "w1");
    await db
      .update(schema.jobs)
      .set({ lockedUntil: new Date(Date.now() - 1000) })
      .where(eq(schema.jobs.id, first!.id));

    const before = Date.now();
    const [again] = await claim(1, "w2");
    expect(again).toMatchObject({ id: first!.id, dedupeKey: "a", attempts: 2 });

    const row = await jobRow("purge_media", "a");
    expect(row).toMatchObject({ status: "running", lockedBy: "w2", attempts: 2 });
    expect(row.lockedUntil!.getTime()).toBeGreaterThanOrEqual(before + LEASE_MS - 1000);
  });

  it("skips done and dead jobs", async () => {
    await enqueue("purge_media", "finished", { key: "finished" });
    await enqueue("purge_media", "buried", { key: "buried" });
    const claimed = await claim(2, "w1");
    const finished = claimed.find((j) => j.dedupeKey === "finished")!;
    const buried = claimed.find((j) => j.dedupeKey === "buried")!;
    await complete(finished.id);
    expect(await fail({ ...buried, attempts: buried.maxAttempts }, "no more")).toBe("dead");

    expect(await claim(10, "w2")).toEqual([]);
    expect(await jobRow("purge_media", "finished")).toMatchObject({ status: "done", lockedUntil: null, lockedBy: null });
    expect(await jobRow("purge_media", "buried")).toMatchObject({ status: "dead", lockedUntil: null, lockedBy: null });
  });
});

describe("complete and fail", () => {
  it("complete marks the job done and releases the lease", async () => {
    await enqueue("purge_media", "a", { key: "a" });
    const [job] = await claim(1, "w1");
    await complete(job!.id);

    const row = await jobRow("purge_media", "a");
    expect(row).toMatchObject({ status: "done", attempts: 1, lockedUntil: null, lockedBy: null, lastError: null });
  });

  it("the ladder is 30s, 2m, 10m, 1h, 6h and clamps at both ends", () => {
    expect([...RETRY_LADDER_MS]).toEqual([30_000, 120_000, 600_000, 3_600_000, 21_600_000]);
    expect(backoffMs(0)).toBe(30_000);
    expect(backoffMs(1)).toBe(30_000);
    expect(backoffMs(2)).toBe(120_000);
    expect(backoffMs(3)).toBe(600_000);
    expect(backoffMs(4)).toBe(3_600_000);
    expect(backoffMs(5)).toBe(21_600_000);
    expect(backoffMs(9)).toBe(21_600_000);
  });

  it.each([
    [1, 30_000],
    [2, 120_000],
    [3, 600_000],
    [4, 3_600_000],
    [5, 21_600_000],
  ])("fail after attempt %i re-queues the job %i ms out", async (attempt, delay) => {
    await enqueue("purge_media", "a", { key: "a" });
    const row = await jobRow("purge_media", "a");

    const before = Date.now();
    const outcome = await fail(jobFor(row, "a", attempt), `boom ${attempt}`);
    const after = Date.now();

    expect(outcome).toBe("retry");
    const failed = await jobRow("purge_media", "a");
    expect(failed).toMatchObject({ status: "queued", lockedUntil: null, lockedBy: null, lastError: `boom ${attempt}` });
    const scheduledFrom = failed.runAfter.getTime() - delay;
    expect(scheduledFrom).toBeGreaterThanOrEqual(before);
    expect(scheduledFrom).toBeLessThanOrEqual(after);
  });

  it("fail marks the job dead once attempts reach maxAttempts and truncates the error", async () => {
    await enqueue("purge_media", "a", { key: "a" });
    const row = await jobRow("purge_media", "a");
    const longError = "x".repeat(5000);

    expect(await fail(jobFor(row, "a", 6), longError)).toBe("dead");

    const dead = await jobRow("purge_media", "a");
    expect(dead).toMatchObject({ status: "dead", lockedUntil: null, lockedBy: null });
    expect(dead.lastError).toHaveLength(1000);
    expect(await claim(10, "w1")).toEqual([]);
  });

  it("a named wait hands the attempt back and never buries the job", async () => {
    await enqueue("purge_media", "a", { key: "a" }, { maxAttempts: 1 });
    const [job] = await claim(1, "w1");
    expect(job).toMatchObject({ attempts: 1, maxAttempts: 1 });

    const before = Date.now();
    expect(await fail(job!, "bucket is full", 700)).toBe("retry");

    const row = await jobRow("purge_media", "a");
    expect(row).toMatchObject({ status: "queued", attempts: 0, lastError: "bucket is full", lockedBy: null, lockedUntil: null });
    expect(row.runAfter.getTime() - 700).toBeGreaterThanOrEqual(before);

    /* Six waits in a row still leave the job claimable. */
    for (let i = 0; i < 6; i++) {
      await db.update(schema.jobs).set({ runAfter: new Date(Date.now() - 1000) }).where(eq(schema.jobs.id, job!.id));
      const [again] = await claim(1, "w1");
      expect(again).toMatchObject({ id: job!.id, attempts: 1 });
      expect(await fail(again!, "still full", 100)).toBe("retry");
    }
    expect(await jobRow("purge_media", "a")).toMatchObject({ status: "queued", attempts: 0 });
  });

  it("fail respects a smaller maxAttempts", async () => {
    await enqueue("purge_media", "a", { key: "a" }, { maxAttempts: 1 });
    const [job] = await claim(1, "w1");
    expect(job).toMatchObject({ attempts: 1, maxAttempts: 1 });
    expect(await fail(job!, "once was enough")).toBe("dead");
    expect(await jobRow("purge_media", "a")).toMatchObject({ status: "dead", attempts: 1, lastError: "once was enough" });
  });
});

describe("runJobs", () => {
  it("runs every due job's handler in batches and marks them done", async () => {
    const keys = Array.from({ length: 7 }, (_, i) => `t/team/p/proj/r/run/${i}.png`);
    for (const key of keys) {
      putObject(key);
      await enqueue("purge_media", key, { key });
    }
    putObject("t/late.png");
    await enqueue("purge_media", "t/late.png", { key: "t/late.png" }, { runAfter: new Date(Date.now() + HOUR) });

    const ran = await runJobs();

    expect(ran).toBe(7);
    expect([...store.objects.keys()]).toEqual(["t/late.png"]);
    const all = await db.select().from(schema.jobs);
    expect(all.filter((j) => j.status === "done").map((j) => j.dedupeKey).sort()).toEqual([...keys].sort());
    for (const done of all.filter((j) => j.status === "done")) {
      expect(done).toMatchObject({ attempts: 1, lockedUntil: null, lockedBy: null, lastError: null });
    }
    expect(await jobRow("purge_media", "t/late.png")).toMatchObject({ status: "queued", attempts: 0 });
    expect(globalThis.__ohfJobsRunning).toBe(false);
  });

  it("stops at maxJobs and picks the rest up on the next drain", async () => {
    for (const key of ["a", "b", "c", "d"]) {
      putObject(key);
      await enqueue("purge_media", key, { key });
    }

    expect(await runJobs(3)).toBe(3);
    expect(store.objects.size).toBe(1);
    const all = await db.select().from(schema.jobs);
    expect(all.filter((j) => j.status === "done")).toHaveLength(3);
    expect(all.filter((j) => j.status === "queued")).toHaveLength(1);

    expect(await runJobs()).toBe(1);
    expect(store.objects.size).toBe(0);
    expect(await runJobs()).toBe(0);
  });

  it("a throwing handler re-queues the job with last_error and the first backoff", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(store, "remove").mockRejectedValue(new Error("bucket on fire"));
    putObject("a");
    await enqueue("purge_media", "a", { key: "a" });

    const before = Date.now();
    const ran = await runJobs();
    const after = Date.now();

    // The drain reports what it claimed, so a failed job still counts as one.
    expect(ran).toBe(1);
    const row = await jobRow("purge_media", "a");
    expect(row).toMatchObject({ status: "queued", attempts: 1, lastError: "bucket on fire", lockedUntil: null, lockedBy: null });
    expect(row.runAfter.getTime() - 30_000).toBeGreaterThanOrEqual(before);
    expect(row.runAfter.getTime() - 30_000).toBeLessThanOrEqual(after);
    expect(store.objects.has("a")).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("purge_media a retry: bucket on fire"));

    expect(await runJobs()).toBe(0);
    expect(await jobRow("purge_media", "a")).toMatchObject({ status: "queued", attempts: 1 });
    expect(globalThis.__ohfJobsRunning).toBe(false);
  });

  it("buries a job that keeps throwing once maxAttempts is spent", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(store, "remove").mockRejectedValue(new Error("still broken"));
    await enqueue("purge_media", "a", { key: "a" }, { maxAttempts: 1 });

    expect(await runJobs()).toBe(1);
    expect(await jobRow("purge_media", "a")).toMatchObject({ status: "dead", attempts: 1, lastError: "still broken" });
    expect(await runJobs()).toBe(0);
  });

  it("a non-Error throw is recorded as its string form", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(store, "remove").mockRejectedValue("plain string");
    await enqueue("purge_media", "a", { key: "a" });

    expect(await runJobs()).toBe(1);
    expect(await jobRow("purge_media", "a")).toMatchObject({ status: "queued", lastError: "plain string" });
  });

  it("the in-process mutex makes a nested drain return 0 and is released afterwards", async () => {
    let seenFlag: boolean | undefined;
    let nested: number | undefined;
    vi.spyOn(store, "remove").mockImplementation(async (key: string) => {
      seenFlag = globalThis.__ohfJobsRunning;
      nested = await runJobs();
      store.objects.delete(key);
    });
    putObject("a");
    await enqueue("purge_media", "a", { key: "a" });

    expect(await runJobs()).toBe(1);

    expect(seenFlag).toBe(true);
    expect(nested).toBe(0);
    expect(globalThis.__ohfJobsRunning).toBe(false);
    expect(store.objects.has("a")).toBe(false);
    expect(await jobRow("purge_media", "a")).toMatchObject({ status: "done", attempts: 1 });
  });

  it("ignores a drain flag left up for longer than the stale window", async () => {
    putObject("a");
    await enqueue("purge_media", "a", { key: "a" });
    globalThis.__ohfJobsRunning = true;
    globalThis.__ohfJobsRunningSince = Date.now() - DRAIN_LOCK_STALE_MS - 1000;

    expect(await runJobs()).toBe(1);
    expect(store.objects.has("a")).toBe(false);
    expect(globalThis.__ohfJobsRunning).toBe(false);
    expect(globalThis.__ohfJobsRunningSince).toBeUndefined();
  });

  it("returns 0 without touching the queue while another drain holds the flag", async () => {
    putObject("a");
    await enqueue("purge_media", "a", { key: "a" });
    globalThis.__ohfJobsRunning = true;

    expect(await runJobs()).toBe(0);

    expect(globalThis.__ohfJobsRunning).toBe(true);
    expect(store.objects.has("a")).toBe(true);
    expect(await jobRow("purge_media", "a")).toMatchObject({ status: "queued", attempts: 0, lockedBy: null });
  });
});

describe("kickJobs and the dev worker", () => {
  it("kickJobs drains right away outside a request scope and starts the dev worker", async () => {
    putObject("a");
    await enqueue("purge_media", "a", { key: "a" });

    kickJobs();

    // next/server's after() throws without a request, so the fallback drains.
    await vi.waitFor(async () => expect((await jobRow("purge_media", "a")).status).toBe("done"), { timeout: 10_000, interval: 25 });
    expect(store.objects.has("a")).toBe(false);
    expect(globalThis.__ohfDevWorker).toBeDefined();
    expect(globalThis.__ohfJobsRunning).toBe(false);
  });

  it("startDevWorker installs one interval per process and none in production", () => {
    startDevWorker();
    const handle = globalThis.__ohfDevWorker;
    expect(handle).toBeDefined();
    startDevWorker();
    expect(globalThis.__ohfDevWorker).toBe(handle);

    clearInterval(handle);
    globalThis.__ohfDevWorker = undefined;
    vi.stubEnv("NODE_ENV", "production");
    try {
      startDevWorker();
      expect(globalThis.__ohfDevWorker).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
