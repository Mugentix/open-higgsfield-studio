import type { AgentEventPayload, AgentInputPayload, AgentInputRecord, AgentRunRecord, SkillRecord } from "@/server/agents-contract";

import type { TeamHome, Workspace } from "./home";
import type { Logger } from "./log";
import type { Masker } from "./mask";

/* The seam between the run loop and whatever drives the agent. The loop
   claims the run, prepares the team's HOME and the workspace, writes the
   status events and scans artifacts; a runtime takes it from the first
   prompt to a terminal state. Two runtimes: the Claude Agent SDK, and a
   scripted replay for tests and UI work (AGENT_RUNTIME=fake). */

export type MessageInput = Extract<AgentInputPayload, { kind: "message" }> & { record: AgentInputRecord };
export type AnswerInput = { answers: Record<string, string | string[]>; by: string | null };
export type ApprovalInput = { decision: "approved" | "denied"; by: string | null };

/** Answers and decisions that arrived while nothing waited for them: the
    gates of a session that died before it read them (a worker restart). They
    are handed to the agent as words, since the tool call they answered is
    gone. */
export type StaleGates = {
  kind: "gates";
  answers: Array<AnswerInput & { questionId: string }>;
  approvals: Array<ApprovalInput & { approvalId: string }>;
};

/** What people send into a run, routed by kind. Every wait resolves null when
    the run is stopped or the worker shuts down, never throws. */
export interface Inbox {
  readonly stopped: boolean;
  /** The next message; or, when none is pending but answers or decisions sit
      unclaimed, those, so a reply to a card from before a restart is not lost. */
  nextMessage(signal: AbortSignal): Promise<MessageInput | StaleGates | null>;
  /** The unclaimed answers and decisions, drained; empty lists when there are none. */
  drainGates(): StaleGates;
  waitForAnswer(questionId: string, signal: AbortSignal): Promise<AnswerInput | null>;
  waitForApproval(approvalId: string, signal: AbortSignal): Promise<ApprovalInput | null>;
  /** Fires once when a stop arrives; returns the unsubscribe. */
  onStop(listener: () => void): () => void;
  close(): void;
}

export type RuntimeSession = {
  run: AgentRunRecord;
  skill: SkillRecord;
  home: TeamHome;
  workspace: Workspace;
  /** The child process environment: the worker's own, HOME pointed at the
      team, and the keys the skill's scripts read. Never written to an event. */
  env: Record<string, string>;
  /** The first turn's prompt (`/<slug> <brief>`), used when the run has no session yet. */
  prompt: string;
  systemAppend: string;
  inbox: Inbox;
  emit(payload: AgentEventPayload, parentToolUseId?: string | null): Promise<void>;
  /** Hooks back into the store the runtime does not own. */
  studio: StudioHooks;
  /** Runs after every finished turn: artifact scanning, lease bookkeeping. */
  afterTurn(): Promise<void>;
  /** Downloads a message's attachments into inputs/ and returns their paths relative to the workspace. */
  fetchAttachments(attachments: MessageInput["attachments"]): Promise<string[]>;
  /** The worker is shutting down; the runtime winds the session down and reports `released`. */
  signal: AbortSignal;
  /** Knows the run's keys; every string that becomes an event goes through it. */
  mask: Masker;
  log: Logger;
};

export type StudioHooks = {
  publish(path: string, title: string | null): Promise<{ url: string }>;
  note(text: string): Promise<void>;
  reportCredits(credits: number): Promise<void>;
  settleQuestion(questionId: string, answers: Record<string, string | string[]>, by: string | null): Promise<void>;
  settleApproval(approvalId: string, decision: "approved" | "denied", by: string | null): Promise<void>;
};

export type RuntimeOutcome =
  | { status: "done" | "stopped" | "failed"; error: string | null }
  /** The worker is stopping; the run goes back to the queue with its session id. */
  | { status: "released" };

export interface AgentRuntime {
  readonly name: string;
  start(session: RuntimeSession): Promise<RuntimeOutcome>;
}
