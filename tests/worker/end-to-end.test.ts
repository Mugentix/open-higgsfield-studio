import { strToU8, zipSync } from "fflate";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/* The Agents surface is off by default; this file tests it switched on. Hoisted
   so the route module reads the flag when it loads, before any test runs. */
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_AGENTS = "1";
});

import { envForTests, resetStubs, seedTeam, useMemoryStore, useTestDatabase, type MemoryStore, type TestDb } from "../server/harness";

import { POST as uploadSkill } from "@/app/api/skills/route";
import {
  answerAgentQuestion,
  createAgentRun,
  decideAgentApproval,
  listAgentArtifacts,
  listAgentRuns,
  publishAgentArtifact,
  stopAgentRun,
  syncAgentEvents,
} from "@/server/agent-actions";
import type { AgentEventRecord, AgentRunRecord, SkillRecord } from "@/server/agents-contract";
import * as schema from "@/server/db/schema";
import { listResults } from "@/server/gallery";
import type { ActionResult } from "@/server/result";
import { ensureDefaultProject } from "@/server/runs";
import { listSkills } from "@/server/skill-actions";
import { requireTeam, type TeamContext } from "@/server/team";

import { coreStore } from "../../worker/core-store";
import { readConfig } from "../../worker/env";
import { createLogger } from "../../worker/log";
import { workerTick, type ActiveRuns, type LoopDeps } from "../../worker/loop";
import { Masker } from "../../worker/mask";
import type { ObjectReader } from "../../worker/objects";
import { FAKE_APPROVAL_ID, FAKE_COST_USD, FAKE_CREDITS, FAKE_QUESTION_ID, png1x1 } from "../../worker/runtimes/fake";
import { selectRuntime } from "../../worker/runtimes/select";

/* The whole feature, the way its three sides meet in production: the skill
   arrives through POST /api/skills, the run through the server actions, the
   worker's own pass claims it (AGENT_RUNTIME=fake, so no model and no key),
   the run view's sync action reads the stream, the answers go back through
   the actions — pushInput underneath — and the board lands on the wall where
   listResults finds it. The session is a mock that answers with the seeded
   team; the database is a fresh PGlite with the real migrations. */

vi.mock("@/server/team", () => ({ requireTeam: vi.fn() }));
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const QUESTION = "Which direction should the first batch take?";
const KIE_KEY = "kie-0123456789abcdef";
const REF = png1x1();

let db: TestDb;
let media: MemoryStore;
let team: TeamContext;
let projectId: string;
let root: string;
let shutdown: AbortController;

function ok<T>(result: ActionResult<T>): T {
  if (!result.ok) throw new Error(result.error);
  return result.data;
}

function zipOf(files: Record<string, string>): Uint8Array {
  return zipSync(Object.fromEntries(Object.entries(files).map(([name, body]) => [name, strToU8(body)])));
}

/** A File over a fresh ArrayBuffer-backed copy, which is what a File takes. */
function fileOf(bytes: Uint8Array, name: string): File {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new File([copy], name, { type: "application/zip" });
}

/** The upload as the Skills tab sends it: multipart, field `file`. */
async function uploadZip(fileName: string, files: Record<string, string>): Promise<{ status: number; body: SkillRecord & { error?: string } }> {
  const form = new FormData();
  form.append("file", fileOf(zipOf(files), fileName));
  const response = await uploadSkill(new Request("http://localhost/api/skills", { method: "POST", body: form }));
  return { status: response.status, body: (await response.json()) as SkillRecord & { error?: string } };
}

/** The harness store keeps objects in memory; the worker reads them from there. */
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

/** The loop's dependencies as main.ts assembles them, the runtime chosen the
    way main.ts chooses it: from AGENT_RUNTIME. */
