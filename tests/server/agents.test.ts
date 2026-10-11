import { strToU8, unzipSync, zipSync } from "fflate";
import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { envForTests, resetStubs, seedTeam, useMemoryStore, useTestDatabase, type MemoryStore, type TestDb } from "./harness";

import {
  answerAgentQuestion,
  createAgentRun,
  decideAgentApproval,
  getAgentRun,
  listAgentArtifacts,
  listAgentRuns,
  publishAgentArtifact,
  sendAgentMessage,
  stopAgentRun,
  syncAgentEvents,
} from "@/server/agent-actions";
import {
  RUN_LEASE_MS,
  addCredits,
  appendEvent,
  claimRun,
  createRun,
  finishRun,
  getRun,
  getRunById,
  getSkill,
  installSkillFromZip,
  listArtifacts,
  listEvents,
  listGates,
  listRuns,
  listSkills,
  publishArtifact,
  pushInput,
  reclaimStale,
  recordArtifact,
  removeSkill,
  renewLease,
  runAttachments,
  runPlace,
  setRunWorkspace,
  settleApproval,
  settleQuestion,
  takeInputs,
} from "@/server/agents";
import { EVENTS_PAGE, LeaseLostError, TOOL_OUTPUT_MAX_CHARS, type AgentEventPayload, type Question } from "@/server/agents-contract";
import * as schema from "@/server/db/schema";
import { listResults } from "@/server/gallery";
import { ensureDefaultProject } from "@/server/runs";
import { deleteSkill, listSkills as listSkillsAction } from "@/server/skill-actions";
import { requireTeam, type TeamContext } from "@/server/team";

/* The actions read the session through next/headers; here requireTeam is a
   mock that answers with the seeded team. The core takes the team directly,
   and the worker-facing half takes a run id, as the worker would. */
vi.mock("@/server/team", () => ({ requireTeam: vi.fn() }));

/* Every test boots its own PGlite, which takes a moment more than the default
   budget allows. */
vi.setConfig({ testTimeout: 30_000 });

let db: TestDb;
let store: MemoryStore;
let team: TeamContext;
let projectId: string;

const SKILL_MD = (name: string, extra = "") =>
  `---\nname: ${name}\ndescription: Makes ads for ${name}.\nmetadata:\n  version: "1.0"\n${extra}---\n# ${name}\n`;

function zipOf(files: Record<string, string>): Uint8Array {
  return zipSync(Object.fromEntries(Object.entries(files).map(([path, body]) => [path, strToU8(body)])));
}

async function installSkill(owner: TeamContext, name = "Drama Ad Machine", extra: Record<string, string> = {}) {
  return installSkillFromZip(owner, {
    bytes: zipOf({ "SKILL.md": SKILL_MD(name), "engine/kie.py": "print(1)\n", "agents/sd2-qc.md": "---\nname: sd2-qc-inspector\n---\n", ...extra }),
    fileName: `${name}.zip`,
    createdBy: owner.userId,
  });
}

async function seedAsset(owner: TeamContext, name = "ref.png") {
  const id = randomUUID();
  const key = `t/${owner.teamId}/u/2026/10/${id}.png`;
  await db.insert(schema.assets).values({
    id,
    teamId: owner.teamId,
    userId: owner.userId,
    source: "upload",
    kind: "image",
    name,
    mime: "image/png",
    bytes: 4,
    key,
    url: store.publicUrl(key),
    status: "ready",
  });
  return { id, name, url: store.publicUrl(key) };
}

async function startRun(owner = team, over: Partial<Parameters<typeof createRun>[1]> = {}) {
  const skill = await installSkill(owner);
  return createRun(owner, { skillId: skill.id, projectId, title: "Hook test", brief: "Make three hooks.", attachmentAssetIds: [], ...over });
}

function question(id: string): AgentEventPayload {
  const asked: Question = { question: "Which angle?", header: "Angle", options: [{ label: "Pain", description: "" }, { label: "Dream", description: "" }], multiSelect: false };
  return { kind: "question", questionId: id, questions: [asked], answers: null, answeredBy: null };
}

function approval(id: string): AgentEventPayload {
  return { kind: "approval", approvalId: id, toolName: "Bash", command: "python3 scripts/kie.py watch --confirm-paid", reason: "paid", decision: null, decidedBy: null };
}

async function loadRun(id: string) {
  const row = await db.query.agentRuns.findFirst({ where: eq(schema.agentRuns.id, id) });
  if (!row) throw new Error(`run ${id} is not in the table`);
  return row;
}

function eventsOf(runId: string) {
  return db.query.agentEvents.findMany({ where: eq(schema.agentEvents.runId, runId), orderBy: asc(schema.agentEvents.seq) });
}

function jobsOf(type: string) {
  return db.query.jobs.findMany({ where: eq(schema.jobs.type, type), orderBy: asc(schema.jobs.createdAt) });
}

beforeEach(async () => {
  envForTests();
  db = await useTestDatabase();
  store = useMemoryStore({ public: true });
  team = await seedTeam(db, { name: "Ada" });
  vi.mocked(requireTeam).mockReset();
  vi.mocked(requireTeam).mockResolvedValue(team);
  projectId = (await ensureDefaultProject(team)).project.id;
});

afterEach(() => resetStubs());

/* ---------- skills ---------- */

