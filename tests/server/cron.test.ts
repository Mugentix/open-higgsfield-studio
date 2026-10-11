import { asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { envForTests, resetStubs, seedTeam, stubKie, useMemoryStore, useTestDatabase, type TestDb } from "./harness";

import { GET } from "@/app/api/cron/tick/route";
import * as schema from "@/server/db/schema";
import { BUCKET_CAPACITY, bucketKeyFor, takeToken } from "@/server/rate-limit";
import { SUBMIT_CLAIM_STALE_MS, createRun } from "@/server/runs";
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
