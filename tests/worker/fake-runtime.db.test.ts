import { eq } from "drizzle-orm";
import { strToU8, zipSync } from "fflate";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { envForTests, resetStubs, seedTeam, useMemoryStore, useTestDatabase, type MemoryStore, type TestDb } from "../server/harness";

import { actorOf, createRun, getRunById, installSkillFromZip, listArtifacts, listEvents, pushInput } from "@/server/agents";
import type { AgentEventPayload } from "@/server/agents-contract";
import * as schema from "@/server/db/schema";
import { listResults } from "@/server/gallery";
import { ensureDefaultProject } from "@/server/runs";
import type { TeamContext } from "@/server/team";

import { coreStore } from "../../worker/core-store";
import { createLogger } from "../../worker/log";
import { Masker } from "../../worker/mask";
import type { ObjectReader } from "../../worker/objects";
import { runAgent, type RunDeps } from "../../worker/run";
import { FAKE_APPROVAL_ID, FAKE_COST_USD, FAKE_CREDITS, FAKE_QUESTION_ID, FakeRuntime } from "../../worker/runtimes/fake";

/* The same walk against the real core and the harness database: the run is
   created the way the studio creates it, the worker claims it through
   coreStore, and the person's answers arrive through pushInput — the path
   the server actions take. PGlite boots per file, so one run per test. */

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const QUESTION = "Which direction should the first batch take?";

let db: TestDb;
let media: MemoryStore;
let team: TeamContext;
let projectId: string;
let root: string;
let shutdown: AbortController;

function zipOf(files: Record<string, string>): Uint8Array {
  return zipSync(Object.fromEntries(Object.entries(files).map(([name, body]) => [name, strToU8(body)])));
}

/** The harness store keeps objects in memory under "local"; the worker reads them from there. */
function reader(): ObjectReader {
  return {
    async read(key) {
      const object = media.objects.get(key);
      if (!object) throw new Error(`no object ${key}`);
      return object.bytes;
    },
    keyOf(url) {
      const base = media.publicUrl("");
      return url.startsWith(base) ? url.slice(base.length) : null;
    },
  };
}

function deps(): RunDeps {
  return {
    store: coreStore(),
    media,
    objects: reader(),
    runtime: new FakeRuntime(),
    homeRoot: root,
    workerId: "test-worker",
    credentials: async () => ({ KIE_API_KEY: "kie-0123456789abcdef" }),
    processEnv: { PATH: "/usr/bin" },
    signal: shutdown.signal,
    log: createLogger(new Masker({ KIE_API_KEY: "kie-0123456789abcdef" }), { sink: () => undefined }),
    leaseRenewMs: 200,
    inboxPollMs: 20,
  };
}

async function payloads(runId: string): Promise<AgentEventPayload[]> {
  return (await listEvents(team, runId, 0, 200)).map((event) => event.payload);
}

async function find<K extends AgentEventPayload["kind"]>(runId: string, kind: K): Promise<Extract<AgentEventPayload, { kind: K }>[]> {
  return (await payloads(runId)).filter((payload): payload is Extract<AgentEventPayload, { kind: K }> => payload.kind === kind);
}

async function untilEvent<K extends AgentEventPayload["kind"]>(runId: string, kind: K, count = 1) {
  let seen: Extract<AgentEventPayload, { kind: K }>[] = [];
  const deadline = Date.now() + 20_000;
  while (seen.length < count) {
    if (Date.now() > deadline) throw new Error(`no ${kind} event in time`);
    await new Promise((resolve) => setTimeout(resolve, 25));
    seen = await find(runId, kind);
  }
  return seen;
}

beforeEach(async () => {
  envForTests();
  db = await useTestDatabase();
  media = useMemoryStore({ public: true });
  team = await seedTeam(db, { name: "Ada" });
  projectId = (await ensureDefaultProject(team)).project.id;
  root = await mkdtemp(path.join(os.tmpdir(), "ohf-worker-db-"));
  shutdown = new AbortController();
});

afterEach(async () => {
  shutdown?.abort();
  if (root) await rm(root, { recursive: true, force: true });
  resetStubs();
});