async function loopDeps(): Promise<LoopDeps> {
  const runtime = await selectRuntime(readConfig(process.env));
  expect(runtime.name).toBe("fake");
  return {
    store: coreStore(),
    media,
    objects: reader(),
    runtime,
    homeRoot: root,
    workerId: "e2e-worker",
    credentials: async () => ({ KIE_API_KEY: KIE_KEY }),
    processEnv: { PATH: "/usr/bin" },
    signal: shutdown.signal,
    log: createLogger(new Masker({ KIE_API_KEY: KIE_KEY }), { sink: () => undefined }),
    leaseRenewMs: 200,
    inboxPollMs: 20,
    concurrency: 2,
  };
}

/** A file in the team library, its bytes in the store, as an upload leaves it. */
async function seedAsset(name: string, bytes: Uint8Array) {
  const id = randomUUID();
  const key = `t/${team.teamId}/u/2026/10/${id}.png`;
  media.objects.set(key, { bytes, contentType: "image/png" });
  await db.insert(schema.assets).values({
    id,
    teamId: team.teamId,
    userId: team.userId,
    source: "upload",
    kind: "image",
    name,
    mime: "image/png",
    bytes: bytes.byteLength,
    key,
    url: media.publicUrl(key),
    status: "ready",
  });
  return { id, name, url: media.publicUrl(key) };
}

/** Polls the sync action from the last seq held, as the run view does — new
    events appended, gates replaced by seq — until `done` holds. */
