import { randomUUID } from "node:crypto";
import { asc, eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  envForTests,
  resetStubs,
  seedTeam,
  stubKie,
  useMemoryStore,
  useTestDatabase,
  type FakeKie,
  type MemoryStore,
  type TestDb,
} from "./harness";

import type { GenerationPlane } from "@/generation/catalog";
import type { KieRecord } from "@/generation/kie/client";
import * as schema from "@/server/db/schema";
import { runJobs } from "@/server/jobs/runner";
import { BUCKET_CAPACITY, bucketKeyFor, takeToken } from "@/server/rate-limit";
import {
  RetryLaterError,
  SUBMIT_CLAIM_STALE_MS,
  applyRecord,
  createRun,
  mirrorResult,
  reconcileRun,
  submitOrQueue,
  submitRun,
  syncRuns,
  viewOf,
} from "@/server/runs";
import { resultKey } from "@/server/storage";
import type { TeamContext } from "@/server/team";

/* Every test boots its own PGlite, which takes a moment more than the default
   budget allows. */
vi.setConfig({ testTimeout: 30_000 });

let db: TestDb;
let kie: FakeKie;
let store: MemoryStore;

beforeEach(async () => {
  envForTests();
  db = await useTestDatabase();
  store = useMemoryStore({ public: true });
  kie = stubKie();
});

afterEach(() => resetStubs());

const PNG = new Uint8Array([137, 80, 78, 71]);
const OUT_1 = "https://tempfile.test/out/1.png";
const OUT_2 = "https://tempfile.test/out/2.png";
const OUT_3 = "https://tempfile.test/out/3.png";
const HOUR = 60 * 60_000;

function plane(text: string, media: GenerationPlane["media"] = {}): GenerationPlane {
  return { model: "nano-banana-pro", prompt: { text }, media, settings: {} };
}

function press(team: TeamContext, key: string, media?: GenerationPlane["media"]) {
  return createRun(team, { plane: plane(`prompt ${key}`, media), idempotencyKey: key });
}

async function loadRun(id: string) {
  const run = await db.query.runs.findFirst({ where: eq(schema.runs.id, id) });
  if (!run) throw new Error(`run ${id} is not in the table`);
  return run;
}

function loadResults(runId: string) {
  return db.query.results.findMany({ where: eq(schema.results.runId, runId), orderBy: asc(schema.results.index) });
}

function jobsOf(type: string) {
  return db.query.jobs.findMany({ where: eq(schema.jobs.type, type), orderBy: asc(schema.jobs.createdAt) });
}

function eventsOf(runId: string) {
  return db.query.runEvents.findMany({ where: eq(schema.runEvents.runId, runId), orderBy: asc(schema.runEvents.at) });
}

function record(taskId: string, patch: Partial<KieRecord>): KieRecord {
  return {
    taskId,
    model: "nano-banana-pro",
    state: "generating",
    resultUrls: [],
    firstFrameUrls: [],
    lastFrameUrls: [],
    failCode: "",
    failMsg: "",
    ...patch,
  };
}

function success(taskId: string, urls: string[], patch: Partial<KieRecord> = {}): KieRecord {
  return record(taskId, { state: "success", resultUrls: urls, ...patch });
}

function calls(prefix: string) {
  return kie.calls.filter((url) => url.startsWith(prefix));
}

function urlOf(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

/** Layers one more rule over the harness's fetch stub; everything else falls through. */
function interceptFetch(rule: (url: string) => Response | undefined) {
  const inner = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = urlOf(input);
    const hit = rule(url);
    if (hit) {
      kie.calls.push(url);
      return hit;
    }
    return inner(input, init);
  });
}

async function drainBucket() {
  const key = bucketKeyFor(process.env.KIE_API_KEY!);
  for (;;) {
    const token = await takeToken(key);
    if (!token.granted) return key;
  }
}

function refillBucket(key: string) {
  return db.update(schema.rateBuckets).set({ tokens: String(BUCKET_CAPACITY), updatedAt: new Date() }).where(eq(schema.rateBuckets.key, key));
}

/** Another tile on a one-tile run, standing in for a model with a native count
    (no catalog entry defines countKey yet). */
async function addTile(runId: string, index: number) {
  const [template] = await loadResults(runId);
  const id = randomUUID();
  await db.insert(schema.results).values({ ...template!, id, index });
  await db.update(schema.runs).set({ expectedCount: index + 1 }).where(eq(schema.runs.id, runId));
  return id;
}

async function seedAsset(team: TeamContext) {
  const id = randomUUID();
  const key = `t/${team.teamId}/u/2026/09/${id}.png`;
  const url = store.publicUrl(key);
  await db.insert(schema.assets).values({
    id,
    teamId: team.teamId,
    userId: team.userId,
    source: "upload",
    kind: "image",
    name: "ref.png",
    mime: "image/png",
    bytes: PNG.byteLength,
    key,
    url,
    status: "ready",
  });
  kie.files.set(url, { bytes: PNG, contentType: "image/png" });
  return { id, key, url };
}

async function loadAsset(id: string) {
  const asset = await db.query.assets.findFirst({ where: eq(schema.assets.id, id) });
  if (!asset) throw new Error(`asset ${id} is not in the table`);
  return asset;
}

/* ---------- createRun ---------- */

