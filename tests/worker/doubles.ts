import { createHash, randomUUID } from "node:crypto";

import {
  LeaseLostError,
  type AgentArtifactRecord,
  type AgentEventPayload,
  type AgentEventRecord,
  type AgentInputPayload,
  type AgentInputRecord,
  type AgentRunRecord,
  type AgentRunStatus,
  type SkillRecord,
} from "@/server/agents-contract";
import type { MediaStore, PresignedPut } from "@/server/storage";

import type { ObjectReader } from "../../worker/objects";
import type { ArtifactDraft, RunContext, TerminalStatus, WorkerStore } from "../../worker/store";

/* In-memory stand-ins for what the worker reaches for: the store (with the
   same side effects the real core has — settle on push, the artifact event
   from recordArtifact, the status event from finishRun), the media store,
   and the object reader over it. Not a test file; the tests import it. */

export class MemoryMedia implements MediaStore {
  readonly kind = "local" as const;
  readonly public = true;
  readonly objects = new Map<string, { bytes: Uint8Array; contentType: string }>();

  async put(key: string, body: ReadableStream<Uint8Array> | Uint8Array, contentType: string) {
    const bytes = body instanceof Uint8Array ? body : new Uint8Array(await new Response(body).arrayBuffer());
    this.objects.set(key, { bytes, contentType });
    return { bytes: bytes.byteLength };
  }
  async presignPut(key: string, contentType: string, contentLength: number): Promise<PresignedPut> {
    return { url: `memory://put/${key}?size=${contentLength}`, headers: { "Content-Type": contentType }, expiresAt: Date.now() + 60_000 };
  }
  async head(key: string) {
    const object = this.objects.get(key);
    return object ? { bytes: object.bytes.byteLength, contentType: object.contentType } : null;
  }
  async remove(key: string) {
    this.objects.delete(key);
  }
  async sha256(key: string) {
    const object = this.objects.get(key);
    return object ? createHash("sha256").update(object.bytes).digest("hex") : null;
  }
  publicUrl(key: string): string {
    return `https://media.test/${key}`;
  }
}

export function memoryReader(media: MemoryMedia): ObjectReader {
  return {
    async read(key) {
      const object = media.objects.get(key);
      if (!object) throw new Error(`no object ${key}`);
      return object.bytes;
    },
    keyOf(url) {
      return url.startsWith("https://media.test/") ? url.slice("https://media.test/".length) : null;
    },
  };
}

export function skillRecord(over: Partial<SkillRecord> = {}): SkillRecord {
  return {
    id: "skill-1",
    teamId: "team-1",
    name: "Drama Ad Machine",
    slug: "drama-ad-machine",
    description: "Makes ads.",
    version: "1.0",
    compatibility: null,
    agents: ["sd2-qc-inspector"],
    files: 3,
    sizeBytes: 100,
    storageKey: "t/team-1/skills/skill-1.zip",
    status: "ready",
    problems: [],
    createdBy: "user-1",
    createdAt: 0,
    ...over,
  };
}

export function runRecord(over: Partial<AgentRunRecord> = {}): AgentRunRecord {
  return {
    id: "run-1",
    teamId: "team-1",
    projectId: "project-1",
    productId: "product-1",
    skillId: "skill-1",
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
    createdBy: "user-1",
    createdByName: "Ada",
    createdAt: 0,
    updatedAt: 0,
    startedAt: null,
    endedAt: null,
    ...over,
  };
}

export class MemoryWorkerStore implements WorkerStore {
  readonly runs = new Map<string, AgentRunRecord>();
  readonly skills = new Map<string, SkillRecord>();
  readonly events = new Map<string, AgentEventRecord[]>();
  readonly inputs = new Map<string, AgentInputRecord[]>();
  readonly artifacts = new Map<string, AgentArtifactRecord[]>();
  readonly published: Array<{ runId: string; artifactId: string }> = [];
  readonly leases = new Map<string, string>();
  readonly attachments = new Map<string, Array<{ name: string; url: string }>>();
  renewAnswer = true;
  context: RunContext = { teamName: "Ada's Team", productName: "Coffee Pods", projectName: "Q4 hooks" };