async function watch(
  runId: string,
  done: (events: AgentEventRecord[], run: AgentRunRecord) => boolean,
): Promise<{ events: AgentEventRecord[]; run: AgentRunRecord }> {
  const held = new Map<number, AgentEventRecord>();
  const deadline = Date.now() + 30_000;
  for (;;) {
    const page = ok(await syncAgentEvents({ runId, afterSeq: Math.max(0, ...held.keys()) }));
    for (const event of [...page.events, ...page.gates]) held.set(event.seq, event);
    const events = [...held.values()].sort((a, b) => a.seq - b.seq);
    if (done(events, page.run)) return { events, run: page.run };
    if (Date.now() > deadline) throw new Error(`gave up on run ${runId} while ${page.run.status}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

type Payload = AgentEventRecord["payload"];

function kind<K extends Payload["kind"]>(events: AgentEventRecord[], wanted: K): Array<AgentEventRecord & { payload: Extract<Payload, { kind: K }> }> {
  return events.filter((event): event is AgentEventRecord & { payload: Extract<Payload, { kind: K }> } => event.payload.kind === wanted);
}

const QUICK = { "SKILL.md": "---\nname: Quick\ndescription: Quick.\n---\n" };

beforeEach(async () => {
  envForTests();
  process.env.AGENT_RUNTIME = "fake";
  db = await useTestDatabase();
  media = useMemoryStore({ public: true });
  team = await seedTeam(db, { name: "Ada" });
  vi.mocked(requireTeam).mockReset();
  vi.mocked(requireTeam).mockResolvedValue(team);
  projectId = (await ensureDefaultProject(team)).project.id;
  root = await mkdtemp(path.join(os.tmpdir(), "ohf-e2e-"));
  shutdown = new AbortController();
});

afterEach(async () => {
  shutdown.abort();
  delete process.env.AGENT_RUNTIME;
  await rm(root, { recursive: true, force: true });
  resetStubs();
});

describe("a skill run, end to end", () => {
  it("uploads through the route, starts through the actions, runs on the worker's pass, answers through the actions and lands on the wall", async () => {
    const upload = await uploadZip("drama-ad-machine.zip", {
      "SKILL.md": "---\nname: Drama Ad Machine\ndescription: Makes ads.\n---\n# Drama\n",
      "scripts/kie.py": "print(1)\n",
      "agents/sd2-qc.md": "---\nname: sd2-qc\ndescription: Looks at takes.\n---\n",
    });
    expect(upload.status).toBe(200);
    const skill = upload.body;
    expect(skill).toMatchObject({ status: "ready", slug: "drama-ad-machine", name: "Drama Ad Machine", agents: ["sd2-qc"], problems: [] });
    expect(ok(await listSkills()).map((entry) => entry.id)).toEqual([skill.id]);

    const ref = await seedAsset("ref.png", REF);
    const created = ok(await createAgentRun({ skillId: skill.id, projectId, title: "Hook test", brief: "Make three hooks.", attachmentAssetIds: [ref.id] }));
    expect(created).toMatchObject({ status: "queued", skillSlug: "drama-ad-machine", lastSeq: 1 });

    /* One pass of the worker's loop claims and starts the run; the next pass finds the queue empty. */
    const deps = await loopDeps();
    const active: ActiveRuns = new Map();
    expect((await workerTick(deps, active)).map((run) => run.id)).toEqual([created.id]);
    expect(active.size).toBe(1);
    expect(await workerTick(deps, active)).toEqual([]);

    /* The agent asks; the card arrives through the sync action, open. The first answer stands. */
    const asked = await watch(created.id, (events) => kind(events, "question").length > 0);
    expect(asked.run.status).toBe("waiting");
    const [question] = kind(asked.events, "question");
    expect(question!.payload).toMatchObject({ questionId: FAKE_QUESTION_ID, answers: null, answeredBy: null });
    expect(question!.payload.questions[0]!.question).toBe(QUESTION);
    ok(await answerAgentQuestion({ runId: created.id, questionId: FAKE_QUESTION_ID, answers: { [QUESTION]: "Go deep" } }));
    expect(await answerAgentQuestion({ runId: created.id, questionId: FAKE_QUESTION_ID, answers: { [QUESTION]: "Go wide" } })).toEqual({
      ok: false,
      error: "Already answered by Ada",
    });

    /* The paid gate. By now the question card this tab already passed carries the answer, through `gates`. */
    const held = await watch(created.id, (events) => kind(events, "approval").length > 0);
    expect(held.run.status).toBe("waiting");
    const [approval] = kind(held.events, "approval");
    expect(approval!.payload).toMatchObject({ approvalId: FAKE_APPROVAL_ID, toolName: "Bash", command: expect.stringContaining("--confirm-paid"), decision: null });
    expect(held.events.find((event) => event.seq === question!.seq)!.payload).toMatchObject({ answers: { [QUESTION]: "Go deep" }, answeredBy: "Ada" });
    ok(await decideAgentApproval({ runId: created.id, approvalId: FAKE_APPROVAL_ID, decision: "approved" }));
    expect(await decideAgentApproval({ runId: created.id, approvalId: FAKE_APPROVAL_ID, decision: "denied" })).toEqual({ ok: false, error: "Already decided by Ada" });

    /* The run ends and leaves the loop's hands. */
    await active.get(created.id);
    expect(active.size).toBe(0);
    const ended = await watch(created.id, (_, run) => run.status === "done");
    expect(ended.run).toMatchObject({
      status: "done",
      credits: FAKE_CREDITS,
      sessionId: `fake-${created.id}`,
      error: null,
      workspace: path.join(root, team.teamId, "runs", created.id),
    });
    expect(ended.run.costUsd).toBeCloseTo(FAKE_COST_USD, 4);
    expect(ended.run.endedAt).not.toBeNull();
    /* Every seq once and in order: what the run view's sync relies on. */
    expect(ended.events.map((event) => event.seq)).toEqual(ended.events.map((_, index) => index + 1));
    expect(ended.events[0]!.payload).toMatchObject({ kind: "user", text: "Make three hooks.", userName: "Ada", attachments: [{ name: "ref.png", url: ref.url }] });
    expect(kind(ended.events, "status").map((event) => event.payload.status)).toEqual(["running", "waiting", "running", "waiting", "running", "done"]);
    expect(ended.events.find((event) => event.seq === approval!.seq)!.payload).toMatchObject({ decision: "approved", decidedBy: "Ada" });
    expect(kind(ended.events, "result")[0]!.payload).toMatchObject({ subtype: "success", costUsd: FAKE_COST_USD, sessionId: `fake-${created.id}` });
    expect(JSON.stringify(ended.events)).not.toContain(KIE_KEY);

    /* The workspace: the attachment under its own name; the key in .env, for the scripts alone. */
    const workspace = ended.run.workspace!;
    expect(new Uint8Array(await readFile(path.join(workspace, "inputs", "ref.png")))).toEqual(REF);
    expect((await stat(path.join(workspace, ".env"))).mode & 0o777).toBe(0o600);
    expect(await readFile(path.join(workspace, ".env"), "utf8")).toContain("KIE_API_KEY=");

    /* Artifacts: three files recorded, the board on the wall, the plan kept off it. */
    const artifacts = ok(await listAgentArtifacts(created.id));
    expect(artifacts.map((artifact) => artifact.path).sort()).toEqual(["outputs/board.md", "outputs/board.png", "outputs/plan.md"]);
    expect(kind(ended.events, "artifact").map((event) => event.payload.path)).toEqual(["outputs/board.png", "outputs/board.md", "outputs/plan.md"]);
    const board = artifacts.find((artifact) => artifact.path === "outputs/board.png")!;
    expect(board.resultId).toEqual(expect.any(String));
    expect(media.objects.get(board.storageKey)?.bytes.byteLength).toBe(board.sizeBytes);
    const plan = artifacts.find((artifact) => artifact.path === "outputs/plan.md")!;
    expect(await publishAgentArtifact({ artifactId: plan.id })).toEqual({ ok: false, error: "Only images and videos go on the wall" });
    expect(ok(await publishAgentArtifact({ artifactId: board.id })).resultId).toBe(board.resultId);

    const { items } = await listResults(team, { view: "image", projectId }, null);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: board.resultId,
      kind: "image",
      modelId: "agent:drama-ad-machine",
      modelLabel: "Drama Ad Machine",
      urls: [board.url],
      status: "completed",
    });

    /* The list shows it done; a run that ended takes nothing more. */
    expect(ok(await listAgentRuns({ projectId })).map((run) => [run.id, run.status])).toEqual([[created.id, "done"]]);
    expect(await stopAgentRun(created.id)).toEqual({ ok: false, error: "The run has ended" });
  });

  it("a stop on a queued run ends it before any worker, and the pass finds nothing to claim", async () => {
    const upload = await uploadZip("quick.zip", QUICK);
    expect(upload.status).toBe(200);
    const created = ok(await createAgentRun({ skillId: upload.body.id, projectId, title: "Stop me", brief: "Go.", attachmentAssetIds: [] }));
    expect(ok(await stopAgentRun(created.id))).toMatchObject({ status: "stopped", error: "Stopped by Ada" });
    expect(await workerTick(await loopDeps(), new Map())).toEqual([]);
    const sync = ok(await syncAgentEvents({ runId: created.id, afterSeq: 0 }));
    expect(sync.events.map((event) => event.payload.kind)).toEqual(["user", "status"]);
    expect(sync.run.status).toBe("stopped");
  });

  it("a stop asked while the agent waits on a gate winds the run down as stopped", async () => {
    const upload = await uploadZip("quick.zip", QUICK);
    const created = ok(await createAgentRun({ skillId: upload.body.id, projectId, title: "Stop me", brief: "Go.", attachmentAssetIds: [] }));
    const active: ActiveRuns = new Map();
    await workerTick(await loopDeps(), active);
    await watch(created.id, (events) => kind(events, "question").length > 0);
    expect(ok(await stopAgentRun(created.id)).status).toBe("stopping");
    await active.get(created.id);
    const ended = await watch(created.id, (_, run) => run.status === "stopped");
    expect(kind(ended.events, "status").map((event) => event.payload.status).slice(-2)).toEqual(["stopping", "stopped"]);
    expect(await stopAgentRun(created.id)).toEqual({ ok: false, error: "The run has ended" });
  });
});