describe("createRun", () => {
  it("records the row, one tile per expected result and the exact wire before submitting", async () => {
    /* No catalog entry defines countKey today, so every run expects one
       result; the multi-tile paths below add tiles by hand. */
    const team = await seedTeam(db);
    const before = Date.now();
    const created = await press(team, "press-1");

    const run = await loadRun(created.requestId);
    expect(run).toMatchObject({
      teamId: team.teamId,
      userId: team.userId,
      idempotencyKey: "press-1",
      surface: "image",
      modelId: "nano-banana-pro",
      modelLabel: "Nano Banana Pro",
      kieModel: "nano-banana-pro",
      prompt: "prompt press-1",
      settings: { aspectRatio: "1:1", resolution: "1k", outputFormat: "png" },
      media: [],
      expectedCount: 1,
      status: "submitted",
      kieTaskId: "task_1",
      kieState: "waiting",
      submitAttempts: 1,
      pollAttempts: 0,
    });
    expect(run.callbackToken).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(run.deadlineAt.getTime()).toBeGreaterThanOrEqual(before + 10 * 60_000);
    expect(run.deadlineAt.getTime()).toBeLessThan(before + 11 * 60_000);
    expect(run.nextPollAt!.getTime()).toBeGreaterThanOrEqual(before + 5_000);
    expect(run.submittedAt!.getTime()).toBeGreaterThanOrEqual(before);

    const wire = {
      model: "nano-banana-pro",
      input: { prompt: "prompt press-1", aspect_ratio: "1:1", resolution: "1K", output_format: "png" },
    };
    expect(run.kieInput).toEqual(wire);
    expect(kie.tasks).toHaveLength(1);
    expect(kie.tasks[0]!.body).toEqual(wire);

    const results = await loadResults(run.id);
    expect(results).toHaveLength(1);
    expect(created.resultIds).toEqual([results[0]!.id]);
    expect(results[0]).toMatchObject({
      index: 0,
      teamId: team.teamId,
      projectId: run.projectId,
      productId: run.productId,
      kind: "image",
      modelId: "nano-banana-pro",
      prompt: "prompt press-1",
      ratio: "1 / 1",
      status: "running",
      mirrorStatus: "none",
      sourceUrl: null,
    });

    const project = await db.query.projects.findFirst({ where: eq(schema.projects.id, run.projectId) });
    expect(project).toMatchObject({ slug: "inbox", teamId: team.teamId });
    expect(project!.lastUsedAt.getTime()).toBeGreaterThanOrEqual(before);

    const events = await eventsOf(run.id);
    expect(events.map((e) => [e.type, e.payload])).toEqual([
      ["created", { model: "nano-banana-pro" }],
      ["submitted", { taskId: "task_1" }],
    ]);
  });

  it("adds the callback url only for an https APP_PUBLIC_URL", async () => {
    const team = await seedTeam(db);
    process.env.APP_PUBLIC_URL = "http://localhost:3000";
    const plain = await press(team, "cb-http");
    expect(kie.tasks[0]!.body).not.toHaveProperty("callBackUrl");

    process.env.APP_PUBLIC_URL = "https://studio.example/";
    const signed = await press(team, "cb-https");
    const run = await loadRun(signed.requestId);
    expect(kie.tasks[1]!.body.callBackUrl).toBe(`https://studio.example/api/kie/callback?run=${run.id}&t=${run.callbackToken}`);
    expect(plain.requestId).not.toBe(signed.requestId);
  });

  it("keeps the run pending with a queued submit when the bucket is empty, and a drain submits it", async () => {
    const team = await seedTeam(db);
    const key = await drainBucket();
    const before = Date.now();
    const created = await press(team, "dry");

    expect(kie.tasks).toHaveLength(0);
    const run = await loadRun(created.requestId);
    expect(run).toMatchObject({ status: "pending", kieTaskId: null, submitAttempts: 0, submittedAt: null });
    const tiles = await loadResults(run.id);
    expect(tiles.map((t) => t.status)).toEqual(["running"]);

    const [job, ...others] = await jobsOf("submit_run");
    expect(others).toHaveLength(0);
    expect(job).toMatchObject({ teamId: team.teamId, dedupeKey: run.id, payload: { runId: run.id }, status: "queued", attempts: 0 });
    expect(job!.runAfter.getTime()).toBeGreaterThan(before);
    expect(job!.runAfter.getTime()).toBeLessThan(before + 2_000);

    /* A drain with the bucket refilled and the job due submits exactly once. */
    await refillBucket(key);
    await db.update(schema.jobs).set({ runAfter: new Date(Date.now() - 1_000) }).where(eq(schema.jobs.id, job!.id));
    expect(await runJobs()).toBe(1);
    expect(kie.tasks).toHaveLength(1);
    expect(kie.tasks[0]!.body).toMatchObject({ model: "nano-banana-pro", input: { prompt: "prompt dry" } });
    expect(await loadRun(run.id)).toMatchObject({ status: "submitted", kieTaskId: "task_1", submitAttempts: 1 });
    const [done] = await jobsOf("submit_run");
    expect(done).toMatchObject({ id: job!.id, status: "done", attempts: 1 });
    expect(await runJobs()).toBe(0);
  });
});

/* ---------- submitRun ---------- */