  seed(run: AgentRunRecord, skill: SkillRecord, attachments: Array<{ name: string; url: string }> = []): void {
    this.runs.set(run.id, run);
    this.skills.set(skill.id, skill);
    this.events.set(run.id, []);
    this.inputs.set(run.id, []);
    this.artifacts.set(run.id, []);
    this.attachments.set(run.id, attachments);
    void this.appendEvent(run.id, { kind: "user", text: run.brief, userName: run.createdByName, attachments });
  }

  /** What the studio's pushInput does, including settling gates on push. */
  async pushInput(runId: string, payload: AgentInputPayload, by = "Ada"): Promise<void> {
    const run = this.run(runId);
    if (["done", "failed", "stopped"].includes(run.status)) throw new Error("The run has ended");
    if (payload.kind === "answer") await this.settleQuestion(runId, payload.questionId, payload.answers, by);
    if (payload.kind === "approval") await this.settleApproval(runId, payload.approvalId, payload.decision, by);
    this.inputs.get(runId)!.push({ id: randomUUID(), runId, createdBy: "user-1", createdByName: by, createdAt: Date.now(), consumedAt: null, payload });
    if (payload.kind === "message") await this.appendEvent(runId, { kind: "user", text: payload.text, userName: by, attachments: payload.attachments });
    if (payload.kind === "stop") await this.appendEvent(runId, { kind: "status", status: "stopping", reason: `Stop asked by ${by}` });
  }

  eventsOf(runId: string): AgentEventRecord[] {
    return this.events.get(runId) ?? [];
  }

  payloads(runId: string): AgentEventPayload[] {
    return this.eventsOf(runId).map((event) => event.payload);
  }

  run(runId: string): AgentRunRecord {
    const run = this.runs.get(runId);
    if (!run) throw new Error("No such run");
    return run;
  }

  async reclaimStale(): Promise<void> {}

  /** Like the core: the claim itself writes the `running` status event. */
  async claimRun(workerId: string): Promise<AgentRunRecord | null> {
    const next = [...this.runs.values()].find((run) => run.status === "queued");
    if (!next) return null;
    this.leases.set(next.id, workerId);
    next.startedAt ??= Date.now();
    await this.appendEvent(next.id, { kind: "status", status: "running", reason: "A worker picked the run up" });
    return { ...next };
  }

  async renewLease(runId: string, workerId: string): Promise<boolean> {
    return this.renewAnswer && this.leases.get(runId) === workerId;
  }

  async getSkill(_teamId: string, skillId: string): Promise<SkillRecord | null> {
    return this.skills.get(skillId) ?? null;
  }

  async runContext(): Promise<RunContext> {
    return this.context;
  }

  async runAttachments(runId: string) {
    return this.attachments.get(runId) ?? [];
  }

  async markStarted(runId: string, workspace: string): Promise<void> {
    const run = this.run(runId);
    run.workspace = workspace;
    run.startedAt ??= Date.now();
  }

  /** Like the core: a worker's write lands only while the lease is its; the
      studio's own writes (seed, pushInput) name no worker. */
  async appendEvent(runId: string, payload: AgentEventPayload, parentToolUseId: string | null = null, workerId?: string): Promise<AgentEventRecord> {
    const run = this.run(runId);
    this.assertLeased(runId, workerId);
    run.lastSeq += 1;
    run.updatedAt = Date.now();
    if (payload.kind === "status") {
      const terminal = ["done", "failed", "stopped"].includes(payload.status);
      if (terminal || payload.status === "queued" || run.status !== "stopping") run.status = payload.status;
    }
    if (payload.kind === "result") {
      run.costUsd += payload.costUsd;
      if (payload.sessionId) run.sessionId = payload.sessionId;
    }
    const record: AgentEventRecord = { id: randomUUID(), runId, seq: run.lastSeq, at: Date.now(), parentToolUseId, payload };
    this.events.get(runId)!.push(record);
    return record;
  }

