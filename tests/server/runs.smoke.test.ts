import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { envForTests, resetStubs, seedTeam, stubKie, useMemoryStore, useTestDatabase, type FakeKie, type TestDb } from "./harness";

import * as schema from "@/server/db/schema";
import { createRun, reconcileRun } from "@/server/runs";
import { runJobs } from "@/server/jobs/runner";

let db: TestDb;
let kie: FakeKie;

beforeEach(async () => {
  envForTests();
  db = await useTestDatabase();
  useMemoryStore({ public: true });
  kie = stubKie();
});

afterEach(() => resetStubs());

describe("run lifecycle (harness smoke)", () => {
  it("records, submits, settles and mirrors one image", async () => {
    const team = await seedTeam(db);
    const created = await createRun(team, {
      plane: { model: "nano-banana-pro", prompt: { text: "a red mug" }, media: {}, settings: {} },
      idempotencyKey: "press-1",
    });
    expect(created.resultIds).toHaveLength(1);
    expect(kie.tasks).toHaveLength(1);
    expect(kie.tasks[0]!.body).toMatchObject({ model: "nano-banana-pro", input: { prompt: "a red mug", resolution: "1K" } });

    const run = await db.query.runs.findFirst({ where: (r, { eq }) => eq(r.id, created.requestId) });
    expect(run?.status).toBe("submitted");
    expect(run?.kieTaskId).toBe("task_1");

    kie.files.set("https://tempfile.test/out/1.png", { bytes: new Uint8Array([137, 80, 78, 71]), contentType: "image/png" });
    kie.records.set("task_1", {
      state: "success",
      resultJson: JSON.stringify({ resultUrls: ["https://tempfile.test/out/1.png"] }),
      creditsConsumed: 8,
    });
    await reconcileRun(created.requestId);
    const settled = await db.query.results.findFirst({ where: (r, { eq }) => eq(r.id, created.resultIds[0]!) });
    expect(settled).toMatchObject({ status: "completed", sourceUrl: "https://tempfile.test/out/1.png", mirrorStatus: "queued" });

    const ran = await runJobs();
    expect(ran).toBe(1);
    const mirrored = await db.query.results.findFirst({ where: (r, { eq }) => eq(r.id, created.resultIds[0]!) });
    expect(mirrored?.mirrorStatus).toBe("done");
    expect(mirrored?.url).toMatch(/^https:\/\/media\.test\/t\//);
    expect(mirrored?.url).toMatch(/\/0\.png$/);
    const ledger = await db.select().from(schema.creditLedger);
    expect(ledger).toHaveLength(1);
    expect(Number(ledger[0]!.credits)).toBe(8);
  });

  it("returns the same run for the same idempotency key without a second task", async () => {
    const team = await seedTeam(db);
    const input = { plane: { model: "nano-banana-pro", prompt: { text: "x" }, media: {}, settings: {} }, idempotencyKey: "press-2" };
    const first = await createRun(team, input);
    const second = await createRun(team, input);
    expect(second.requestId).toBe(first.requestId);
    expect(kie.tasks).toHaveLength(1);
  });
});