describe("submitRun", () => {
  it("re-queues a retryable KIE error with a doubling backoff and counts the attempt", async () => {
    kie.createStatus = 500;
    const team = await seedTeam(db);
    const before = Date.now();
    const created = await press(team, "flaky");

    expect(kie.tasks).toHaveLength(1);
    expect(await loadRun(created.requestId)).toMatchObject({ status: "pending", kieTaskId: null, submitAttempts: 1, failMsg: null });
    let [job] = await jobsOf("submit_run");
    expect(job).toMatchObject({ dedupeKey: created.requestId, status: "queued" });
    expect(job!.runAfter.getTime()).toBeGreaterThanOrEqual(before + 10_000);
    expect(job!.runAfter.getTime()).toBeLessThan(before + 12_000);

    const again = Date.now();
    /* Inline callers go through submitOrQueue: submitRun itself only names
       the wait, and the job runner turns that into its own reschedule. */
    await submitOrQueue(created.requestId, team.teamId);
    expect(kie.tasks).toHaveLength(2);
    expect(await loadRun(created.requestId)).toMatchObject({ status: "pending", submitAttempts: 2 });
    [job] = await jobsOf("submit_run");
    expect(job!.runAfter.getTime()).toBeGreaterThanOrEqual(again + 20_000);
    expect(job!.runAfter.getTime()).toBeLessThan(again + 22_000);
    expect(await jobsOf("submit_run")).toHaveLength(1);
    expect((await eventsOf(created.requestId)).map((e) => e.type)).toEqual(["created"]);
  });

  it("fails the run with KIE's words once the retryable attempts are used up", async () => {
    kie.createStatus = 503;
    const team = await seedTeam(db);
    const created = await press(team, "exhausted");
    await db.update(schema.runs).set({ submitAttempts: 4 }).where(eq(schema.runs.id, created.requestId));

    await submitRun(created.requestId);
    expect(await loadRun(created.requestId)).toMatchObject({ status: "failed", failMsg: "KIE error 503", failCode: "503", kieTaskId: null });
    const [tile] = await loadResults(created.requestId);
    expect(tile).toMatchObject({ status: "failed", error: "KIE error 503" });
    expect((await eventsOf(created.requestId)).map((e) => e.type)).toEqual(["created", "failed"]);
  });

  it("fails the run with KIE's message on a fatal error and never queues a retry", async () => {
    kie.createStatus = 422;
    kie.createBody = { code: 422, msg: "prompt violates the content policy", data: null };
    const team = await seedTeam(db);
    const created = await press(team, "fatal");

    expect(kie.tasks).toHaveLength(1);
    const run = await loadRun(created.requestId);
    expect(run).toMatchObject({
      status: "failed",
      failMsg: "prompt violates the content policy",
      failCode: "422",
      kieTaskId: null,
      submitAttempts: 0,
    });
    expect(run.completedAt).not.toBeNull();
    const tiles = await loadResults(run.id);
    expect(tiles.map((t) => [t.status, t.error])).toEqual([["failed", "prompt violates the content policy"]]);
    expect(await jobsOf("submit_run")).toHaveLength(0);
    const events = await eventsOf(run.id);
    expect(events.map((e) => e.type)).toEqual(["created", "failed"]);
    expect(events[1]!.payload).toEqual({ message: "prompt violates the content policy", code: "422" });
    expect(viewOf({ ...run, results: tiles })).toMatchObject({ status: "failed", error: "prompt violates the content policy" });
  });

  it("keeps a queued retry when the retryable error happens inside the submit job", async () => {
    // DEFECT: enqueue() leaves a job that is 'running' untouched and runOne()
    // then marks it done, so the retry submitRun schedules from inside its own
    // submit_run job is dropped. The run sits pending until the cron tick
    // re-enqueues every pending run (ignoring the backoff ladder); a dev
    // checkout has no cron, only a drain, so there it waits for an open tab.
    kie.createStatus = 500;
    const team = await seedTeam(db);
    const created = await press(team, "job-retry");
    await db.update(schema.jobs).set({ runAfter: new Date(Date.now() - 1_000) }).where(eq(schema.jobs.dedupeKey, created.requestId));

    const before = Date.now();
    expect(await runJobs()).toBe(1);
    expect(kie.tasks).toHaveLength(2);
    expect(await loadRun(created.requestId)).toMatchObject({ status: "pending", submitAttempts: 2 });
    const [job, ...others] = await jobsOf("submit_run");
    expect(others).toHaveLength(0);
    expect(job!.status).toBe("queued");
    expect(job!.runAfter.getTime()).toBeGreaterThanOrEqual(before + 20_000);
  });
});

/* ---------- submitRun: the claim ---------- */

describe("submitRun claims the run before KIE is called", () => {
  /** createTask answers only after `ms`, so two submitters overlap on the wire. */
  function slowCreateTask(ms: number) {
    const inner = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      if (urlOf(input).startsWith("https://api.kie.ai/api/v1/jobs/createTask")) await new Promise((r) => setTimeout(r, ms));
      return inner(input, init);
    });
  }

  async function pendingRun(team: TeamContext, key: string) {
    const bucket = await drainBucket();
    const created = await press(team, key);
    expect(await loadRun(created.requestId)).toMatchObject({ status: "pending" });
    await refillBucket(bucket);
    return created;
  }

  it("two overlapping submitters buy one task between them", async () => {
    const team = await seedTeam(db);
    const created = await pendingRun(team, "raced");
    slowCreateTask(150);

    await Promise.all([submitRun(created.requestId), submitRun(created.requestId)]);

    expect(kie.tasks).toHaveLength(1);
    expect(await loadRun(created.requestId)).toMatchObject({ status: "submitted", kieTaskId: "task_1", submitAttempts: 1 });
    expect((await eventsOf(created.requestId)).map((e) => [e.type, e.payload])).toEqual([
      ["created", { model: "nano-banana-pro" }],
      ["submitted", { taskId: "task_1" }],
    ]);
  });

  it("the studio poll and the job runner racing on one pending run submit it once", async () => {
    const team = await seedTeam(db);
    const created = await pendingRun(team, "poll-vs-job");
    await db.update(schema.jobs).set({ runAfter: new Date(Date.now() - 1_000) }).where(eq(schema.jobs.dedupeKey, created.requestId));
    slowCreateTask(150);

    const [views, ran] = await Promise.all([syncRuns(team, [created.requestId]), runJobs()]);

    expect(ran).toBe(1);
    expect(kie.tasks).toHaveLength(1);
    expect(views).toHaveLength(1);
    expect(await loadRun(created.requestId)).toMatchObject({ status: "submitted", kieTaskId: "task_1", submitAttempts: 1 });
    expect((await eventsOf(created.requestId)).filter((e) => e.type === "submitted")).toHaveLength(1);
    const [job] = await jobsOf("submit_run");
    expect(job).toMatchObject({ status: "done" });
  });

  it("leaves a fresh claim alone and takes over one older than the stale window", async () => {
    const team = await seedTeam(db);
    const created = await pendingRun(team, "claimed");
    await db.update(schema.runs).set({ status: "submitting", updatedAt: new Date() }).where(eq(schema.runs.id, created.requestId));

    await submitRun(created.requestId);
    expect(kie.tasks).toHaveLength(0);
    expect(await loadRun(created.requestId)).toMatchObject({ status: "submitting" });
    /* A stale claim is not pending to the studio poll either. */
    await syncRuns(team, [created.requestId]);
    expect(kie.tasks).toHaveLength(0);

    /* Past the stale window the claim is a dead submitter's, and a tab's poll
       may take it over as much as the job runner. */
    await db
      .update(schema.runs)
      .set({ updatedAt: new Date(Date.now() - SUBMIT_CLAIM_STALE_MS - 1_000) })
      .where(eq(schema.runs.id, created.requestId));
    await syncRuns(team, [created.requestId]);
    await runJobs();
    expect(kie.tasks).toHaveLength(1);
    expect(await loadRun(created.requestId)).toMatchObject({ status: "submitted", kieTaskId: "task_1" });
    await submitRun(created.requestId);
    expect(kie.tasks).toHaveLength(1);
  });

  it("hands the claim back when the bucket is empty, spending no attempt", async () => {
    const team = await seedTeam(db);
    const created = await pendingRun(team, "no-token");
    await drainBucket();

    await expect(submitRun(created.requestId)).rejects.toBeInstanceOf(RetryLaterError);
    expect(kie.tasks).toHaveLength(0);
    expect(await loadRun(created.requestId)).toMatchObject({ status: "pending", submitAttempts: 0, kieTaskId: null });
  });

  it("a 429 from KIE waits like an empty bucket and spends no attempt", async () => {
    const team = await seedTeam(db);
    const created = await pendingRun(team, "too-fast");
    kie.createStatus = 429;

    await expect(submitRun(created.requestId)).rejects.toMatchObject({ name: "RetryLaterError", retryAfterMs: 10_000 });
    expect(kie.tasks).toHaveLength(1);
    expect(await loadRun(created.requestId)).toMatchObject({ status: "pending", submitAttempts: 0, kieTaskId: null, failMsg: null });
  });

  it("a transport failure is retried, not treated as KIE's refusal", async () => {
    const team = await seedTeam(db);
    const created = await pendingRun(team, "reset");
    const inner = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      if (urlOf(input).startsWith("https://api.kie.ai/api/v1/jobs/createTask")) throw new TypeError("fetch failed");
      return inner(input, init);
    });

    await submitOrQueue(created.requestId, team.teamId);

    expect(await loadRun(created.requestId)).toMatchObject({ status: "pending", submitAttempts: 1, failMsg: null });
    const [job] = await jobsOf("submit_run");
    expect(job).toMatchObject({ status: "queued", dedupeKey: created.requestId });
    expect(job!.runAfter.getTime()).toBeGreaterThanOrEqual(Date.now() + 9_000);
  });

  it("a hard refusal fails the run from the claim", async () => {
    const team = await seedTeam(db);
    const created = await pendingRun(team, "refused");
    kie.createStatus = 400;
    kie.createBody = { code: 400, msg: "bad input", data: null };

    await submitRun(created.requestId);

    expect(await loadRun(created.requestId)).toMatchObject({ status: "failed", failMsg: "bad input", failCode: "400" });
    expect((await loadResults(created.requestId)).map((t) => t.status)).toEqual(["failed"]);
  });

  it("a buried mirror job fails the tile instead of leaving KIE's expiring url as its picture", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const team = await seedTeam(db);
    const created = await press(team, "unmirrorable");
    await applyRecord(await loadRun(created.requestId), success("task_1", [OUT_1]));
    kie.files.set(OUT_1, { bytes: PNG, contentType: "image/png", status: 500 });
    await db.update(schema.jobs).set({ attempts: 5 }).where(eq(schema.jobs.dedupeKey, created.resultIds[0]!));

    expect(await runJobs()).toBe(1);

    expect(await jobsOf("mirror_result")).toEqual([expect.objectContaining({ status: "dead", attempts: 6 })]);
    const [tile] = await loadResults(created.requestId);
    expect(tile).toMatchObject({ status: "failed", mirrorStatus: "failed", sourceUrl: OUT_1, url: null, error: "the platform's copy expired before it could be saved" });
    const run = await loadRun(created.requestId);
    expect(viewOf({ ...run, results: [tile!] }).results[0]).toMatchObject({ status: "failed", mirrored: false });
  });
});

