/* The one vocabulary the studio, the server actions and the agent worker
   share for skill runs. Nothing in here imports anything, so the browser,
   the Next server and the worker process all read the same words. */

/** A skill is a Claude Code skill folder the team uploaded as a zip:
    SKILL.md with a name and a description, scripts, references, and
    optionally agents/*.md subagents. It installs under the team's own HOME
    on the worker, at ~/.claude/skills/<slug>/, which is where such folders
    expect to live. */
export type SkillStatus = "ready" | "invalid";

export type SkillRecord = {
  id: string;
  teamId: string;
  /** From SKILL.md frontmatter. */
  name: string;
  /** Folder name on disk; lower-case, dashes. */
  slug: string;
  description: string;
  version: string | null;
  compatibility: string | null;
  /** Subagent names found in agents/*.md. */
  agents: string[];
  /** Files in the bundle. */
  files: number;
  sizeBytes: number;
  /** Where the zip sits in the media store. */
  storageKey: string;
  status: SkillStatus;
  /** Why the bundle was refused, when it was. */
  problems: string[];
  createdBy: string | null;
  createdAt: number;
};

/** queued: waiting for a worker. running: the agent is working. waiting:
    the agent asked something, approval or question, or ended its turn with
    a gate and the run waits on a person. stopping: a stop was asked and the
    worker is winding the session down. done/failed/stopped: terminal. */
export type AgentRunStatus = "queued" | "running" | "waiting" | "stopping" | "stopped" | "done" | "failed";

export const RUN_OPEN: readonly AgentRunStatus[] = ["queued", "running", "waiting", "stopping"];

/** Thrown by the worker-facing core when a write names a worker that no
    longer holds the run's lease: it was reclaimed and another worker drives
    it now. The old worker stops writing the moment it sees one. */
export class LeaseLostError extends Error {
  constructor(runId: string) {
    super(`The run ${runId} is no longer leased to this worker`);
    this.name = "LeaseLostError";
  }
}

export type AgentRunRecord = {
  id: string;
  teamId: string;
  projectId: string;
  productId: string;
  skillId: string;
  skillName: string;
  skillSlug: string;
  title: string;
  /** The first message, verbatim. */
  brief: string;
  status: AgentRunStatus;
  /** The Agent SDK session id, once the first turn answered. */
  sessionId: string | null;
  /** Absolute path of the run's working directory on the worker. */
  workspace: string | null;
  /** Dollars the model loop cost so far, summed over turns. */
  costUsd: number;
  /** KIE credits the run reported spending, when a skill reports them. */
  credits: number;
  /** Highest event seq written, so a client knows where to sync from. */
  lastSeq: number;
  error: string | null;
  createdBy: string | null;
  createdByName: string | null;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  endedAt: number | null;
};

/** Everything the worker tells the studio about a run, append-only and
    numbered per run so a client resumes from the last seq it saw. */
export type AgentEventKind =
  | "text"
  | "thinking"
  | "tool_use"
  | "tool_result"
  | "subagent"
  | "question"
  | "approval"
  | "user"
  | "status"
  | "result"
  | "artifact"
  | "error";

export type QuestionOption = { label: string; description: string };
export type Question = { question: string; header: string; options: QuestionOption[]; multiSelect: boolean };

export type AgentEventPayload =
  /** A block of assistant prose, Markdown. `final` is false while it streams. */
  | { kind: "text"; text: string; final: boolean }
  | { kind: "thinking"; text: string }
  /** A tool the agent called. `input` is the sanitized input (secrets masked,
      long strings cut); `summary` is one line for the collapsed row. */
  | { kind: "tool_use"; toolUseId: string; name: string; summary: string; input: Record<string, unknown> }
  | { kind: "tool_result"; toolUseId: string; output: string; isError: boolean; truncated: boolean }
  /** A subagent the agent delegated to (the Task tool); events of the
      subagent carry parentToolUseId = this toolUseId. */
  | { kind: "subagent"; toolUseId: string; name: string; description: string; state: "started" | "stopped" }
  /** The agent asked the person through AskUserQuestion. The answers land on
      the same event once given. */
  | { kind: "question"; questionId: string; questions: Question[]; answers: Record<string, string | string[]> | null; answeredBy: string | null }
  /** A tool call the worker held for a person: a paid command, by the gate
      rules. `decision` lands on the same event once made. */
  | {
      kind: "approval";
      approvalId: string;
      toolName: string;
      command: string;
      reason: string;
      decision: "approved" | "denied" | null;
      decidedBy: string | null;
    }
  /** A message a person sent into the run. */
  | { kind: "user"; text: string; userName: string | null; attachments: Array<{ name: string; url: string }> }
  | { kind: "status"; status: AgentRunStatus; reason: string | null }
  /** One turn ended (the SDK result message). */
  | { kind: "result"; subtype: string; costUsd: number; turns: number; durationMs: number; sessionId: string | null }
  | { kind: "artifact"; artifactId: string; path: string; fileKind: ArtifactKind; url: string; sizeBytes: number }
  | { kind: "error"; message: string };

export type AgentEventRecord = {
  id: string;
  runId: string;
  seq: number;
  at: number;
  parentToolUseId: string | null;
  payload: AgentEventPayload;
};

export type ArtifactKind = "image" | "video" | "audio" | "document" | "other";

export type AgentArtifactRecord = {
  id: string;
  runId: string;
  teamId: string;
  /** Relative to the run's workspace. */
  path: string;
  fileKind: ArtifactKind;
  storageKey: string;
  url: string;
  sizeBytes: number;
  /** The gallery result this artifact was published as, once it was. */
  resultId: string | null;
  createdAt: number;
};

/** What a person sends into a run; the worker consumes these in order. */
export type AgentInputKind = "message" | "answer" | "approval" | "stop";

export type AgentInputPayload =
  | { kind: "message"; text: string; attachments: Array<{ assetId: string; name: string; url: string }> }
  | { kind: "answer"; questionId: string; answers: Record<string, string | string[]> }
  | { kind: "approval"; approvalId: string; decision: "approved" | "denied" }
  | { kind: "stop" };

export type AgentInputRecord = {
  id: string;
  runId: string;
  createdBy: string | null;
  createdByName: string | null;
  createdAt: number;
  consumedAt: number | null;
  payload: AgentInputPayload;
};

/** Limits both sides enforce. */
export const SKILL_ZIP_MAX_BYTES = 50 * 1024 * 1024;
export const SKILL_FILES_MAX = 2000;
export const BRIEF_MAX_CHARS = 20_000;
export const MESSAGE_MAX_CHARS = 20_000;
export const EVENT_TEXT_MAX_CHARS = 60_000;
export const TOOL_OUTPUT_MAX_CHARS = 12_000;
export const EVENTS_PAGE = 200;
