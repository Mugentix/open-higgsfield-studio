import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import * as schema from "@/server/db/schema";
import { claim, enqueue, fail } from "@/server/jobs/queue";
import { GET } from "@/app/api/cron/tick/route";
import { createRun, syncRuns } from "@/server/runs";
import { envForTests, seedTeam, stubKie, useMemoryStore } from "./harness";

// Run against a disposable local database: POSTGRES_TEST_URL=... pnpm test
// PGlite accepts raw Date parameters that the production driver rejects.
const url = process.env.POSTGRES_TEST_URL;
describe.skipIf(!url)("production Postgres job scheduling", () => {
  let client: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  beforeAll(async () => {
    const target = new URL(url!);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(target.hostname) || !target.pathname.endsWith("_test")) {
      throw new Error("POSTGRES_TEST_URL must name a disposable local database ending in _test");
    }
    envForTests();
    client = postgres(url!, { max: 1, prepare: false });
    db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: "drizzle" });
    globalThis.__ohfDb = { db, ready: Promise.resolve(), kind: "postgres" };
    await db.delete(schema.jobs);
    await db.delete(schema.runs);
  });
  afterAll(async () => {
    globalThis.__ohfDb = undefined;
    globalThis.__ohfStore = undefined;
    await client?.end();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("reschedules a failed job without losing its retry delay", async () => {
    await enqueue("purge_media", "test/scheduled.png", { key: "test/scheduled.png" });
    const [job] = await claim(1, "postgres-test");
    expect(job?.dedupeKey).toBe("test/scheduled.png");
    expect(await fail(job!, "Temporary storage outage", 60_000)).toBe("retry");
    expect(await claim(1, "too-early")).toEqual([]);
    const [saved] = await client`SELECT status, last_error, run_after > now() AS delayed FROM jobs WHERE id = ${job!.id}`;
    expect(saved).toEqual({ status: "queued", last_error: "Temporary storage outage", delayed: true });
  });

  it("reconciles a provider failure through cron so the studio stops showing it as running", async () => {
    await db.delete(schema.jobs);
    useMemoryStore();
    const kie = stubKie();
    const team = await seedTeam(db);
    const created = await createRun(team, {
      idempotencyKey: "already-failed",
      plane: { model: "nano-banana-pro", prompt: { text: "Failed generation" }, media: {}, settings: {} },
    });
    kie.defaultRecord = { state: "fail", failCode: "500", failMsg: "Provider could not generate" };
    await db.update(schema.runs).set({ nextPollAt: new Date(0) }).where(eq(schema.runs.id, created.requestId));
    const response = await GET(new Request("http://localhost/api/cron/tick"));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ due: 1, ran: 1 });
    expect(await syncRuns(team, [created.requestId])).toEqual([
      expect.objectContaining({ status: "failed", error: "Provider could not generate (500)", results: [expect.objectContaining({ status: "failed" })] }),
    ]);
    const idle = await GET(new Request("http://localhost/api/cron/tick"));
    expect(await idle.json()).toMatchObject({ due: 0, ran: 0 });
    expect(kie.tasks).toHaveLength(1);
  });
});