/* ---------- applyRecord ---------- */

describe("applyRecord", () => {
  it("keeps completion retryable when its storage job cannot be recorded", async () => {
    const team = await seedTeam(db);
    const created = await press(team, "atomic-copy");
    const run = await loadRun(created.requestId);
    await db.execute(sql`CREATE FUNCTION reject_copy_job() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'copy queue unavailable'; END;
    $$`);
    await db.execute(sql`CREATE TRIGGER reject_copy_job BEFORE INSERT ON jobs FOR EACH ROW EXECUTE FUNCTION reject_copy_job()`);
    await expect(applyRecord(run, success(run.kieTaskId!, [OUT_1]))).rejects.toThrow();
    expect(await loadRun(run.id)).toMatchObject({ status: "submitted" });
    expect((await loadResults(run.id))[0]).toMatchObject({ status: "running", sourceUrl: null });
    await db.execute(sql`DROP TRIGGER reject_copy_job ON jobs`);
    kie.files.set(OUT_1, { bytes: PNG, contentType: "image/png" });
    await reconcileRun(run.id);
    await applyRecord(await loadRun(run.id), success(run.kieTaskId!, [OUT_1]));
    await runJobs();
    expect((await loadResults(run.id))[0]).toMatchObject({ status: "completed", mirrorStatus: "done" });
  });
  it("fails the tile that got no url when KIE delivers fewer results than tiles", async () => {
    const team = await seedTeam(db);
    const created = await press(team, "few");
    const second = await addTile(created.requestId, 1);

    await applyRecord(await loadRun(created.requestId), success("task_1", [OUT_1], { creditsConsumed: 8 }));

    const run = await loadRun(created.requestId);
    expect(run).toMatchObject({ status: "succeeded", kieState: "success", expectedCount: 2 });
    expect(Number(run.creditsConsumed)).toBe(8);
    const tiles = await loadResults(run.id);
    expect(tiles.map((t) => ({ id: t.id, status: t.status, sourceUrl: t.sourceUrl, mirrorStatus: t.mirrorStatus, error: t.error }))).toEqual([
      { id: created.resultIds[0], status: "completed", sourceUrl: OUT_1, mirrorStatus: "queued", error: null },
      { id: second, status: "failed", sourceUrl: null, mirrorStatus: "none", error: "the platform delivered fewer results than expected" },
    ]);
    const mirrors = await jobsOf("mirror_result");
    expect(mirrors.map((j) => [j.dedupeKey, j.payload, j.status])).toEqual([[created.resultIds[0], { resultId: created.resultIds[0] }, "queued"]]);
    const ledger = await db.select().from(schema.creditLedger);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ teamId: team.teamId, runId: run.id, userId: team.userId, projectId: run.projectId });
    expect(Number(ledger[0]!.credits)).toBe(8);
  });

  it("appends result rows and mirrors every url when KIE delivers more results than tiles", async () => {
    const team = await seedTeam(db);
    const created = await press(team, "many");
    const first = (await loadResults(created.requestId))[0]!;

    await applyRecord(await loadRun(created.requestId), success("task_1", [OUT_1, OUT_2, OUT_3], { creditsConsumed: 24, costTime: 4200 }));

    const run = await loadRun(created.requestId);
    expect(run).toMatchObject({ status: "succeeded", costTimeRaw: 4200 });
    const tiles = await loadResults(run.id);
    expect(tiles.map((t) => [t.index, t.status, t.sourceUrl, t.mirrorStatus])).toEqual([
      [0, "completed", OUT_1, "queued"],
      [1, "completed", OUT_2, "queued"],
      [2, "completed", OUT_3, "queued"],
    ]);
    expect(tiles[0]!.id).toBe(created.resultIds[0]);
    for (const extra of tiles.slice(1)) {
      expect(extra).toMatchObject({
        runId: run.id,
        teamId: team.teamId,
        projectId: run.projectId,
        productId: run.productId,
        userId: team.userId,
        kind: first.kind,
        modelId: first.modelId,
        modelLabel: first.modelLabel,
        prompt: first.prompt,
        ratio: first.ratio,
        meta: first.meta,
        settings: first.settings,
      });
    }
    const mirrors = await jobsOf("mirror_result");
    expect(mirrors.map((j) => j.dedupeKey).sort()).toEqual(tiles.map((t) => t.id).sort());
    const events = await eventsOf(run.id);
    expect(events.at(-1)).toMatchObject({ type: "succeeded", payload: { results: 3, credits: 24 } });
    expect(viewOf({ ...run, results: tiles }).results.map((r) => r.url)).toEqual([OUT_1, OUT_2, OUT_3]);
  });

  it("writes no ledger row when the record carries no creditsConsumed", async () => {
    const team = await seedTeam(db);
    const created = await press(team, "free");

    await applyRecord(await loadRun(created.requestId), success("task_1", [OUT_1]));

    const run = await loadRun(created.requestId);
    expect(run).toMatchObject({ status: "succeeded", creditsConsumed: null, costTimeRaw: null });
    expect(await db.select().from(schema.creditLedger)).toHaveLength(0);
    expect((await eventsOf(run.id)).at(-1)).toMatchObject({ type: "succeeded", payload: { results: 1, credits: null } });
    expect(viewOf({ ...run, results: await loadResults(run.id) })).not.toHaveProperty("creditsConsumed");
  });

  it("fails the run with KIE's code and message on a fail record", async () => {
    const team = await seedTeam(db);
    const created = await press(team, "kie-fail");
    kie.records.set("task_1", { state: "fail", failCode: "422", failMsg: "content policy violation" });

    await reconcileRun(created.requestId);

    const run = await loadRun(created.requestId);
    expect(run).toMatchObject({ status: "failed", failMsg: "content policy violation (422)", failCode: "422" });
    expect(run.failMsg).toContain("422");
    expect(run.failMsg).toContain("content policy violation");
    const tiles = await loadResults(run.id);
    expect(tiles.map((t) => [t.status, t.error])).toEqual([["failed", "content policy violation (422)"]]);
    expect((await eventsOf(run.id)).at(-1)).toMatchObject({ type: "failed", payload: { message: "content policy violation (422)", code: "422" } });

    /* No message: a placeholder, still with the code. A message that already
       carries the code is not decorated twice. */
    const bare = await press(team, "kie-fail-bare");
    await applyRecord(await loadRun(bare.requestId), record("task_2", { state: "fail", failCode: "500" }));
    expect(await loadRun(bare.requestId)).toMatchObject({ status: "failed", failMsg: "the platform reported a failure (500)", failCode: "500" });
    const coded = await press(team, "kie-fail-coded");
    await applyRecord(await loadRun(coded.requestId), record("task_3", { state: "fail", failCode: "E17", failMsg: "E17: model busy" }));
    expect(await loadRun(coded.requestId)).toMatchObject({ status: "failed", failMsg: "E17: model busy", failCode: "E17" });
  });

  it("advances nextPollAt along the backoff ladder and updates kieState on non-terminal records", async () => {
    const team = await seedTeam(db);
    const created = await press(team, "slow");
    const ladder = [5_000, 5_000, 8_000, 8_000, 10_000, 10_000, 15_000, 20_000, 30_000, 60_000, 60_000];
    const states = ["waiting", "queuing", "generating"] as const;

    for (const [attempt, wait] of ladder.entries()) {
      const state = states[attempt % states.length]!;
      const before = await loadRun(created.requestId);
      await applyRecord(before, record("task_1", { state }));
      const after = await loadRun(created.requestId);
      expect(after.status).toBe("submitted");
      expect(after.kieState).toBe(state);
      expect(after.pollAttempts).toBe(attempt + 1);
      expect(after.lastPolledAt!.getTime()).toBeGreaterThanOrEqual(before.updatedAt.getTime());
      expect(after.nextPollAt!.getTime() - after.lastPolledAt!.getTime()).toBe(wait);
    }
    const tiles = await loadResults(created.requestId);
    expect(tiles.map((t) => t.status)).toEqual(["running"]);
    expect((await eventsOf(created.requestId)).map((e) => e.type)).toEqual(["created", "submitted"]);

    /* Past the model's deadline the cadence relaxes to five minutes and the
       view says so. */
    await db.update(schema.runs).set({ deadlineAt: new Date(Date.now() - 1_000) }).where(eq(schema.runs.id, created.requestId));
    await applyRecord(await loadRun(created.requestId), record("task_1", { state: "generating" }));
    const stalled = await loadRun(created.requestId);
    expect(stalled.nextPollAt!.getTime() - stalled.lastPolledAt!.getTime()).toBe(5 * 60_000);
    expect(viewOf({ ...stalled, results: tiles })).toMatchObject({ status: "running", stalled: true });
  });

  it("marks a run submitted more than 24h ago as lost", async () => {
    const team = await seedTeam(db);
    const created = await press(team, "old");
    await db.update(schema.runs).set({ submittedAt: new Date(Date.now() - 25 * HOUR) }).where(eq(schema.runs.id, created.requestId));

    await reconcileRun(created.requestId);

    expect(calls("https://api.kie.ai/api/v1/jobs/recordInfo")).toHaveLength(1);
    const run = await loadRun(created.requestId);
    expect(run).toMatchObject({ status: "lost", failCode: "LOST", failMsg: "the platform never answered for this run" });
    expect(run.completedAt).not.toBeNull();
    const tiles = await loadResults(run.id);
    expect(tiles.map((t) => [t.status, t.error])).toEqual([["failed", "the platform never answered for this run"]]);
    expect((await eventsOf(run.id)).at(-1)).toMatchObject({ type: "lost", payload: { code: "LOST" } });
    expect(viewOf({ ...run, results: tiles })).toMatchObject({ status: "failed", stalled: false, error: "the platform never answered for this run" });

    /* Lost is final: a late success from KIE changes nothing. */
    await applyRecord(run, success("task_1", [OUT_1], { creditsConsumed: 8 }));
    expect(await loadRun(run.id)).toMatchObject({ status: "lost", creditsConsumed: null });
    expect(await db.select().from(schema.creditLedger)).toHaveLength(0);
  });

  it("settles once: a second success record adds no ledger row, tile or mirror job", async () => {
    const team = await seedTeam(db);
    const created = await press(team, "twice");
    const done = success("task_1", [OUT_1, OUT_2], { creditsConsumed: 16 });

    await applyRecord(await loadRun(created.requestId), done);
    const first = await loadRun(created.requestId);
    await applyRecord(first, done);
    await applyRecord(await loadRun(created.requestId), done);

    const run = await loadRun(created.requestId);
    expect(run).toMatchObject({ status: "succeeded", completedAt: first.completedAt, updatedAt: first.updatedAt });
    const tiles = await loadResults(run.id);
    expect(tiles.map((t) => [t.index, t.sourceUrl])).toEqual([
      [0, OUT_1],
      [1, OUT_2],
    ]);
    expect(await jobsOf("mirror_result")).toHaveLength(2);
    const ledger = await db.select().from(schema.creditLedger);
    expect(ledger).toHaveLength(1);
    expect(Number(ledger[0]!.credits)).toBe(16);
    expect((await eventsOf(run.id)).filter((e) => e.type === "succeeded")).toHaveLength(1);
  });
});