  async takeInputs(runId: string, workerId?: string): Promise<AgentInputRecord[]> {
    this.assertLeased(runId, workerId);
    const pending = (this.inputs.get(runId) ?? []).filter((input) => input.consumedAt === null);
    for (const input of pending) input.consumedAt = Date.now();
    return pending;
  }

  private assertLeased(runId: string, workerId: string | undefined): void {
    if (workerId && this.leases.get(runId) !== workerId && !["done", "failed", "stopped"].includes(this.run(runId).status)) {
      throw new LeaseLostError(runId);
    }
  }

  async settleQuestion(runId: string, questionId: string, answers: Record<string, string | string[]>, by: string | null): Promise<void> {
    for (const event of this.eventsOf(runId)) {
      if (event.payload.kind === "question" && event.payload.questionId === questionId && event.payload.answers === null) {
        event.payload = { ...event.payload, answers, answeredBy: by };
      }
    }
  }

  async settleApproval(runId: string, approvalId: string, decision: "approved" | "denied", by: string | null): Promise<void> {
    for (const event of this.eventsOf(runId)) {
      if (event.payload.kind === "approval" && event.payload.approvalId === approvalId && event.payload.decision === null) {
        event.payload = { ...event.payload, decision, decidedBy: by };
      }
    }
  }

  async recordArtifact(run: AgentRunRecord, draft: ArtifactDraft, workerId?: string): Promise<AgentArtifactRecord> {
    this.assertLeased(run.id, workerId);
    const list = this.artifacts.get(run.id)!;
    const existing = list.find((artifact) => artifact.path === draft.path);
    const record: AgentArtifactRecord = {
      id: existing?.id ?? randomUUID(),
      runId: run.id,
      teamId: run.teamId,
      path: draft.path,
      fileKind: draft.fileKind,
      storageKey: draft.storageKey,
      url: draft.url,
      sizeBytes: draft.sizeBytes,
      resultId: existing?.resultId ?? null,
      createdAt: Date.now(),
    };
    if (existing) list[list.indexOf(existing)] = record;
    else list.push(record);
    await this.appendEvent(run.id, { kind: "artifact", artifactId: record.id, path: record.path, fileKind: record.fileKind, url: record.url, sizeBytes: record.sizeBytes }, null, workerId);
    return record;
  }

  async publishArtifact(run: AgentRunRecord, artifactId: string): Promise<{ resultId: string | null; url: string }> {
    const artifact = this.artifacts.get(run.id)!.find((entry) => entry.id === artifactId);
    if (!artifact) throw new Error("No such file");
    if (artifact.fileKind !== "image" && artifact.fileKind !== "video") throw new Error("Only images and videos go on the wall");
    artifact.resultId ??= randomUUID();
    this.published.push({ runId: run.id, artifactId });
    return { resultId: artifact.resultId, url: artifact.url };
  }

  async addCredits(runId: string, credits: number): Promise<void> {
    this.run(runId).credits += credits;
  }

  async finishRun(runId: string, status: TerminalStatus, error?: string | null, workerId?: string): Promise<void> {
    const run = this.run(runId);
    if (["done", "failed", "stopped"].includes(run.status)) return;
    this.assertLeased(runId, workerId);
    run.error = error ?? null;
    run.endedAt = Date.now();
    this.leases.delete(runId);
    await this.appendEvent(runId, { kind: "status", status, reason: error ?? null });
  }

  statusOf(runId: string): AgentRunStatus {
    return this.run(runId).status;
  }
}

/** Polls until `check` holds or the budget runs out. */
export async function until(check: () => boolean, { timeoutMs = 5_000, stepMs = 10 } = {}): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition never held");
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}
