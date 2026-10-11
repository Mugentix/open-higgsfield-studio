import { asc, eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { envForTests, resetStubs, seedTeam, stubKie, useMemoryStore, useTestDatabase, type TestDb } from "./harness";

import { GET } from "@/app/api/cron/tick/route";
import * as schema from "@/server/db/schema";
import { BUCKET_CAPACITY, bucketKeyFor, takeToken } from "@/server/rate-limit";
import { SUBMIT_CLAIM_STALE_MS, createRun, reconcileRun } from "@/server/runs";
import type { TeamContext } from "@/server/team";

vi.setConfig({ testTimeout: 30_000 });

let db: TestDb;

beforeEach(async () => {
  envForTests();
  delete process.env.CRON_SECRET;
  db = await useTestDatabase();
  useMemoryStore({ public: true });
  stubKie();
});

afterEach(() => {
  resetStubs();
  globalThis.__ohfJobsRunning = false;
});

async function pendingRun(team: TeamContext, key: string) {
  const created = await createRun(team, { plane: { model: "nano-banana-pro", prompt: { text: key }, media: {}, settings: {} }, idempotencyKey: key });
  await db.delete(schema.jobs);
  return created.requestId;
}

describe("cron tick", () => {
  it("reports the failed maintenance stage without exposing the database query", async () => {
    await db.execute(sql`ALTER TABLE runs RENAME TO unavailable_runs`);
    const response = await GET(new Request("http://localhost/api/cron/tick"));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Maintenance failed", stage: "find_due_runs", code: "42P01" });
  });

  it("preserves a scheduled copy retry instead of retrying it on every cron tick", async () => {
    const team = await seedTeam(db);
    const kie = stubKie();
    kie.defaultRecord = { state: "success", resultJson: JSON.stringify({ resultUrls: ["https://tempfile.test/later.png"] }) };
    const id = await pendingRun(team, "backoff-copy");
    await reconcileRun(id);
    const later = new Date(Date.now() + 60 * 60_000);
    await db.update(schema.jobs).set({ runAfter: later, attempts: 3 });
    await GET(new Request("http://localhost/api/cron/tick"));
    expect(await db.query.jobs.findFirst()).toMatchObject({ status: "queued", attempts: 3, runAfter: later });
    expect((await db.query.results.findFirst())!.mirrorStatus).toBe("queued");
  });

  it("does not recover files the user deleted", async () => {
    const team = await seedTeam(db);
    const kie = stubKie();
    kie.defaultRecord = { state: "success", resultJson: JSON.stringify({ resultUrls: ["https://tempfile.test/deleted.png"] }) };
    const id = await pendingRun(team, "deleted-copy");
    await reconcileRun(id);
    await db.delete(schema.jobs);
    await db.update(schema.results).set({ deletedAt: new Date() });
    await GET(new Request("http://localhost/api/cron/tick"));
    expect(await db.query.jobs.findMany()).toEqual([]);
    expect((await db.query.results.findFirst())!.key).toBeNull();
  });

  it("recovers a failed save after storage is repaired without generating again", async () => {
    const team = await seedTeam(db);
    const kie = stubKie();
    const sourceUrl = "https://tempfile.test/retry.png";
    kie.defaultRecord = { state: "success", resultJson: JSON.stringify({ resultUrls: [sourceUrl] }) };
    kie.files.set(sourceUrl, { bytes: new Uint8Array([137, 80, 78, 71]), contentType: "image/png" });
    const id = await pendingRun(team, "retry-copy");
    await reconcileRun(id);
    await db.update(schema.results).set({ status: "failed", mirrorStatus: "failed", mirrorError: "R2 is not configured", error: "copy not saved" }).where(eq(schema.results.runId, id));
    await db.update(schema.jobs).set({ status: "dead", attempts: 6, updatedAt: new Date(Date.now() - 2 * 60 * 60_000) });
    await GET(new Request("http://localhost/api/cron/tick"));
    const result = await db.query.results.findFirst({ where: eq(schema.results.runId, id) });
    expect(result).toMatchObject({ status: "completed", mirrorStatus: "done", error: null, mirrorError: null });
    expect(await globalThis.__ohfStore!.head(result!.key!)).toEqual({ bytes: 4, contentType: "image/png" });
    expect(kie.tasks).toHaveLength(1);
  });

  it("saves completed media after a request was interrupted before the copy job was persisted", async () => {
    const team = await seedTeam(db);
    const kie = stubKie();
    const sourceUrl = "https://tempfile.test/recover.png";
    kie.defaultRecord = { state: "success", resultJson: JSON.stringify({ resultUrls: [sourceUrl] }) };
    kie.files.set(sourceUrl, { bytes: new Uint8Array([137, 80, 78, 71]), contentType: "image/png" });
    const id = await pendingRun(team, "orphan-copy");
    await reconcileRun(id);
    await db.delete(schema.jobs);
    await GET(new Request("http://localhost/api/cron/tick"));
    const result = await db.query.results.findFirst({ where: eq(schema.results.runId, id) });
    expect(result).toMatchObject({ status: "completed", mirrorStatus: "done", sourceUrl });
    expect(await globalThis.__ohfStore!.head(result!.key!)).toEqual({ bytes: 4, contentType: "image/png" });
    expect(kie.tasks).toHaveLength(1);
  });

  it("re-queues pending runs and stale submit claims, and leaves a live claim alone", async () => {
    const team = await seedTeam(db);
    const bucket = bucketKeyFor(process.env.KIE_API_KEY!);
    for (let i = 0; i < BUCKET_CAPACITY + 1; i++) await takeToken(bucket);
    const pending = await pendingRun(team, "pending");
    const stale = await pendingRun(team, "stale");
    const live = await pendingRun(team, "live");
    await db.update(schema.runs).set({ status: "submitting", updatedAt: new Date(Date.now() - SUBMIT_CLAIM_STALE_MS - 1000) }).where(eq(schema.runs.id, stale));
    await db.update(schema.runs).set({ status: "submitting", updatedAt: new Date() }).where(eq(schema.runs.id, live));

    const response = await GET(new Request("http://localhost/api/cron/tick"));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ pending: 2 });
    const jobs = await db.query.jobs.findMany({ where: eq(schema.jobs.type, "submit_run"), orderBy: asc(schema.jobs.dedupeKey) });
    expect(jobs.map((job) => job.dedupeKey).sort()).toEqual([pending, stale].sort());
    /* The bucket is still empty, so the drain only rescheduled them. */
    expect(jobs.every((job) => job.status === "queued" && job.attempts === 0)).toBe(true);
    expect((await db.query.runs.findFirst({ where: eq(schema.runs.id, live) }))!.status).toBe("submitting");
  });
});