/* ---------- reconcileRun ---------- */

describe("reconcileRun", () => {
  it("keeps the run submitted and notes a poll_error when recordInfo itself fails", async () => {
    const team = await seedTeam(db);
    const created = await press(team, "blind");
    const submitted = await loadRun(created.requestId);
    interceptFetch((url) =>
      url.startsWith("https://api.kie.ai/api/v1/jobs/recordInfo")
        ? new Response(JSON.stringify({ code: 500, msg: "upstream exploded", data: null }), { status: 500, headers: { "content-type": "application/json" } })
        : undefined,
    );

    await reconcileRun(created.requestId);

    const run = await loadRun(created.requestId);
    expect(run).toMatchObject({ status: "submitted", kieState: "waiting", kieTaskId: "task_1", pollAttempts: 1, failMsg: null, failCode: null, completedAt: null });
    expect(run.lastPolledAt!.getTime()).toBeGreaterThanOrEqual(submitted.updatedAt.getTime());
    expect(run.nextPollAt!.getTime() - run.lastPolledAt!.getTime()).toBe(5_000);
    expect(run.nextPollAt!.getTime()).toBeGreaterThanOrEqual(submitted.nextPollAt!.getTime());
    const tiles = await loadResults(run.id);
    expect(tiles.map((t) => t.status)).toEqual(["running"]);
    const events = await eventsOf(run.id);
    expect(events.map((e) => e.type)).toEqual(["created", "submitted", "poll_error"]);
    expect(events[2]!.payload).toEqual({ error: "upstream exploded" });

    /* A second blind poll climbs the ladder but still never fails the run,
       and the same complaint is not written twice: an outage would otherwise
       fill run_events at the poll cadence for a day. */
    await reconcileRun(created.requestId);
    expect(await loadRun(created.requestId)).toMatchObject({ status: "submitted", pollAttempts: 2 });
    expect((await eventsOf(run.id)).filter((e) => e.type === "poll_error")).toHaveLength(1);

    /* A different message is news again. */
    interceptFetch((url) =>
      url.startsWith("https://api.kie.ai/api/v1/jobs/recordInfo")
        ? new Response(JSON.stringify({ code: 503, msg: "upstream resting", data: null }), { status: 503, headers: { "content-type": "application/json" } })
        : undefined,
    );
    await reconcileRun(created.requestId);
    expect((await eventsOf(run.id)).filter((e) => e.type === "poll_error").map((e) => e.payload)).toEqual([
      { error: "upstream exploded" },
      { error: "upstream resting" },
    ]);
  });

  it("does nothing for a run that is not submitted", async () => {
    kie.createStatus = 500;
    const team = await seedTeam(db);
    const created = await press(team, "not-yet");
    await reconcileRun(created.requestId);
    expect(calls("https://api.kie.ai/api/v1/jobs/recordInfo")).toHaveLength(0);
    expect(await loadRun(created.requestId)).toMatchObject({ status: "pending", pollAttempts: 0 });
  });
});

