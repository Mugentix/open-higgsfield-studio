import type {
  AgentArtifactRecord,
  AgentEventPayload,
  AgentEventRecord,
  AgentInputRecord,
  AgentRunRecord,
  AgentRunStatus,
  ArtifactKind,
  SkillRecord,
} from "@/server/agents-contract";

/* Everything the worker asks of the database, as one interface. The real
   implementation (core-store.ts) is a thin adapter over the worker-facing
   functions in src/server/agents.ts; the tests drive the same loop against
   an in-memory double. Nothing in here imports the database, so the fake
   runtime and the pure modules load without one. */

export type ArtifactDraft = {
  /** Relative to the run's workspace, as the agent wrote it. */
  path: string;
  fileKind: ArtifactKind;
  storageKey: string;
  url: string;
  sizeBytes: number;
};

export type TerminalStatus = Extract<AgentRunStatus, "done" | "failed" | "stopped">;

export type RunContext = { teamName: string; productName: string; projectName: string };

export interface WorkerStore {
  /** Runs whose lease ran out go back to queued with a "worker lost" status event. */
  reclaimStale(): Promise<void>;
  /** One queued run, leased to this worker for two minutes, or null. */
  claimRun(workerId: string): Promise<AgentRunRecord | null>;
  /** False when the lease is no longer this worker's; the run must then be dropped quietly. */
  renewLease(runId: string, workerId: string): Promise<boolean>;
  getSkill(teamId: string, skillId: string): Promise<SkillRecord | null>;
  /** The names the system prompt speaks: the team, the product and the project of the run. */
  runContext(run: AgentRunRecord): Promise<RunContext>;
  /** The files attached to the brief, as createRun wrote them on the first `user` event. */
  runAttachments(runId: string): Promise<Array<{ name: string; url: string }>>;
  /** Records where the run works on the worker. */
  markStarted(runId: string, workspace: string): Promise<void>;
  /** Appends with the next seq; a `status` payload also sets run.status, a
      `result` payload adds costUsd and sets sessionId. Lands only while the
      run is leased to `workerId`; otherwise it throws LeaseLostError. */
  appendEvent(runId: string, payload: AgentEventPayload, parentToolUseId: string | null, workerId: string): Promise<AgentEventRecord>;
  /** Unconsumed inputs, oldest first, marked consumed. Throws LeaseLostError
      once the run is no longer this worker's, so the inbox is where the loss
      is noticed first. */
  takeInputs(runId: string, workerId: string): Promise<AgentInputRecord[]>;
  /** Rewrites the question event's payload with the answers so the studio sees
      them. pushInput already settles when the answer is pushed; the worker's
      call is the no-op that makes the two paths read the same. */
  settleQuestion(runId: string, questionId: string, answers: Record<string, string | string[]>, by: string | null): Promise<void>;
  settleApproval(runId: string, approvalId: string, decision: "approved" | "denied", by: string | null): Promise<void>;
  /** Upserts on (runId, path) — a file the agent rewrote is the same artifact
      with new bytes — and writes the `artifact` event itself. Fenced by the
      lease like appendEvent. */
  recordArtifact(run: AgentRunRecord, draft: ArtifactDraft, workerId: string): Promise<AgentArtifactRecord>;
  /** A gallery row in the run's project, attributed to the run's creator.
      Images and videos only; anything else throws. */
  publishArtifact(run: AgentRunRecord, artifactId: string): Promise<{ resultId: string | null; url: string }>;
  /** KIE credits a skill reported through the studio tool; added to run.credits. */
  addCredits(runId: string, credits: number): Promise<void>;
  /** Sets the terminal status, the error and endedAt, drops the lease and
      writes the terminal `status` event itself. Ends only a run still leased
      to `workerId`; a reclaimed one throws LeaseLostError. */
  finishRun(runId: string, status: TerminalStatus, error: string | null, workerId: string): Promise<void>;
}