describe("installSkillFromZip", () => {
  it("stores the normalised zip under the team and writes the record", async () => {
    const skill = await installSkill(team);
    expect(skill).toMatchObject({
      teamId: team.teamId,
      name: "Drama Ad Machine",
      slug: "drama-ad-machine",
      description: "Makes ads for Drama Ad Machine.",
      version: "1.0",
      compatibility: null,
      agents: ["sd2-qc-inspector"],
      files: 3,
      status: "ready",
      problems: [],
      createdBy: team.userId,
    });
    expect(skill.storageKey).toMatch(new RegExp(`^t/${team.teamId}/skills/${skill.id}\\.[0-9a-f]{12}\\.zip$`));
    const stored = store.objects.get(skill.storageKey);
    expect(stored?.contentType).toBe("application/zip");
    expect(Object.keys(unzipSync(stored!.bytes)).sort()).toEqual(["SKILL.md", "agents/sd2-qc.md", "engine/kie.py"]);
    expect(await listSkills(team)).toEqual([skill]);
  });

  it("re-uploading a slug keeps the id and runs, stores a new key and purges the old one", async () => {
    const first = await installSkill(team);
    const run = await createRun(team, { skillId: first.id, projectId, title: "t", brief: "b", attachmentAssetIds: [] });
    const second = await installSkill(team, "Drama Ad Machine", { "engine/new.py": "print(2)\n" });
    expect(second.id).toBe(first.id);
    expect(second.files).toBe(4);
    expect(second.storageKey).not.toBe(first.storageKey);
    expect(await listSkills(team)).toHaveLength(1);
    expect((await getRun(team, run.id)).skillId).toBe(first.id);
    expect((await jobsOf("purge_media")).map((job) => job.dedupeKey)).toEqual([first.storageKey]);
  });

  it("keeps a refused bundle as invalid with its problems, storing nothing", async () => {
    const skill = await installSkillFromZip(team, { bytes: zipOf({ "SKILL.md": "# no frontmatter\n" }), fileName: "Broken Thing.zip", createdBy: team.userId });
    expect(skill).toMatchObject({
      name: "Broken Thing",
      slug: "broken-thing",
      status: "invalid",
      storageKey: "",
      problems: ["SKILL.md has no `name` in its frontmatter", "SKILL.md has no `description` in its frontmatter"],
    });
    expect(store.objects.size).toBe(0);
    expect((await listSkills(team)).map((s) => s.status)).toEqual(["invalid"]);
    /* A fixed upload of the same slug replaces the invalid row. */
    const fixed = await installSkill(team, "Broken Thing");
    expect(fixed).toMatchObject({ id: skill.id, status: "ready", problems: [] });
  });

  it("never lets a refused bundle displace a working skill of the same slug", async () => {
    const good = await installSkill(team);
    await expect(
      installSkillFromZip(team, { bytes: zipOf({ "SKILL.md": "---\nname: Drama Ad Machine\n---\n" }), fileName: "x.zip", createdBy: team.userId }),
    ).rejects.toThrow('The bundle was refused and "Drama Ad Machine" stays as it was: SKILL.md has no `description` in its frontmatter');
    expect(await listSkills(team)).toEqual([good]);
  });

  it("refuses an unsafe bundle, and a run of an invalid skill", async () => {
    const bad = await installSkillFromZip(team, { bytes: zipOf({ "SKILL.md": SKILL_MD("Evil"), "../escape": "x" }), fileName: "evil.zip", createdBy: null });
    expect(bad.status).toBe("invalid");
    expect(bad.problems).toEqual(['Unsafe path: "../escape"']);
    await expect(createRun(team, { skillId: bad.id, projectId, title: "t", brief: "b", attachmentAssetIds: [] })).rejects.toThrow(
      "That skill was refused; upload a fixed bundle first",
    );
  });
});

describe("listSkills and removeSkill", () => {
  it("lists only the team's skills, by name", async () => {
    await installSkill(team, "Zeta");
    await installSkill(team, "Alpha");
    const other = await seedTeam(db, { name: "Other" });
    await installSkill(other, "Theirs");
    expect((await listSkills(team)).map((s) => s.name)).toEqual(["Alpha", "Zeta"]);
    expect((await listSkills(other)).map((s) => s.name)).toEqual(["Theirs"]);
  });

  it("refuses to remove a skill while a run of it is open, removes it after, and the run keeps the name", async () => {
    const run = await startRun();
    await expect(removeSkill(team, run.skillId)).rejects.toThrow("A run of this skill is still open; stop it first");
    await finishRun(run.id, "done");
    const key = (await listSkills(team))[0]!.storageKey;
    expect(await removeSkill(team, run.skillId)).toBeNull();
    expect(await listSkills(team)).toEqual([]);
    expect((await jobsOf("purge_media")).map((job) => job.dedupeKey)).toEqual([key]);
    expect(await getRun(team, run.id)).toMatchObject({ skillId: "", skillName: "Drama Ad Machine", skillSlug: "drama-ad-machine" });
    const other = await seedTeam(db);
    await expect(removeSkill(other, run.skillId)).rejects.toThrow("No such skill");
  });

  it("the actions: any member lists, admins delete", async () => {
    const skill = await installSkill(team);
    expect(await listSkillsAction()).toEqual({ ok: true, data: [skill] });
    expect(await deleteSkill({ id: skill.id })).toEqual({ ok: true, data: null });
    expect(vi.mocked(requireTeam)).toHaveBeenLastCalledWith({ role: ["owner", "admin"] });
    vi.mocked(requireTeam).mockRejectedValue(Object.assign(new Error("Your role does not allow that"), { name: "ForbiddenError" }));
    expect(await deleteSkill({ id: skill.id })).toEqual({ ok: false, error: "Your role does not allow that", code: "forbidden" });
  });
});

/* ---------- runs ---------- */