/* ---------- mirrorResult ---------- */

describe("mirrorResult", () => {
  it("refreshes the url through download-url when the source answers 403", async () => {
    const team = await seedTeam(db);
    const created = await press(team, "stale");
    await applyRecord(await loadRun(created.requestId), success("task_1", [OUT_1]));
    kie.files.set(OUT_1, { bytes: PNG, contentType: "image/png" });
    interceptFetch((url) => (url === OUT_1 ? new Response(null, { status: 403 }) : undefined));

    await mirrorResult(created.resultIds[0]!);

    const run = await loadRun(created.requestId);
    const key = resultKey(team.teamId, run.projectId, run.id, 0, "png");
    const tile = (await loadResults(run.id))[0]!;
    expect(tile).toMatchObject({
      status: "completed",
      mirrorStatus: "done",
      mirrorAttempts: 0,
      mirrorError: null,
      key,
      url: `https://media.test/${key}`,
      bytes: PNG.byteLength,
      mime: "image/png",
      sourceUrl: OUT_1,
    });
    expect(store.objects.get(key)).toEqual({ bytes: PNG, contentType: "image/png" });
    const fetched = kie.calls.filter((url) => url === OUT_1 || url.startsWith("https://api.kie.ai/api/v1/common/download-url") || url === `${OUT_1}?fresh=1`);
    expect(fetched).toEqual([OUT_1, "https://api.kie.ai/api/v1/common/download-url", `${OUT_1}?fresh=1`]);
    expect(viewOf({ ...run, results: [tile] }).results[0]).toMatchObject({ url: `https://media.test/${key}`, mirrored: true });
  });

  it("marks the mirror failed, counts the attempt and rethrows on a 500 so the job retries", async () => {
    const team = await seedTeam(db);
    const created = await press(team, "broken");
    await applyRecord(await loadRun(created.requestId), success("task_1", [OUT_1]));
    kie.files.set(OUT_1, { bytes: PNG, contentType: "image/png", status: 500 });

    const before = Date.now();
    expect(await runJobs()).toBe(1);

    const tile = (await loadResults(created.requestId))[0]!;
    expect(tile).toMatchObject({ status: "completed", mirrorStatus: "failed", mirrorAttempts: 1, mirrorError: "KIE answered 500 for the result", key: null, url: null });
    const [job] = await jobsOf("mirror_result");
    expect(job).toMatchObject({ dedupeKey: tile.id, status: "queued", attempts: 1, lastError: "KIE answered 500 for the result" });
    expect(job!.runAfter.getTime()).toBeGreaterThanOrEqual(before + 30_000);
    expect(job!.runAfter.getTime()).toBeLessThan(before + 32_000);
    expect(calls("https://api.kie.ai/api/v1/common/download-url")).toHaveLength(0);
    expect(store.objects.size).toBe(0);

    await expect(mirrorResult(tile.id)).rejects.toThrow("KIE answered 500 for the result");
    expect((await loadResults(created.requestId))[0]).toMatchObject({ mirrorStatus: "failed", mirrorAttempts: 2 });
    const run = await loadRun(created.requestId);
    expect(viewOf({ ...run, results: [tile] }).results[0]).toMatchObject({ status: "completed", url: OUT_1, mirrored: false });
  });

  it("is a no-op once the copy is home", async () => {
    const team = await seedTeam(db);
    const created = await press(team, "again");
    await applyRecord(await loadRun(created.requestId), success("task_1", [OUT_1]));
    kie.files.set(OUT_1, { bytes: PNG, contentType: "image/png" });

    await mirrorResult(created.resultIds[0]!);
    const first = (await loadResults(created.requestId))[0]!;
    expect(first.mirrorStatus).toBe("done");
    const fetches = kie.calls.length;
    const objects = store.objects.size;

    await mirrorResult(created.resultIds[0]!);
    expect(kie.calls).toHaveLength(fetches);
    expect(store.objects.size).toBe(objects);
    expect((await loadResults(created.requestId))[0]).toEqual(first);
  });
});

