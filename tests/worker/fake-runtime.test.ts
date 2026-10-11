import { strToU8, zipSync } from "fflate";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AgentEventPayload } from "@/server/agents-contract";

import { createLogger } from "../../worker/log";
import { Masker } from "../../worker/mask";
import { runAgent, type RunDeps } from "../../worker/run";
import { FAKE_APPROVAL_ID, FAKE_COST_USD, FAKE_CREDITS, FAKE_QUESTION_ID, FakeRuntime } from "../../worker/runtimes/fake";
import { MemoryMedia, MemoryWorkerStore, memoryReader, runRecord, skillRecord, until } from "./doubles";

/* The whole loop for one run, with the scripted agent and in-memory doubles
   for the store and the media store: claim, install, workspace, events,
   a question answered through the inbox, an approval, artifacts, done. */

const KIE_KEY = "kie-0123456789abcdef";
const QUESTION = "Which direction should the first batch take?";

let root: string;
let media: MemoryMedia;
let store: MemoryWorkerStore;
let lines: string[];
let shutdown: AbortController;

function zipOf(files: Record<string, string>): Uint8Array {
  return zipSync(Object.fromEntries(Object.entries(files).map(([name, body]) => [name, strToU8(body)])));
}

async function seed(over: Partial<Parameters<typeof runRecord>[0]> = {}) {
  const skill = skillRecord();
  await media.put(skill.storageKey, zipOf({ "SKILL.md": "---\nname: Drama Ad Machine\ndescription: Makes ads.\n---\n", "scripts/kie.py": "print(1)\n" }), "application/zip");
  await media.put("t/team-1/u/2026/10/ref.png", new Uint8Array([1, 2, 3, 4]), "image/png");
  const run = runRecord(over);
  store.seed(run, skill, [{ name: "ref.png", url: media.publicUrl("t/team-1/u/2026/10/ref.png") }]);
  return run;
}

function deps(over: Partial<RunDeps> = {}): RunDeps {
  return {
    store,
    media,
    objects: memoryReader(media),
    runtime: new FakeRuntime(),
    homeRoot: root,
    workerId: "w1",
    credentials: async () => ({ KIE_API_KEY: KIE_KEY }),
    processEnv: { PATH: "/usr/bin", DATABASE_URL: "postgres://user:pw@db/x", HF_KEY: "hf_abcdefghijklmnop" },
    signal: shutdown.signal,
    log: createLogger(new Masker({ KIE_API_KEY: KIE_KEY, HF_KEY: "hf_abcdefghijklmnop" }), { level: "debug", sink: (line) => lines.push(line) }),
    leaseRenewMs: 50,
    inboxPollMs: 10,
    ...over,
  };
}

function kinds(runId: string): string[] {
  return store.payloads(runId).map((payload) => (payload.kind === "status" ? `status:${payload.status}` : payload.kind));
}

function find<K extends AgentEventPayload["kind"]>(runId: string, kind: K): Extract<AgentEventPayload, { kind: K }>[] {
  return store.payloads(runId).filter((payload): payload is Extract<AgentEventPayload, { kind: K }> => payload.kind === kind);
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "ohf-worker-"));
  media = new MemoryMedia();
  store = new MemoryWorkerStore();
  lines = [];
  shutdown = new AbortController();
});

afterEach(async () => {
  shutdown.abort();
  await rm(root, { recursive: true, force: true });
});