describe("createRun", () => {
  it("queues the run and opens the stream with the brief and the attachments", async () => {
    const ref = await seedAsset(team);
    const run = await startRun(team, { title: "  Hook test ", brief: " Make three hooks. ", attachmentAssetIds: [ref.id] });
    expect(run).toMatchObject({
      teamId: team.teamId,
      projectId,
      skillName: "Drama Ad Machine",
      skillSlug: "drama-ad-machine",
      title: "Hook test",
      brief: "Make three hooks.",
      status: "queued",
      sessionId: null,
      workspace: null,
      costUsd: 0,
      credits: 0,
      lastSeq: 1,
      error: null,
      createdBy: team.userId,
      createdByName: "Ada",
      startedAt: null,
      endedAt: null,
    });
    const [first] = await listEvents(team, run.id, 0);
    expect(first).toMatchObject({
      seq: 1,
      parentToolUseId: null,
      payload: { kind: "user", text: "Make three hooks.", userName: "Ada", attachments: [{ name: "ref.png", url: ref.url }] },
    });
    expect(await runAttachments(run.id)).toEqual([{ name: "ref.png", url: ref.url }]);
  });

  it("refuses another team's project or file, a missing skill and an empty title", async () => {
    const other = await seedTeam(db);
    const theirProject = (await ensureDefaultProject(other)).project.id;
    const theirAsset = await seedAsset(other);
    const skill = await installSkill(team);
    const base = { skillId: skill.id, projectId, title: "t", brief: "b", attachmentAssetIds: [] as string[] };
    await expect(createRun(team, { ...base, projectId: theirProject })).rejects.toThrow("No such project");
    await expect(createRun(team, { ...base, attachmentAssetIds: [theirAsset.id] })).rejects.toThrow("An attached file is not in this team");
    await expect(createRun(team, { ...base, skillId: randomUUID() })).rejects.toThrow("No such skill");
    await expect(createRun(team, { ...base, title: "  " })).rejects.toThrow("Give the run a title");
    await expect(createRun(team, { ...base, brief: "" })).rejects.toThrow("Tell the agent what to do");
    expect(await listRuns(team)).toEqual([]);
  });
});

describe("listRuns and getRun", () => {
  it("answers the team's runs newest first, narrowed by project, and never another team's", async () => {
    const skill = await installSkill(team);
    const a = await createRun(team, { skillId: skill.id, projectId, title: "A", brief: "b", attachmentAssetIds: [] });
    const otherProject = randomUUID();
    await db.insert(schema.projects).values({ id: otherProject, teamId: team.teamId, productId: (await loadRun(a.id)).productId, name: "P2", slug: "p2" });
    const b = await createRun(team, { skillId: skill.id, projectId: otherProject, title: "B", brief: "b", attachmentAssetIds: [] });
    await db.update(schema.agentRuns).set({ createdAt: new Date("2026-10-01T00:00:00Z") }).where(eq(schema.agentRuns.id, a.id));
    await db.update(schema.agentRuns).set({ createdAt: new Date("2026-10-02T00:00:00Z") }).where(eq(schema.agentRuns.id, b.id));

    expect((await listRuns(team)).map((r) => r.title)).toEqual(["B", "A"]);
    expect((await listRuns(team, { projectId })).map((r) => r.title)).toEqual(["A"]);
    expect(await getRun(team, a.id)).toMatchObject({ id: a.id, title: "A" });

    const other = await seedTeam(db);
    expect(await listRuns(other)).toEqual([]);
    await expect(getRun(other, a.id)).rejects.toThrow("No such run");
    await expect(listEvents(other, a.id, 0)).rejects.toThrow("No such run");
    expect(await getRunById(a.id)).toMatchObject({ id: a.id });
    expect(await getRunById(randomUUID())).toBeNull();
  });
});

/* ---------- events ---------- */