/* ---------- syncRuns ---------- */

describe("syncRuns", () => {
  it("answers the studio while the provider is still waiting to report completion", async () => {
    const team = await seedTeam(db);
    const created = await press(team, "slow-provider");
    await db.update(schema.runs).set({ nextPollAt: new Date(0) });
    kie.defaultRecord = { state: "success", resultJson: JSON.stringify({ resultUrls: [OUT_1] }) };
    kie.files.set(OUT_1, { bytes: PNG, contentType: "image/png" });
    const inner = globalThis.fetch;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      if (urlOf(input).includes("recordInfo")) await gate;
      return inner(input, init);
    });
    const pending = syncRuns(team, [created.requestId]);
    const answer = await Promise.race([pending, new Promise<null>((resolve) => setTimeout(() => resolve(null), 300))]);
    release();
    await pending;
    expect(answer?.[0]).toMatchObject({ requestId: created.requestId, status: "running" });
    await runJobs();
    const [saved] = await syncRuns(team, [created.requestId]);
    expect(saved).toMatchObject({ status: "completed", results: [expect.objectContaining({ mirrored: true })] });
  });

  it("returns and refreshes only the calling team's runs", async () => {
    const mine = await seedTeam(db, { name: "Mine" });
    const theirs = await seedTeam(db, { name: "Theirs" });
    const ours = await press(mine, "ours");
    const other = await press(theirs, "theirs");
    await db.update(schema.runs).set({ nextPollAt: new Date(Date.now() - 1_000) });

    const views = await syncRuns(mine, [ours.requestId, other.requestId]);
    await runJobs();

    expect(views.map((v) => v.requestId)).toEqual([ours.requestId]);
    expect(views[0]).toMatchObject({ status: "running", stalled: false, results: [{ id: ours.resultIds[0], index: 0, status: "running", url: null, mirrored: false }] });
    const polled = calls("https://api.kie.ai/api/v1/jobs/recordInfo");
    expect(polled).toHaveLength(1);
    expect(new URL(polled[0]!).searchParams.get("taskId")).toBe("task_1");
    expect(await loadRun(ours.requestId)).toMatchObject({ pollAttempts: 1 });
    expect(await loadRun(other.requestId)).toMatchObject({ pollAttempts: 0 });
    expect(await syncRuns(theirs, [ours.requestId])).toEqual([]);
  });

  it("refreshes at most five due runs per call, oldest poll first", async () => {
    const team = await seedTeam(db);
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) ids.push((await press(team, `due-${i}`)).requestId);
    for (const [i, id] of ids.entries()) {
      await db.update(schema.runs).set({ nextPollAt: new Date(Date.now() - (10 - i) * 1_000) }).where(eq(schema.runs.id, id));
    }

    const views = await syncRuns(team, ids);
    await runJobs();

    expect(views).toHaveLength(7);
    expect(calls("https://api.kie.ai/api/v1/jobs/recordInfo")).toHaveLength(5);
    const attempts = await Promise.all(ids.map(async (id) => (await loadRun(id)).pollAttempts));
    expect(attempts).toEqual([1, 1, 1, 1, 1, 0, 0]);

    await syncRuns(team, ids);
    await runJobs();
    expect(calls("https://api.kie.ai/api/v1/jobs/recordInfo")).toHaveLength(7);
    expect(await Promise.all(ids.map(async (id) => (await loadRun(id)).pollAttempts))).toEqual([1, 1, 1, 1, 1, 1, 1]);
  });

  it("submits the pending runs it is asked about", async () => {
    const team = await seedTeam(db);
    const key = await drainBucket();
    const created = await press(team, "waiting-room");
    expect(await loadRun(created.requestId)).toMatchObject({ status: "pending" });
    await refillBucket(key);

    const views = await syncRuns(team, [created.requestId]);
    await runJobs();

    expect(kie.tasks).toHaveLength(1);
    expect(kie.tasks[0]!.body).toMatchObject({ model: "nano-banana-pro", input: { prompt: "prompt waiting-room" } });
    expect(await loadRun(created.requestId)).toMatchObject({ status: "submitted", kieTaskId: "task_1", submitAttempts: 1 });
    expect(views).toEqual([
      expect.objectContaining({ requestId: created.requestId, status: "running", results: [expect.objectContaining({ status: "running" })] }),
    ]);
    /* The completed submit job cannot buy the generation a second time. */
    await db.update(schema.jobs).set({ runAfter: new Date(Date.now() - 1_000) });
    expect(await runJobs()).toBe(0);
    expect(kie.tasks).toHaveLength(1);
  });

  it("maps every terminal state into the view", async () => {
    const team = await seedTeam(db);
    const won = await press(team, "won");
    const lost = await press(team, "lost");
    kie.records.set("task_1", { state: "success", resultJson: JSON.stringify({ resultUrls: [OUT_1] }), creditsConsumed: 8 });
    kie.records.set("task_2", { state: "fail", failCode: "500", failMsg: "boom" });
    await db.update(schema.runs).set({ nextPollAt: new Date(Date.now() - 1_000) });

    await syncRuns(team, [won.requestId, lost.requestId]);
    await runJobs(2);
    const views = await syncRuns(team, [won.requestId, lost.requestId]);
    const byId = new Map(views.map((v) => [v.requestId, v]));
    expect(byId.get(won.requestId)).toEqual({
      requestId: won.requestId,
      status: "completed",
      stalled: false,
      creditsConsumed: 8,
      results: [{ id: won.resultIds[0], index: 0, status: "completed", url: OUT_1, mirrored: false }],
    });
    expect(byId.get(lost.requestId)).toEqual({
      requestId: lost.requestId,
      status: "failed",
      stalled: false,
      error: "boom (500)",
      results: [{ id: lost.resultIds[0], index: 0, status: "failed", url: null, mirrored: false, error: "boom (500)" }],
    });
  });
});