describe("runAgent with the fake runtime", () => {
  it("walks the script: question, approval, artifacts, publish, done", async () => {
    const run = await seed();
    const claimed = (await store.claimRun("w1"))!;
    const ending = runAgent(claimed, deps());

    await until(() => find(run.id, "question").length === 1);
    expect(store.statusOf(run.id)).toBe("waiting");
    expect(find(run.id, "question")[0]).toMatchObject({ questionId: FAKE_QUESTION_ID, answers: null, questions: [{ question: QUESTION, options: [{ label: "Go wide" }, { label: "Go deep" }] }] });

    await store.pushInput(run.id, { kind: "answer", questionId: FAKE_QUESTION_ID, answers: { [QUESTION]: "Go deep" } }, "Bob");
    await until(() => find(run.id, "approval").length === 1);
    expect(find(run.id, "question")[0]).toMatchObject({ answers: { [QUESTION]: "Go deep" }, answeredBy: "Bob" });
    expect(find(run.id, "approval")[0]).toMatchObject({ approvalId: FAKE_APPROVAL_ID, toolName: "Bash", command: expect.stringContaining("--confirm-paid"), reason: "runs a paid step (--confirm-paid)", decision: null });
    expect(store.statusOf(run.id)).toBe("waiting");

    await store.pushInput(run.id, { kind: "approval", approvalId: FAKE_APPROVAL_ID, decision: "approved" }, "Ada");
    expect(await ending).toEqual({ status: "done", error: null });

    expect(kinds(run.id)).toEqual([
      "user",
      "status:running",
      "text",
      "text",
      "tool_use",
      "tool_result",
      "question",
      "status:waiting",
      "status:running",
      "text",
      "tool_use",
      "approval",
      "status:waiting",
      "status:running",
      "tool_result",
      "artifact",
      "text",
      "artifact",
      "artifact",
      "result",
      "status:done",
    ]);
    expect(find(run.id, "approval")[0]).toMatchObject({ decision: "approved", decidedBy: "Ada" });
    expect(find(run.id, "text").map((text) => text.final)).toEqual([false, true, true, true]);
    expect(find(run.id, "text")[2]!.text).toContain("Go deep");
    expect(find(run.id, "artifact").map((artifact) => artifact.path)).toEqual(["outputs/board.png", "outputs/board.md", "outputs/plan.md"]);
    expect(find(run.id, "artifact")[0]).toMatchObject({ fileKind: "image", url: `https://media.test/t/team-1/agents/${run.id}/outputs/board.png` });
    expect(find(run.id, "result")[0]).toMatchObject({ subtype: "success", costUsd: FAKE_COST_USD, turns: 6, sessionId: `fake-${run.id}` });

    const after = store.run(run.id);
    expect(after).toMatchObject({ status: "done", credits: FAKE_CREDITS, sessionId: `fake-${run.id}`, error: null });
    expect(after.costUsd).toBeCloseTo(FAKE_COST_USD, 6);
    expect(after.endedAt).not.toBeNull();
    expect(after.workspace).toBe(path.join(root, "team-1", "runs", run.id));
    expect(store.published).toEqual([{ runId: run.id, artifactId: find(run.id, "artifact")[0]!.artifactId }]);
    expect([...media.objects.keys()].filter((key) => key.includes("/agents/")).sort()).toEqual([
      `t/team-1/agents/${run.id}/outputs/board.md`,
      `t/team-1/agents/${run.id}/outputs/board.png`,
      `t/team-1/agents/${run.id}/outputs/plan.md`,
    ]);
    expect(media.objects.get(`t/team-1/agents/${run.id}/outputs/board.png`)!.bytes.subarray(0, 4)).toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));

    /* The team's HOME and the workspace are laid out as the skill expects. */
    const home = path.join(root, "team-1");
    expect(await readFile(path.join(home, ".claude", "skills", "drama-ad-machine", "SKILL.md"), "utf8")).toContain("Drama Ad Machine");
    expect(await readFile(path.join(after.workspace!, "inputs", "ref.png"))).toEqual(Buffer.from([1, 2, 3, 4]));
    expect((await stat(path.join(after.workspace!, ".env"))).mode & 0o777).toBe(0o600);
    expect(await readFile(path.join(after.workspace!, ".env"), "utf8")).toBe(`HF_KEY="hf_abcdefghijklmnop"\nKIE_API_KEY="${KIE_KEY}"\n`);

    /* Nothing that left the worker carries a key. */
    expect(JSON.stringify(store.payloads(run.id))).not.toContain(KIE_KEY);
    expect(lines.join("\n")).not.toContain(KIE_KEY);
    expect(lines.join("\n")).not.toContain("hf_abcdefghijklmnop");
    expect(lines.some((line) => line.includes('"msg":"run ended"') && line.includes('"status":"done"'))).toBe(true);
  });

  it("a declined approval spends nothing and still ends done", async () => {
    const run = await seed();
    const ending = runAgent((await store.claimRun("w1"))!, deps());
    await until(() => find(run.id, "question").length === 1);
    await store.pushInput(run.id, { kind: "answer", questionId: FAKE_QUESTION_ID, answers: { [QUESTION]: "Go wide" } });
    await until(() => find(run.id, "approval").length === 1);
    await store.pushInput(run.id, { kind: "approval", approvalId: FAKE_APPROVAL_ID, decision: "denied" });
    expect(await ending).toEqual({ status: "done", error: null });
    expect(find(run.id, "tool_result")[1]).toMatchObject({ isError: true, output: "Declined in the studio" });
    expect(find(run.id, "artifact").map((artifact) => artifact.path)).toEqual(["outputs/plan.md"]);
    expect(store.published).toEqual([]);
    expect(store.run(run.id).credits).toBe(0);
  });

  it("a stop at a gate ends the run as stopped", async () => {
    const run = await seed();
    const ending = runAgent((await store.claimRun("w1"))!, deps());
    await until(() => find(run.id, "question").length === 1);
    await store.pushInput(run.id, { kind: "stop" }, "Ada");
    expect(await ending).toEqual({ status: "stopped", error: null });
    /* The plan the agent wrote before the stop is still kept. */
    expect(kinds(run.id).slice(-3)).toEqual(["status:stopping", "artifact", "status:stopped"]);
    expect(find(run.id, "artifact").map((artifact) => artifact.path)).toEqual(["outputs/plan.md"]);
    expect(store.run(run.id).status).toBe("stopped");
  });

  it("a worker shutdown hands the run back to the queue with its session", async () => {
    const run = await seed();
    const ending = runAgent((await store.claimRun("w1"))!, deps());
    await until(() => find(run.id, "question").length === 1);
    shutdown.abort();
    expect(await ending).toEqual({ status: "released" });
    expect(find(run.id, "status").at(-1)).toEqual({ kind: "status", status: "queued", reason: "worker stopping" });
    expect(store.run(run.id).status).toBe("queued");
    expect(store.run(run.id).endedAt).toBeNull();
  });

  it("a lost lease drops the run without another word", async () => {
    const run = await seed();
    store.renewAnswer = false;
    const ending = runAgent((await store.claimRun("w1"))!, deps({ leaseRenewMs: 20 }));
    await until(() => find(run.id, "question").length === 1);
    expect(await ending).toEqual({ status: "lost" });
    expect(kinds(run.id).at(-1)).toBe("status:waiting");
    expect(lines.some((line) => line.includes("lease lost"))).toBe(true);
  });

  it("a run whose skill is gone fails with the reason on the run", async () => {
    const run = await seed({ skillId: "missing" });
    expect(await runAgent((await store.claimRun("w1"))!, deps())).toEqual({ status: "failed", error: "The run's skill is no longer in the library" });
    expect(kinds(run.id)).toEqual(["user", "status:running", "error", "status:failed"]);
    expect(store.run(run.id)).toMatchObject({ status: "failed", error: "The run's skill is no longer in the library" });
  });

  it("a run picked up with a session waits for a message, then continues", async () => {
    const run = await seed({ sessionId: "fake-run-1" });
    const ending = runAgent((await store.claimRun("w1"))!, deps());
    await until(() => find(run.id, "status").some((status) => status.reason?.startsWith("resumed")));
    expect(store.statusOf(run.id)).toBe("waiting");
    await store.pushInput(run.id, { kind: "message", text: "Carry on with the deep angle", attachments: [] }, "Ada");
    expect(await ending).toEqual({ status: "done", error: null });
    expect(kinds(run.id)).toEqual(["user", "status:running", "status:waiting", "user", "status:running", "text", "result", "status:done"]);
    expect(find(run.id, "text")[0]!.text).toContain("deep angle");
  });

  it("a run picked up with a session takes the answer to a card the dead session left open as its next word", async () => {
    const run = await seed({ sessionId: "fake-run-1" });
    const ending = runAgent((await store.claimRun("w1"))!, deps());
    await until(() => find(run.id, "status").some((status) => status.reason?.startsWith("resumed")));
    await store.pushInput(run.id, { kind: "answer", questionId: FAKE_QUESTION_ID, answers: { [QUESTION]: "Go deep" } }, "Ada");
    expect(await ending).toEqual({ status: "done", error: null });
    expect(find(run.id, "text")[0]!.text).toContain("the team settled: Go deep");
  });

  it("a run reclaimed by another worker is dropped at the next poll, and nothing more is written", async () => {
    const run = await seed();
    const ending = runAgent((await store.claimRun("w1"))!, deps({ leaseRenewMs: 60_000 }));
    await until(() => find(run.id, "question").length === 1);
    const written = store.eventsOf(run.id).length;
    store.leases.set(run.id, "w2");
    expect(await ending).toEqual({ status: "lost" });
    expect(store.eventsOf(run.id)).toHaveLength(written);
    expect(store.statusOf(run.id)).toBe("waiting");
    expect(lines.some((line) => line.includes("lease lost"))).toBe(true);
  });
});