describe("appendEvent and listEvents", () => {
  it("numbers events from the run row, so seqs climb by one, and pages by afterSeq", async () => {
    const run = await startRun();
    const written = await Promise.all(
      Array.from({ length: 5 }, (_, i) => appendEvent(run.id, { kind: "text", text: `t${i}`, final: true }, i % 2 ? "tool-1" : null)),
    );
    expect(written.map((e) => e.seq).sort((a, b) => a - b)).toEqual([2, 3, 4, 5, 6]);
    expect(written.map((e) => e.runId)).toEqual(Array(5).fill(run.id));
    expect((await getRun(team, run.id)).lastSeq).toBe(6);

    const all = await listEvents(team, run.id, 0);
    expect(all.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(all.slice(1).map((e) => e.parentToolUseId)).toEqual([null, "tool-1", null, "tool-1", null]);
    expect((await listEvents(team, run.id, 4)).map((e) => e.seq)).toEqual([5, 6]);
    expect((await listEvents(team, run.id, 2, 2)).map((e) => e.seq)).toEqual([3, 4]);
    expect((await listEvents(team, run.id, 6)).map((e) => e.seq)).toEqual([]);
    expect((await listEvents(team, run.id, 0, EVENTS_PAGE + 50)).length).toBe(6);
    await expect(appendEvent(randomUUID(), { kind: "text", text: "x", final: true })).rejects.toThrow("No such run");
  });

  it("a status event moves the run; a result event adds cost and keeps the session", async () => {
    const run = await startRun();
    const before = Date.now();
    await appendEvent(run.id, { kind: "status", status: "running", reason: null });
    let row = await loadRun(run.id);
    expect(row.status).toBe("running");
    expect(row.startedAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(row.endedAt).toBeNull();

    await appendEvent(run.id, { kind: "result", subtype: "success", costUsd: 0.0123, turns: 3, durationMs: 1000, sessionId: "sess-1" });
    await appendEvent(run.id, { kind: "result", subtype: "success", costUsd: 0.1, turns: 1, durationMs: 1000, sessionId: null });
    await appendEvent(run.id, { kind: "status", status: "waiting", reason: "asked a question" });
    const waiting = await getRun(team, run.id);
    expect(waiting).toMatchObject({ status: "waiting", costUsd: 0.1123, sessionId: "sess-1" });
    expect(waiting.updatedAt).toBeGreaterThanOrEqual(waiting.createdAt);

    await appendEvent(run.id, { kind: "status", status: "failed", reason: "the agent gave up" });
    row = await loadRun(run.id);
    expect(row).toMatchObject({ status: "failed", error: "the agent gave up", workerId: null, leaseUntil: null });
    expect(row.endedAt).not.toBeNull();
  });

  it("cuts a long tool result at the limit and says so", async () => {
    const run = await startRun();
    const event = await appendEvent(run.id, { kind: "tool_result", toolUseId: "t1", output: "x".repeat(TOOL_OUTPUT_MAX_CHARS + 10), isError: false, truncated: false });
    expect(event.payload).toMatchObject({ kind: "tool_result", truncated: true });
    expect((event.payload as { output: string }).output).toHaveLength(TOOL_OUTPUT_MAX_CHARS);
    const short = await appendEvent(run.id, { kind: "tool_result", toolUseId: "t2", output: "ok", isError: false, truncated: false });
    expect(short.payload).toMatchObject({ output: "ok", truncated: false });
  });
});

/* ---------- inputs ---------- */

describe("pushInput and takeInputs", () => {
  it("a message is an input and a line in the stream at once", async () => {
    const run = await startRun();
    const ref = await seedAsset(team, "board.png");
    const input = await pushInput(team, run.id, { kind: "message", text: "  Use the blue one. ", attachments: [{ assetId: ref.id, name: "", url: "" }] }, { id: team.userId, name: "Ada" });
    expect(input).toMatchObject({
      runId: run.id,
      createdBy: team.userId,
      createdByName: "Ada",
      consumedAt: null,
      payload: { kind: "message", text: "Use the blue one.", attachments: [{ assetId: ref.id, name: "board.png", url: ref.url }] },
    });
    const events = await listEvents(team, run.id, 1);
    expect(events.map((e) => e.payload)).toEqual([{ kind: "user", text: "Use the blue one.", userName: "Ada", attachments: [{ name: "board.png", url: ref.url }] }]);
    await expect(pushInput(team, run.id, { kind: "message", text: " ", attachments: [] }, { id: team.userId, name: "Ada" })).rejects.toThrow("Write something to send");
  });

  it("hands inputs to the worker once, oldest first, with who sent them", async () => {
    const run = await startRun();
    const ben = await seedTeam(db, { name: "Ben" });
    await pushInput(team, run.id, { kind: "message", text: "one", attachments: [] }, { id: team.userId, name: "Ada" });
    await pushInput(team, run.id, { kind: "message", text: "two", attachments: [] }, { id: ben.userId, name: "Ben" });
    await pushInput(team, run.id, { kind: "message", text: "ghost", attachments: [] }, { id: null, name: null });

    const taken = await takeInputs(run.id);
    expect(taken.map((i) => [(i.payload as { text: string }).text, i.createdByName])).toEqual([
      ["one", "Ada"],
      ["two", "Ben"],
      ["ghost", null],
    ]);
    expect(taken.every((i) => i.consumedAt !== null)).toBe(true);
    expect(await takeInputs(run.id)).toEqual([]);
    const rows = await db.query.agentInputs.findMany({ where: eq(schema.agentInputs.runId, run.id) });
    expect(rows.every((row) => row.consumedAt !== null)).toBe(true);
  });

  it("a stop on a queued run ends it here; on a running run it asks the worker", async () => {
    const queued = await startRun();
    await pushInput(team, queued.id, { kind: "stop" }, { id: team.userId, name: "Ada" });
    expect(await getRun(team, queued.id)).toMatchObject({ status: "stopped", error: "Stopped by Ada" });
    expect((await eventsOf(queued.id)).map((e) => e.payload)).toEqual([
      expect.objectContaining({ kind: "user" }),
      { kind: "status", status: "stopped", reason: "Stopped by Ada" },
    ]);
    expect(await takeInputs(queued.id)).toEqual([]);
    await expect(pushInput(team, queued.id, { kind: "message", text: "hi", attachments: [] }, { id: team.userId, name: "Ada" })).rejects.toThrow("The run has ended");

    const running = await startRun();
    await claimRun("w1");
    await pushInput(team, running.id, { kind: "stop" }, { id: team.userId, name: "Ada" });
    expect((await getRun(team, running.id)).status).toBe("stopping");
    expect((await eventsOf(running.id)).at(-1)!.payload).toEqual({ kind: "status", status: "stopping", reason: "Stop asked by Ada" });
    expect((await takeInputs(running.id)).map((i) => i.payload)).toEqual([{ kind: "stop" }]);
    expect(await renewLease(running.id, "w1")).toBe(true);
  });

  it("an answer settles the question at once, and the first answer stands", async () => {
    const run = await startRun();
    const asked = await appendEvent(run.id, question("q1"));
    const answers = { "Which angle?": "Pain" };
    const input = await pushInput(team, run.id, { kind: "answer", questionId: "q1", answers }, { id: team.userId, name: "Ada" });
    expect(input.payload).toEqual({ kind: "answer", questionId: "q1", answers });
    const [settled] = await listEvents(team, run.id, asked.seq - 1, 1);
    expect(settled!.payload).toMatchObject({ kind: "question", questionId: "q1", answers, answeredBy: "Ada" });
    expect(await listGates(team, run.id)).toEqual([settled]);

    await expect(pushInput(team, run.id, { kind: "answer", questionId: "q1", answers: { "Which angle?": "Dream" } }, { id: null, name: "Ben" })).rejects.toThrow("Already answered by Ada");
    await expect(pushInput(team, run.id, { kind: "answer", questionId: "nope", answers }, { id: null, name: "Ben" })).rejects.toThrow("No such question");
    expect((await takeInputs(run.id)).map((i) => i.payload.kind)).toEqual(["answer"]);
    /* The worker's own settle finds it done and hands it back unchanged. */
    expect((await settleQuestion(run.id, "q1", { "Which angle?": "Dream" }, "worker"))!.payload).toMatchObject({ answers, answeredBy: "Ada" });
    expect(await settleQuestion(run.id, "nope", answers, null)).toBeNull();
  });

  it("a decision settles the approval at once, and the first decision stands", async () => {
    const run = await startRun();
    await appendEvent(run.id, { kind: "text", text: "about to spend", final: true });
    const held = await appendEvent(run.id, approval("a1"));
    await pushInput(team, run.id, { kind: "approval", approvalId: "a1", decision: "denied" }, { id: team.userId, name: "Ada" });
    const [settled] = await listEvents(team, run.id, held.seq - 1, 1);
    expect(settled!.payload).toMatchObject({ kind: "approval", approvalId: "a1", decision: "denied", decidedBy: "Ada" });
    await expect(pushInput(team, run.id, { kind: "approval", approvalId: "a1", decision: "approved" }, { id: null, name: "Ben" })).rejects.toThrow("Already decided by Ada");
    expect((await settleApproval(run.id, "a1", "approved", "Ben"))!.payload).toMatchObject({ decision: "denied", decidedBy: "Ada" });
    expect(await settleApproval(run.id, "zzz", "approved", null)).toBeNull();
    /* Gates come back oldest first, questions and approvals alike. */
    await appendEvent(run.id, question("q2"));
    expect((await listGates(team, run.id)).map((e) => e.payload.kind)).toEqual(["approval", "question"]);
  });

  it("refuses another team, and refuses files from another team", async () => {
    const run = await startRun();
    const other = await seedTeam(db);
    const theirs = await seedAsset(other);
    await expect(pushInput(other, run.id, { kind: "stop" }, { id: other.userId, name: "X" })).rejects.toThrow("No such run");
    await expect(
      pushInput(team, run.id, { kind: "message", text: "x", attachments: [{ assetId: theirs.id, name: "", url: "" }] }, { id: team.userId, name: "Ada" }),
    ).rejects.toThrow("An attached file is not in this team");
  });
});

/* ---------- claim, lease, reclaim, finish ---------- */

describe("claimRun, renewLease, reclaimStale and finishRun", () => {
  it("leases the oldest queued run to one worker, writes the status line, and refuses a second claim", async () => {
    const first = await startRun();
    const second = await startRun(team, { title: "Second" });
    await db.update(schema.agentRuns).set({ createdAt: new Date(Date.now() - 60_000) }).where(eq(schema.agentRuns.id, first.id));
    const before = Date.now();

    const claimed = await claimRun("w1");
    expect(claimed).toMatchObject({ id: first.id, status: "running", lastSeq: 2 });
    expect(claimed!.startedAt).toBeGreaterThanOrEqual(before - 1000);
    const row = await loadRun(first.id);
    expect(row.workerId).toBe("w1");
    expect(row.leaseUntil!.getTime()).toBeGreaterThanOrEqual(before + RUN_LEASE_MS - 5000);
    expect(row.leaseUntil!.getTime()).toBeLessThanOrEqual(before + RUN_LEASE_MS + 5000);
    expect((await eventsOf(first.id)).at(-1)!.payload).toEqual({ kind: "status", status: "running", reason: "A worker picked the run up" });

    expect((await claimRun("w2"))!.id).toBe(second.id);
    expect(await claimRun("w3")).toBeNull();
  });

  it("renews only for the worker that holds the run, while it is open", async () => {
    const run = await startRun();
    await claimRun("w1");
    const held = (await loadRun(run.id)).leaseUntil!.getTime();
    await db.update(schema.agentRuns).set({ leaseUntil: new Date(held - 30_000) }).where(eq(schema.agentRuns.id, run.id));
    expect(await renewLease(run.id, "w2")).toBe(false);
    expect(await renewLease(run.id, "w1")).toBe(true);
    expect((await loadRun(run.id)).leaseUntil!.getTime()).toBeGreaterThanOrEqual(held - 1000);
    await finishRun(run.id, "done");
    expect(await renewLease(run.id, "w1")).toBe(false);
  });

  it("puts a run whose lease ran out back in the queue with a 'worker lost' line, and ends one that was stopping", async () => {
    const lost = await startRun();
    const live = await startRun(team, { title: "Live" });
    const stopping = await startRun(team, { title: "Stopping" });
    await claimRun("w1");
    await claimRun("w1");
    await claimRun("w1");
    await pushInput(team, stopping.id, { kind: "stop" }, { id: team.userId, name: "Ada" });
    const past = new Date(Date.now() - 1000);
    await db.update(schema.agentRuns).set({ leaseUntil: past }).where(eq(schema.agentRuns.id, lost.id));
    await db.update(schema.agentRuns).set({ leaseUntil: past }).where(eq(schema.agentRuns.id, stopping.id));

    expect((await reclaimStale()).sort()).toEqual([lost.id, stopping.id].sort());
    expect(await loadRun(lost.id)).toMatchObject({ status: "queued", workerId: null, leaseUntil: null });
    expect((await eventsOf(lost.id)).at(-1)!.payload).toEqual({ kind: "status", status: "queued", reason: "worker lost" });
    expect(await loadRun(stopping.id)).toMatchObject({ status: "stopped", error: "worker lost", workerId: null });
    expect((await loadRun(live.id)).status).toBe("running");
    expect(await reclaimStale()).toEqual([]);
    /* And it is claimable again, by anyone. */
    expect((await claimRun("w2"))!.id).toBe(lost.id);
  });

  it("ends a run once, from any open state, and clears the lease", async () => {
    const run = await startRun();
    await claimRun("w1");
    const ended = await finishRun(run.id, "failed", "python3 exited 1");
    expect(ended).toMatchObject({ status: "failed", error: "python3 exited 1" });
    expect(ended!.endedAt).not.toBeNull();
    expect(await loadRun(run.id)).toMatchObject({ workerId: null, leaseUntil: null });
    expect((await eventsOf(run.id)).at(-1)!.payload).toEqual({ kind: "status", status: "failed", reason: "python3 exited 1" });
    expect(await finishRun(run.id, "done")).toBeNull();
    expect((await getRun(team, run.id)).status).toBe("failed");
    expect(await finishRun(randomUUID(), "done")).toBeNull();
  });

  it("fences a worker's writes by its lease: another worker's name, or a reclaimed run, is LeaseLostError", async () => {
    const run = await startRun();
    await claimRun("w1");
    const draft = { path: "outputs/a.png", fileKind: "image" as const, storageKey: "t/x/a.png", url: "https://media.test/t/x/a.png", sizeBytes: 3 };

    /* The holder writes; anyone else is refused, and the stream is untouched by the refusal. */
    await appendEvent(run.id, { kind: "text", text: "mine", final: true }, null, "w1");
    await expect(appendEvent(run.id, { kind: "text", text: "theirs", final: true }, null, "w2")).rejects.toBeInstanceOf(LeaseLostError);
    await expect(recordArtifact(run.id, draft, "w2")).rejects.toBeInstanceOf(LeaseLostError);
    await expect(finishRun(run.id, "done", null, "w2")).rejects.toBeInstanceOf(LeaseLostError);
    await pushInput(team, run.id, { kind: "message", text: "hello", attachments: [] }, { id: team.userId, name: "Ada" });
    await expect(takeInputs(run.id, "w2")).rejects.toBeInstanceOf(LeaseLostError);
    expect((await takeInputs(run.id, "w1")).map((input) => input.payload.kind)).toEqual(["message"]);
    expect(await takeInputs(run.id, "w1")).toEqual([]);
    /* The studio's own writes name no worker and always land. */
    await appendEvent(run.id, { kind: "text", text: "a note from the studio", final: true });
    expect((await eventsOf(run.id)).map((event) => event.payload.kind)).toEqual(["user", "status", "text", "user", "text"]);

    /* Reclaimed, back in the queue: the old worker's next write, poll or finish says so; a run that is gone is still "No such run". */
    await db.update(schema.agentRuns).set({ leaseUntil: new Date(Date.now() - 1000) }).where(eq(schema.agentRuns.id, run.id));
    await reclaimStale();
    expect((await loadRun(run.id)).status).toBe("queued");
    await expect(appendEvent(run.id, { kind: "text", text: "late", final: true }, null, "w1")).rejects.toBeInstanceOf(LeaseLostError);
    await expect(takeInputs(run.id, "w1")).rejects.toBeInstanceOf(LeaseLostError);
    await expect(finishRun(run.id, "done", null, "w1")).rejects.toBeInstanceOf(LeaseLostError);
    await expect(appendEvent(randomUUID(), { kind: "text", text: "x", final: true }, null, "w1")).rejects.toThrow("No such run");
    /* Ended for good (a stop on the queued run): the old worker's finish is the usual no-op, and its poll is quiet. */
    await pushInput(team, run.id, { kind: "stop" }, { id: team.userId, name: "Ada" });
    expect((await loadRun(run.id)).status).toBe("stopped");
    await expect(finishRun(run.id, "done", null, "w1")).resolves.toBeNull();
    expect(await takeInputs(run.id, "w1")).toEqual([]);
  });

  it("keeps a stopping run stopping through the worker's running and waiting lines, until the terminal one", async () => {
    const run = await startRun();
    await claimRun("w1");
    await pushInput(team, run.id, { kind: "stop" }, { id: team.userId, name: "Ada" });
    expect((await loadRun(run.id)).status).toBe("stopping");
    await appendEvent(run.id, { kind: "status", status: "running", reason: null }, null, "w1");
    expect((await loadRun(run.id)).status).toBe("stopping");
    await appendEvent(run.id, { kind: "status", status: "waiting", reason: null }, null, "w1");
    expect((await loadRun(run.id)).status).toBe("stopping");
    await finishRun(run.id, "stopped", null, "w1");
    expect((await loadRun(run.id)).status).toBe("stopped");
  });
});

/* ---------- artifacts and the wall ---------- */

describe("recordArtifact, listArtifacts and publishArtifact", () => {
  const file = (runId: string, path: string, over: Record<string, unknown> = {}) => ({
    path,
    fileKind: "image" as const,
    storageKey: `t/team/agents/${runId}/${path}`,
    url: `https://media.test/t/team/agents/${runId}/${path}`,
    sizeBytes: 1234,
    ...over,
  });

  it("records a file by path, replaces it in place, and writes the artifact line", async () => {
    const run = await startRun();
    const first = await recordArtifact(run.id, file(run.id, "outputs/board.png", { width: 1024, height: 768 }));
    expect(first).toMatchObject({ runId: run.id, teamId: team.teamId, path: "outputs/board.png", fileKind: "image", sizeBytes: 1234, resultId: null });
    const again = await recordArtifact(run.id, file(run.id, "outputs/board.png", { sizeBytes: 999 }));
    expect(again.id).toBe(first.id);
    expect(again.sizeBytes).toBe(999);
    await recordArtifact(run.id, file(run.id, "outputs/plan.md", { fileKind: "document" }));
    expect((await listArtifacts(team, run.id)).map((a) => [a.path, a.sizeBytes])).toEqual([
      ["outputs/board.png", 999],
      ["outputs/plan.md", 1234],
    ]);
    const lines = (await eventsOf(run.id)).slice(1).map((e) => e.payload);
    expect(lines).toEqual([
      { kind: "artifact", artifactId: first.id, path: "outputs/board.png", fileKind: "image", url: first.url, sizeBytes: 1234 },
      { kind: "artifact", artifactId: first.id, path: "outputs/board.png", fileKind: "image", url: first.url, sizeBytes: 999 },
      expect.objectContaining({ kind: "artifact", path: "outputs/plan.md", fileKind: "document" }),
    ]);
    await expect(recordArtifact(randomUUID(), file("x", "a.png"))).rejects.toThrow("No such run");
    const other = await seedTeam(db);
    await expect(listArtifacts(other, run.id)).rejects.toThrow("No such run");
  });

  it("publishes an image as a finished, mirrored tile the gallery lists, once", async () => {
    const run = await startRun();
    const board = await recordArtifact(run.id, file(run.id, "outputs/board.png", { width: 1024, height: 768 }));
    const published = await publishArtifact(team, board.id, { id: team.userId, name: "Ada" });
    expect(published.resultId).toEqual(expect.any(String));

    const { items } = await listResults(team, { view: "image", projectId }, null);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: published.resultId,
      kind: "image",
      surface: "image",
      modelId: "agent:drama-ad-machine",
      modelLabel: "Drama Ad Machine",
      prompt: "outputs/board.png — Hook test",
      ratio: "1024 / 768",
      meta: "PNG · 1 KB",
      urls: [board.url],
      status: "completed",
      mirrored: true,
      userId: team.userId,
      userName: "Ada",
      projectId,
    });
    const tile = await db.query.results.findFirst({ where: eq(schema.results.id, published.resultId!), with: { run: true } });
    expect(tile).toMatchObject({ key: board.storageKey, url: board.url, bytes: 1234, mime: "image/png", width: 1024, height: 768 });
    expect(tile!.run).toMatchObject({ modelId: "agent:drama-ad-machine", kieModel: "agent:drama-ad-machine", status: "succeeded", idempotencyKey: `agent:${board.id}` });

    /* Twice is once. */
    expect(await publishArtifact(team, board.id, { id: team.userId, name: "Ada" })).toEqual(published);
    expect((await listResults(team, { view: "assets" }, null)).items).toHaveLength(1);
    expect((await listArtifacts(team, run.id))[0]!.resultId).toBe(published.resultId);
  });

  it("gives a video without known size a 16:9 tile, and keeps documents and other teams off the wall", async () => {
    const run = await startRun();
    const clip = await recordArtifact(run.id, file(run.id, "outputs/take-01.mp4", { fileKind: "video", sizeBytes: 5 * 1024 * 1024 }));
    const doc = await recordArtifact(run.id, file(run.id, "outputs/plan.md", { fileKind: "document" }));
    const published = await publishArtifact({ teamId: team.teamId }, clip.id, { id: run.createdBy, name: run.createdByName });
    const { items } = await listResults(team, { view: "video" }, null);
    expect(items[0]).toMatchObject({ id: published.resultId, kind: "video", ratio: "16 / 9", meta: "MP4 · 5.0 MB" });
    await expect(publishArtifact(team, doc.id, { id: team.userId, name: "Ada" })).rejects.toThrow("Only images and videos go on the wall");
    const other = await seedTeam(db);
    await expect(publishArtifact(other, clip.id, { id: other.userId, name: "X" })).rejects.toThrow("No such file");
    await expect(publishArtifact(team, randomUUID(), { id: team.userId, name: "Ada" })).rejects.toThrow("No such file");
  });
});