/* ---------- resolveInputs ---------- */

describe("resolveInputs", () => {
  it("mints a KIE scratch copy for a team asset when the store is private, and reuses it", async () => {
    store = useMemoryStore({ public: false });
    const team = await seedTeam(db);
    const asset = await seedAsset(team);
    const before = Date.now();

    const created = await press(team, "private", { reference: [{ id: "m1", url: asset.url, role: "reference", assetId: asset.id }] });

    const row = await loadAsset(asset.id);
    expect(row.kieUrl).toMatch(/^https:\/\/tempfile\.test\/uploads\/\d+\.png$/);
    expect(row.kieUrlExpiresAt!.getTime()).toBeGreaterThanOrEqual(before + 20 * HOUR);
    expect(row.kieUrlExpiresAt!.getTime()).toBeLessThan(before + 20 * HOUR + 60_000);
    expect(calls("https://media.test/")).toEqual([asset.url]);
    expect(calls("https://kieai.redpandaai.co/api/file-stream-upload")).toHaveLength(1);
    expect(kie.tasks).toHaveLength(1);
    expect(kie.tasks[0]!.body).toEqual({
      model: "nano-banana-pro",
      input: { prompt: "prompt private", aspect_ratio: "1:1", resolution: "1K", output_format: "png", image_input: [row.kieUrl] },
    });
    const run = await loadRun(created.requestId);
    expect(run.media).toEqual([{ role: "reference", url: asset.url, assetId: asset.id }]);
    expect(run.kieInput).toEqual(kie.tasks[0]!.body);

    /* The copy is good for the day, so the next press does not upload again. */
    await press(team, "private-again", { reference: [{ id: "m1", url: asset.url, role: "reference", assetId: asset.id }] });
    expect(calls("https://kieai.redpandaai.co/api/file-stream-upload")).toHaveLength(1);
    expect(kie.tasks[1]!.body.input).toMatchObject({ image_input: [row.kieUrl] });
    expect((await loadAsset(asset.id)).kieUrl).toBe(row.kieUrl);
  });

  it("resolves a bare url of our own store to the asset behind it and mints its scratch copy", async () => {
    store = useMemoryStore({ public: false });
    const team = await seedTeam(db);
    const asset = await seedAsset(team);

    const created = await press(team, "bare", { reference: [{ id: "m1", url: asset.url, role: "reference" }] });

    const row = await loadAsset(asset.id);
    expect(row.kieUrl).toMatch(/^https:\/\/tempfile\.test\/uploads\/\d+\.png$/);
    expect(kie.tasks[0]!.body.input).toMatchObject({ image_input: [row.kieUrl] });
    expect(calls("https://kieai.redpandaai.co/api/file-stream-upload")).toHaveLength(1);
    const run = await loadRun(created.requestId);
    expect(run.media).toEqual([{ role: "reference", url: asset.url }]);
  });

  it("sends a foreign url as typed", async () => {
    store = useMemoryStore({ public: false });
    const team = await seedTeam(db);

    await press(team, "foreign", { reference: [{ id: "m1", url: "https://elsewhere.example/ref.png", role: "reference" }] });

    expect(kie.tasks[0]!.body.input).toMatchObject({ image_input: ["https://elsewhere.example/ref.png"] });
    expect(calls("https://kieai.redpandaai.co/")).toHaveLength(0);
  });

  it("sends the asset's own url when the store is public", async () => {
    const team = await seedTeam(db);
    const asset = await seedAsset(team);

    await press(team, "public", { reference: [{ id: "m1", url: "https://stale.example/old.png", role: "reference", assetId: asset.id }] });

    expect(kie.tasks[0]!.body).toEqual({
      model: "nano-banana-pro",
      input: { prompt: "prompt public", aspect_ratio: "1:1", resolution: "1K", output_format: "png", image_input: [asset.url] },
    });
    expect(calls("https://kieai.redpandaai.co/")).toHaveLength(0);
    expect(calls("https://media.test/")).toHaveLength(0);
    expect(await loadAsset(asset.id)).toMatchObject({ kieUrl: null, kieUrlExpiresAt: null });
  });

  it("refuses an asset from another team before recording anything", async () => {
    const mine = await seedTeam(db, { name: "Mine" });
    const theirs = await seedTeam(db, { name: "Theirs" });
    const asset = await seedAsset(theirs);

    await expect(press(mine, "stolen", { reference: [{ id: "m1", url: asset.url, role: "reference", assetId: asset.id }] })).rejects.toThrow(
      "An attached file is not in this team",
    );

    expect(kie.tasks).toHaveLength(0);
    expect(await db.select().from(schema.runs)).toHaveLength(0);
    expect(await db.select().from(schema.results)).toHaveLength(0);
    expect(await db.select().from(schema.jobs)).toHaveLength(0);
  });
});