describe("the fake runtime against the harness database", () => {
  it("claims the run, answers through pushInput, records artifacts and puts the board on the wall", async () => {
    const skill = await installSkillFromZip(team, {
      bytes: zipOf({ "SKILL.md": "---\nname: Drama Ad Machine\ndescription: Makes ads.\n---\n# Drama\n", "scripts/kie.py": "print(1)\n", "agents/sd2-qc.md": "---\nname: sd2-qc\n---\n" }),
      fileName: "drama.zip",
      createdBy: team.userId,
    });
    expect(skill.status).toBe("ready");
    const created = await createRun(team, { skillId: skill.id, projectId, title: "Hook test", brief: "Make three hooks.", attachmentAssetIds: [] });

    const store = coreStore();
    const claimed = await store.claimRun("test-worker");
    expect(claimed?.id).toBe(created.id);
    expect(await store.claimRun("another")).toBeNull();
    const ending = runAgent(claimed!, deps());

    const [question] = await untilEvent(created.id, "question");
    expect(question).toMatchObject({ questionId: FAKE_QUESTION_ID, answers: null });
    await pushInput(team, created.id, { kind: "answer", questionId: FAKE_QUESTION_ID, answers: { [QUESTION]: "Go deep" } }, actorOf(team));

    const [approval] = await untilEvent(created.id, "approval");
    expect(approval).toMatchObject({ approvalId: FAKE_APPROVAL_ID, decision: null });
    expect((await find(created.id, "question"))[0]).toMatchObject({ answers: { [QUESTION]: "Go deep" }, answeredBy: "Ada" });
    await pushInput(team, created.id, { kind: "approval", approvalId: FAKE_APPROVAL_ID, decision: "approved" }, actorOf(team));

    expect(await ending).toEqual({ status: "done", error: null });

    const run = (await getRunById(created.id))!;
    expect(run).toMatchObject({ status: "done", sessionId: `fake-${created.id}`, credits: FAKE_CREDITS, error: null });
    expect(run.costUsd).toBeCloseTo(FAKE_COST_USD, 4);
    expect(run.endedAt).not.toBeNull();
    expect(run.workspace).toBe(path.join(root, team.teamId, "runs", created.id));

    const all = await payloads(created.id);
    const statuses = all.filter((payload) => payload.kind === "status").map((payload) => (payload as { status: string }).status);
    expect(statuses).toEqual(["running", "waiting", "running", "waiting", "running", "done"]);
    expect(all.filter((payload) => payload.kind === "artifact").map((payload) => (payload as { path: string }).path)).toEqual(["outputs/board.png", "outputs/board.md", "outputs/plan.md"]);
    expect((await find(created.id, "approval"))[0]).toMatchObject({ decision: "approved", decidedBy: "Ada" });
    /* Every seq is there once and in order: what the studio's sync relies on. */
    const seqs = (await listEvents(team, created.id, 0, 200)).map((event) => event.seq);
    expect(seqs).toEqual(seqs.map((_, index) => index + 1));

    const artifacts = await listArtifacts(team, created.id);
    expect(artifacts.map((artifact) => artifact.path).sort()).toEqual(["outputs/board.md", "outputs/board.png", "outputs/plan.md"]);
    const board = artifacts.find((artifact) => artifact.path === "outputs/board.png")!;
    expect(board.resultId).toEqual(expect.any(String));
    expect(media.objects.has(board.storageKey)).toBe(true);

    const { items } = await listResults(team, { view: "image", projectId }, null);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: board.resultId, kind: "image", modelId: "agent:drama-ad-machine", urls: [board.url], status: "completed" });
  });

  it("a stop pushed while the run waits ends it as stopped", async () => {
    const skill = await installSkillFromZip(team, {
      bytes: zipOf({ "SKILL.md": "---\nname: Quick\ndescription: Quick.\n---\n" }),
      fileName: "quick.zip",
      createdBy: team.userId,
    });
    const created = await createRun(team, { skillId: skill.id, projectId, title: "Stop me", brief: "Go.", attachmentAssetIds: [] });
    const store = coreStore();
    const ending = runAgent((await store.claimRun("test-worker"))!, deps());
    await untilEvent(created.id, "question");
    await pushInput(team, created.id, { kind: "stop" }, actorOf(team));
    expect(await ending).toEqual({ status: "stopped", error: null });
    const run = (await getRunById(created.id))!;
    expect(run.status).toBe("stopped");
    const statuses = (await find(created.id, "status")).map((status) => status.status);
    expect(statuses.slice(-2)).toEqual(["stopping", "stopped"]);
  });

  it("an answer to a card left open by a worker that died reaches the session that resumes the run", async () => {
    const skill = await installSkillFromZip(team, {
      bytes: zipOf({ "SKILL.md": "---\nname: Quick\ndescription: Quick.\n---\n" }),
      fileName: "quick.zip",
      createdBy: team.userId,
    });
    const created = await createRun(team, { skillId: skill.id, projectId, title: "Resume me", brief: "Go.", attachmentAssetIds: [] });
    const store = coreStore();

    /* The first worker asks, then goes down while the card is open; the run goes back to the queue with its session. */
    const first = runAgent((await store.claimRun("test-worker"))!, deps());
    await untilEvent(created.id, "question");
    shutdown.abort();
    expect(await first).toEqual({ status: "released" });
    await db.update(schema.agentRuns).set({ sessionId: `fake-${created.id}` }).where(eq(schema.agentRuns.id, created.id));
    expect((await getRunById(created.id))!.status).toBe("queued");

    /* The team answers the card that is still open in the studio; the answer settles it and waits as an input. */
    await pushInput(team, created.id, { kind: "answer", questionId: FAKE_QUESTION_ID, answers: { [QUESTION]: "Go deep" } }, actorOf(team));
    expect((await find(created.id, "question"))[0]).toMatchObject({ answers: { [QUESTION]: "Go deep" }, answeredBy: "Ada" });

    /* The next worker resumes the session and is told the answer, instead of waiting for a message that never comes. */
    shutdown = new AbortController();
    const second = runAgent((await store.claimRun("test-worker"))!, deps());
    expect(await second).toEqual({ status: "done", error: null });
    expect((await find(created.id, "text")).map((text) => text.text).join("\n")).toContain("the team settled: Go deep");
    expect((await getRunById(created.id))!.status).toBe("done");
  });
});
