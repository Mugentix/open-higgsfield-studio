"use server";

import {
  BRIEF_MAX_CHARS,
  MESSAGE_MAX_CHARS,
  type AgentArtifactRecord,
  type AgentEventRecord,
  type AgentInputRecord,
  type AgentRunRecord,
} from "./agents-contract";
import {
  actorOf,
  createRun,
  getRun,
  listArtifacts,
  listEvents,
  listGates,
  listRuns,
  publishArtifact,
  pushInput,
  resolveAttachments,
} from "./agents";
import { guarded, type ActionResult } from "./result";
import { requireTeam } from "./team";

/* Agent runs, as the studio drives them. Every call resolves the session's
   team first and hands it to the core; nothing here trusts an id the client
   sent until the core has seen it belong to that team. */

const ATTACHMENTS_MAX = 20;

/** Any member starts a run of a ready skill in one of the team's projects,
    with files from the team library attached. */
export async function createAgentRun(data: unknown): Promise<ActionResult<AgentRunRecord>> {
  return guarded(async () => {
    const team = await requireTeam();
    const record = asObject(data);
    return createRun(team, {
      skillId: readId(record.skillId, "Pick a skill"),
      projectId: readId(record.projectId, "Pick a project"),
      title: readText(record.title, 200, "Give the run a title"),
      brief: readText(record.brief, BRIEF_MAX_CHARS + 1, "Tell the agent what to do"),
      attachmentAssetIds: readIds(record.attachmentAssetIds),
    });
  });
}

/** The team's runs, newest first; a project narrows them. */
export async function listAgentRuns(data: unknown): Promise<ActionResult<AgentRunRecord[]>> {
  return guarded(async () => {
    const team = await requireTeam();
    const record = asObject(data);
    return listRuns(team, typeof record.projectId === "string" && record.projectId ? { projectId: record.projectId } : {});
  });
}

export async function getAgentRun(id: unknown): Promise<ActionResult<AgentRunRecord>> {
  return guarded(async () => {
    const team = await requireTeam();
    return getRun(team, readId(id, "No such run"));
  });
}

/** What the run view polls: the events after the last seq it holds, the run
    itself so status and cost move with them, and the questions and approvals
    as they stand — a decision rewrites an event the client already passed, so
    the client replaces what it holds by seq. */
export async function syncAgentEvents(
  data: unknown,
): Promise<ActionResult<{ events: AgentEventRecord[]; run: AgentRunRecord; gates: AgentEventRecord[] }>> {
  return guarded(async () => {
    const team = await requireTeam();
    const record = asObject(data);
    const runId = readId(record.runId, "No such run");
    const [events, run, gates] = await Promise.all([
      listEvents(team, runId, readSeq(record.afterSeq)),
      getRun(team, runId),
      listGates(team, runId),
    ]);
    return { events, run, gates };
  });
}

/** A message into an open run, with files from the team library attached. */
export async function sendAgentMessage(data: unknown): Promise<ActionResult<AgentInputRecord>> {
  return guarded(async () => {
    const team = await requireTeam();
    const record = asObject(data);
    const runId = readId(record.runId, "No such run");
    const text = typeof record.text === "string" ? record.text.trim() : "";
    if (text.length > MESSAGE_MAX_CHARS) throw new Error(`A message runs to ${MESSAGE_MAX_CHARS} characters`);
    const attachments = await resolveAttachments(team, readIds(record.attachmentAssetIds));
    return pushInput(team, runId, { kind: "message", text, attachments }, actorOf(team));
  });
}

/** The answers to one of the agent's questions; the first answer stands. */
export async function answerAgentQuestion(data: unknown): Promise<ActionResult<AgentInputRecord>> {
  return guarded(async () => {
    const team = await requireTeam();
    const record = asObject(data);
    return pushInput(
      team,
      readId(record.runId, "No such run"),
      { kind: "answer", questionId: readId(record.questionId, "No such question"), answers: readAnswers(record.answers) },
      actorOf(team),
    );
  });
}

/** Approve or decline a command the worker held; the first decision stands. */
export async function decideAgentApproval(data: unknown): Promise<ActionResult<AgentInputRecord>> {
  return guarded(async () => {
    const team = await requireTeam();
    const record = asObject(data);
    return pushInput(
      team,
      readId(record.runId, "No such run"),
      { kind: "approval", approvalId: readId(record.approvalId, "No such approval"), decision: readDecision(record.decision) },
      actorOf(team),
    );
  });
}

/** Asks the worker to wind the run down; a run no worker holds ends at once. */
export async function stopAgentRun(id: unknown): Promise<ActionResult<AgentRunRecord>> {
  return guarded(async () => {
    const team = await requireTeam();
    const runId = readId(id, "No such run");
    await pushInput(team, runId, { kind: "stop" }, actorOf(team));
    return getRun(team, runId);
  });
}

export async function listAgentArtifacts(runId: unknown): Promise<ActionResult<AgentArtifactRecord[]>> {
  return guarded(async () => {
    const team = await requireTeam();
    return listArtifacts(team, readId(runId, "No such run"));
  });
}

/** Puts a run's image or video on the team wall, in the run's project. */
export async function publishAgentArtifact(data: unknown): Promise<ActionResult<AgentArtifactRecord>> {
  return guarded(async () => {
    const team = await requireTeam();
    return publishArtifact(team, readId(asObject(data).artifactId, "No such file"), actorOf(team));
  });
}

function readId(value: unknown, message: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 100) throw new Error(message);
  return value;
}

/** Trimmed; empty is the given refusal, longer than `max` is cut. */
function readText(value: unknown, max: number, message: string): string {
  if (typeof value !== "string" || value.trim().length < 1) throw new Error(message);
  return value.trim().slice(0, max);
}

/** Asset ids to attach; absent is none, anything that is not a list of ids is refused. */
function readIds(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error("Attachments come as a list");
  const ids = value.filter((v): v is string => typeof v === "string" && v.length > 0 && v.length < 100);
  if (ids.length !== value.length) throw new Error("No such file");
  if (ids.length > ATTACHMENTS_MAX) throw new Error(`Attach up to ${ATTACHMENTS_MAX} files`);
  return ids;
}

function readSeq(value: unknown): number {
  if (value === undefined || value === null) return 0;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw new Error("Invalid sync point");
  return value;
}

/** One label, or a list of labels, per question asked. */
function readAnswers(value: unknown): Record<string, string | string[]> {
  const record = asObject(value);
  const answers: Record<string, string | string[]> = {};
  for (const [question, answer] of Object.entries(record)) {
    if (typeof answer === "string") answers[question] = answer.slice(0, 2000);
    else if (Array.isArray(answer) && answer.every((v): v is string => typeof v === "string")) {
      answers[question] = answer.map((v) => v.slice(0, 2000));
    } else throw new Error("An answer is a label or a list of labels");
  }
  if (Object.keys(answers).length === 0) throw new Error("Pick an answer");
  return answers;
}

function readDecision(value: unknown): "approved" | "denied" {
  if (value !== "approved" && value !== "denied") throw new Error("Approve or decline");
  return value;
}

function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