/* ---------- worker bookkeeping ---------- */

describe("worker bookkeeping", () => {
  it("records the workspace, sums reported credits, names the run's place and finds the skill by team", async () => {
    const run = await startRun();
    await setRunWorkspace(run.id, "/srv/agent-homes/t/runs/r");
    expect((await getRunById(run.id))!.workspace).toBe("/srv/agent-homes/t/runs/r");

    await addCredits(run.id, 12);
    await addCredits(run.id, 0.5);
    for (const ignored of [0, -3, Number.NaN, Number.POSITIVE_INFINITY]) await addCredits(run.id, ignored);
    expect((await getRunById(run.id))!.credits).toBe(12.5);

    const place = await runPlace(run);
    expect(place.teamName).toBe("Ada");
    expect(place.productName).not.toBe("");
    expect(place.projectName).not.toBe("");
    expect(await runPlace({ teamId: run.teamId, productId: randomUUID(), projectId: randomUUID() })).toEqual({ teamName: "Ada", productName: "", projectName: "" });

    expect(await getSkill(team, run.skillId)).toMatchObject({ id: run.skillId, slug: "drama-ad-machine", status: "ready" });
    expect(await getSkill({ teamId: randomUUID() }, run.skillId)).toBeNull();
  });
});

/* ---------- the actions ---------- */

describe("the actions", () => {
  it("create, list, get, sync, message, answer, decide, stop, artifacts and publish, through the session's team", async () => {
    const skill = await installSkill(team);
    const ref = await seedAsset(team);
    const created = await createAgentRun({ skillId: skill.id, projectId, title: "Via action", brief: "Go.", attachmentAssetIds: [ref.id] });
    if (!created.ok) throw new Error(created.error);
    const run = created.data;
    expect(run).toMatchObject({ title: "Via action", status: "queued", lastSeq: 1 });

    expect(await listAgentRuns({ projectId })).toEqual({ ok: true, data: [run] });
    expect(await listAgentRuns({ projectId: randomUUID() })).toEqual({ ok: true, data: [] });
    expect(await getAgentRun(run.id)).toEqual({ ok: true, data: run });

    await claimRun("w1");
    const asked = await appendEvent(run.id, question("q1"));
    const held = await appendEvent(run.id, approval("a1"));
    const sync = await syncAgentEvents({ runId: run.id, afterSeq: 1 });
    if (!sync.ok) throw new Error(sync.error);
    expect(sync.data.events.map((e) => e.seq)).toEqual([2, 3, 4]);
    expect(sync.data.run.status).toBe("running");
    expect(sync.data.gates.map((e) => e.seq)).toEqual([asked.seq, held.seq]);

    const sent = await sendAgentMessage({ runId: run.id, text: "Hi", attachmentAssetIds: [ref.id] });
    if (!sent.ok) throw new Error(sent.error);
    expect(sent.data.payload).toEqual({ kind: "message", text: "Hi", attachments: [{ assetId: ref.id, name: "ref.png", url: ref.url }] });
    const answered = await answerAgentQuestion({ runId: run.id, questionId: "q1", answers: { "Which angle?": ["Pain", "Dream"] } });
    expect(answered.ok).toBe(true);
    const decided = await decideAgentApproval({ runId: run.id, approvalId: "a1", decision: "approved" });
    expect(decided.ok).toBe(true);
    const after = await syncAgentEvents({ runId: run.id, afterSeq: 4 });
    if (!after.ok) throw new Error(after.error);
    expect(after.data.events.map((e) => e.payload.kind)).toEqual(["user"]);
    expect(after.data.gates.map((e) => e.payload)).toEqual([
      expect.objectContaining({ kind: "question", answers: { "Which angle?": ["Pain", "Dream"] }, answeredBy: "Ada" }),
      expect.objectContaining({ kind: "approval", decision: "approved", decidedBy: "Ada" }),
    ]);
    expect((await takeInputs(run.id)).map((i) => i.payload.kind)).toEqual(["message", "answer", "approval"]);

    const board = await recordArtifact(run.id, { path: "outputs/board.png", fileKind: "image", storageKey: "k", url: "https://media.test/k", sizeBytes: 10 });
    expect(await listAgentArtifacts(run.id)).toEqual({ ok: true, data: [board] });
    const published = await publishAgentArtifact({ artifactId: board.id });
    if (!published.ok) throw new Error(published.error);
    expect(published.data.resultId).toEqual(expect.any(String));

    const stopped = await stopAgentRun(run.id);
    if (!stopped.ok) throw new Error(stopped.error);
    expect(stopped.data.status).toBe("stopping");
    expect((await takeInputs(run.id)).map((i) => i.payload)).toEqual([{ kind: "stop" }]);
  });

  it("folds bad input and a failed sign-in into plain failures", async () => {
    expect(await createAgentRun({ projectId, title: "t", brief: "b" })).toEqual({ ok: false, error: "Pick a skill" });
    expect(await createAgentRun({ skillId: "s", title: "t", brief: "b" })).toEqual({ ok: false, error: "Pick a project" });
    expect(await createAgentRun({ skillId: "s", projectId, brief: "b" })).toEqual({ ok: false, error: "Give the run a title" });
    expect(await createAgentRun({ skillId: "s", projectId, title: "t", brief: "b", attachmentAssetIds: "nope" })).toEqual({ ok: false, error: "Attachments come as a list" });
    expect(await syncAgentEvents({ runId: "r", afterSeq: -1 })).toEqual({ ok: false, error: "Invalid sync point" });
    expect(await answerAgentQuestion({ runId: "r", questionId: "q", answers: {} })).toEqual({ ok: false, error: "Pick an answer" });
    expect(await answerAgentQuestion({ runId: "r", questionId: "q", answers: { q: 1 } })).toEqual({ ok: false, error: "An answer is a label or a list of labels" });
    expect(await decideAgentApproval({ runId: "r", approvalId: "a", decision: "maybe" })).toEqual({ ok: false, error: "Approve or decline" });
    expect(await getAgentRun(randomUUID())).toEqual({ ok: false, error: "No such run" });
    expect(await publishAgentArtifact({})).toEqual({ ok: false, error: "No such file" });
    vi.mocked(requireTeam).mockRejectedValue(Object.assign(new Error("Sign in to continue"), { name: "UnauthenticatedError" }));
    expect(await listAgentRuns({})).toEqual({ ok: false, error: "Sign in to continue", code: "unauthenticated" });
  });
});
