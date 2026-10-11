import { stat } from "node:fs/promises";

import { LeaseLostError, type AgentEventPayload, type AgentRunRecord, type SkillRecord } from "@/server/agents-contract";
import type { MediaStore } from "@/server/storage";

import { hashFile, locateFile, scanWorkspace, uploadArtifact, type FoundFile, type Snapshot } from "./artifacts";
import { childEnv, workerScriptKeys } from "./env";
import { ensureHome, fetchInputs, installSkill, prepareWorkspace, type Attachment, type TeamHome, type Workspace } from "./home";
import { PollingInbox } from "./inbox";
import type { Logger } from "./log";
import { Masker } from "./mask";
import type { ObjectReader } from "./objects";
import type { AgentRuntime, RuntimeOutcome, RuntimeSession, StudioHooks } from "./runtime";
import type { RunContext, WorkerStore } from "./store";

/* One claimed run, from the claim to its last event. The loop in main.ts
   only decides how many of these run at once; everything a run needs — its
   team's HOME and skill, the workspace with the inputs and the keys, the
   inbox, the lease, the artifact scan, the final status — is here, and the
   runtime is handed a session that already has all of it. */

export type RunDeps = {
  store: WorkerStore;
  media: MediaStore;
  objects: ObjectReader;
  runtime: AgentRuntime;
  homeRoot: string;
  workerId: string;
  /** The team's KIE key (and base url) for the scripts; `{}` when the team has none. */
  credentials(teamId: string): Promise<Record<string, string>>;
  processEnv: Record<string, string | undefined>;
  /** The worker is shutting down. */
  signal: AbortSignal;
  log: Logger;
  leaseRenewMs?: number;
  inboxPollMs?: number;
};

export const LEASE_RENEW_MS = 45_000;

export type RunEnd = RuntimeOutcome | { status: "lost" };

export async function runAgent(run: AgentRunRecord, deps: RunDeps): Promise<RunEnd> {
  const log = deps.log.child({ runId: run.id, teamId: run.teamId, skill: run.skillSlug });
  let mask = new Masker(deps.processEnv);

  /* The lease says this worker still owns the run. Losing it (another worker
     reclaimed after a long pause) means stop writing, quietly. The store
     refuses a write from a worker that no longer holds the run, so the loss
     is also noticed at the first write or inbox poll after it, not only at
     the next renewal. */
  const local = new AbortController();
  let lost = false;
  const lose = () => {
    if (lost) return;
    lost = true;
    log.warn("lease lost; dropping the run");
    local.abort();
  };
  const emit = async (payload: AgentEventPayload, parentToolUseId: string | null = null) => {
    try {
      await deps.store.appendEvent(run.id, mask.value(payload), parentToolUseId, deps.workerId);
    } catch (caught) {
      if (caught instanceof LeaseLostError) lose();
      throw caught;
    }
  };
  const lease = setInterval(() => {
    deps.store
      .renewLease(run.id, deps.workerId)
      .then((kept) => {
        if (!kept) lose();
      })
      .catch((caught: unknown) => log.warn("lease renewal failed", { error: caught }));
  }, deps.leaseRenewMs ?? LEASE_RENEW_MS);
  lease.unref?.();
  const signal = AbortSignal.any([deps.signal, local.signal]);

  let inbox: PollingInbox | null = null;
  try {
    const skill = await deps.store.getSkill(run.teamId, run.skillId);
    if (!skill) throw new Error("The run's skill is no longer in the library");
    const home = await ensureHome(deps.homeRoot, run.teamId);
    const keys = { ...workerScriptKeys(deps.processEnv), ...(await deps.credentials(run.teamId)) };
    mask = new Masker({ ...deps.processEnv, ...keys });

    const install = await installSkill(home, skill, deps.objects);
    log.info(install.installed ? "skill installed" : "skill current", { files: install.files });
    const attachments: Attachment[] = await deps.store.runAttachments(run.id);
    const workspace = await prepareWorkspace(home, run, { attachments, env: keys, objects: deps.objects });
    await deps.store.markStarted(run.id, workspace.dir);
    const context = await deps.store.runContext(run);

    inbox = new PollingInbox({
      take: () => deps.store.takeInputs(run.id, deps.workerId),
      intervalMs: deps.inboxPollMs,
      onError: (caught) => {
        if (caught instanceof LeaseLostError) lose();
        else log.warn("inbox poll failed", { error: caught });
      },
    }).start();

    const artifacts = new ArtifactTracker(run, workspace, deps);
    const studio: StudioHooks = {
      publish: (path, title) => artifacts.publish(path, title),
      note: (text) => emit({ kind: "text", text: asNote(text), final: true }),
      reportCredits: (credits) => deps.store.addCredits(run.id, credits),
      settleQuestion: (questionId, answers, by) => deps.store.settleQuestion(run.id, questionId, answers, by),
      settleApproval: (approvalId, decision, by) => deps.store.settleApproval(run.id, approvalId, decision, by),
    };
    const session: RuntimeSession = {
      run,
      skill,
      home,
      workspace,
      env: childEnv(deps.processEnv, home, keys),
      prompt: firstPrompt(skill, run, workspace),
      systemAppend: studioAppend({ context, skill, workspace, hasKieKey: Boolean(keys.KIE_API_KEY) }),
      inbox,
      emit,
      studio,
      afterTurn: () => artifacts.scan(),
      fetchAttachments: async (list) => (await fetchInputs(workspace.inputsDir, list, deps.objects)).map((name) => `inputs/${name}`),
      signal,
      mask,
      log,
    };

    /* claimRun wrote the `running` status event when it took the run. */
    const outcome = await deps.runtime.start(session);
    inbox.close();
    if (lost) return { status: "lost" };
    if (outcome.status === "released") {
      await emit({ kind: "status", status: "queued", reason: "worker stopping" });
      log.info("run released", { status: run.status });
      return outcome;
    }
    await artifacts.scan().catch((caught: unknown) => log.warn("final artifact scan failed", { error: caught }));
    /* finishRun writes the terminal status event itself. */
    await deps.store.finishRun(run.id, outcome.status, outcome.error, deps.workerId);
    log.info("run ended", { status: outcome.status, error: outcome.error });
    return outcome;
  } catch (caught) {
    if (caught instanceof LeaseLostError) lose();
    if (lost) return { status: "lost" };
    const message = mask.text(caught instanceof Error ? caught.message : String(caught));
    log.error("run failed", { error: caught });
    if (signal.aborted && !inbox?.stopped) {
      await emit({ kind: "status", status: "queued", reason: "worker stopping" }).catch(() => undefined);
      return { status: "released" };
    }
    await emit({ kind: "error", message }).catch(() => undefined);
    await deps.store.finishRun(run.id, "failed", message, deps.workerId).catch(() => undefined);
    return { status: "failed", error: message };
  } finally {
    clearInterval(lease);
    inbox?.close();
  }
}

/* ---------- artifacts ---------- */

/** Remembers what the workspace held after the last look, uploads what is
    new, and records it (the store writes the `artifact` event); the publish
    tool goes through the same path and then puts the file on the wall. */
class ArtifactTracker {
  private snapshot: Snapshot = new Map();
  private scanning: Promise<void> | null = null;
  /** Artifact ids by workspace path, so a publish of a file the scan already
      uploaded does not upload it twice. */
  private readonly recorded = new Map<string, { id: string; url: string }>();

  constructor(
    private readonly run: AgentRunRecord,
    private readonly workspace: Workspace,
    private readonly deps: Pick<RunDeps, "store" | "media" | "workerId">,
  ) {}

  /** One scan at a time; a second call while one runs waits for it. */
  scan(): Promise<void> {
    if (!this.scanning) {
      this.scanning = this.scanNow().finally(() => {
        this.scanning = null;
      });
    }
    return this.scanning;
  }

  private async scanNow(): Promise<void> {
    const { changed, snapshot } = await scanWorkspace(this.workspace.dir, this.snapshot);
    this.snapshot = snapshot;
    for (const file of changed) await this.record(file);
  }

  /** The wall takes images and videos; anything else is kept as a run
      artifact and the agent is told so, rather than refused. */
  async publish(requested: string, _title: string | null): Promise<{ url: string }> {
    const file = await locateFile(this.workspace.dir, requested);
    if (!file) throw new Error(`No file at ${requested} inside the run's working directory`);
    const info = await stat(file.absolute);
    const sha256 = await hashFile(file.absolute);
    const before = this.snapshot.get(file.path);
    const known = this.recorded.get(file.path);
    const record = before && before.sha256 === sha256 && known ? known : await this.record(file);
    this.snapshot.set(file.path, { size: info.size, mtimeMs: info.mtimeMs, sha256 });
    if (file.fileKind !== "image" && file.fileKind !== "video") return { url: `${record.url} (kept as a run artifact; only images and videos go on the wall)` };
    const published = await this.deps.store.publishArtifact(this.run, record.id);
    return { url: published.url };
  }

  private async record(file: FoundFile): Promise<{ id: string; url: string }> {
    const draft = await uploadArtifact(this.deps.media, this.run, file);
    const record = await this.deps.store.recordArtifact(this.run, draft, this.deps.workerId);
    const entry = { id: record.id, url: record.url };
    this.recorded.set(file.path, entry);
    return entry;
  }
}

/* ---------- prompts ---------- */

/** Turn one: the skill by its slash command, then the brief as written, and
    the attachments by path so the agent knows they are there. */
export function firstPrompt(skill: Pick<SkillRecord, "slug">, run: Pick<AgentRunRecord, "brief">, workspace: Pick<Workspace, "inputs">): string {
  const files = workspace.inputs.length > 0 ? `\n\nAttached files (in the working directory):\n${workspace.inputs.map((file) => `- ./${file}`).join("\n")}` : "";
  return `/${skill.slug} ${run.brief.trim()}${files}`;
}

/** What is appended to Claude Code's own system prompt. The skills were
    written for a terminal; this tells the agent where it actually is. */
export function studioAppend(input: {
  context: RunContext;
  skill: Pick<SkillRecord, "name" | "slug">;
  workspace: Pick<Workspace, "inputs">;
  hasKieKey: boolean;
}): string {
  const where = [input.context.productName, input.context.projectName].filter(Boolean).join(" › ") || "the current project";
  const inputs = input.workspace.inputs.length > 0 ? `The person attached ${input.workspace.inputs.length} file(s); they are under ./inputs/.` : "There are no attached files; ./inputs/ is empty.";
  const key = input.hasKieKey
    ? "The team's KIE key is in ./.env as KIE_API_KEY (also in your environment); other keys the scripts need are there too when the studio has them."
    : "The team has no KIE key configured yet: say so before any step that needs one, and do not invent a key.";
  return [
    `You are running the "${input.skill.name}" skill inside the team studio, not in a terminal with a person watching. Team: ${input.context.teamName}. Project: ${where}.`,
    `Your working directory is this run's workspace. ${inputs} Put every finished deliverable under ./outputs/ (images, videos, boards, scripts, reports); the studio keeps those as run artifacts automatically. Publish the ones the team should see on its wall with the mcp__studio__publish tool, one call per file.`,
    `Money: anything that spends — a KIE job, a Higgsfield call, a paid script — is held by the studio for a person's approval before it runs. Do not try to work around a declined command; explain and wait. Report KIE credits a batch consumed with mcp__studio__report_credits.`,
    `When you need a decision, prefer AskUserQuestion for a short multiple-choice; for anything that needs the person to look at the work, end your turn with a clear, specific question. The team reads the stream in a browser and answers when they are back, so keep going on your own wherever the skill does not require a verdict.`,
    `${key} Never print a key, a token or the contents of .env into your answers or into files under ./outputs/. Use mcp__studio__note for short notes to the team that are not questions.`,
  ].join("\n\n");
}

/** A note from the agent reads as a blockquote in the stream. */
export function asNote(text: string): string {
  return text
    .trim()
    .split("\n")
    .map((line, index) => (index === 0 ? `> **Note** — ${line}` : `> ${line}`))
    .join("\n");
}

export type { TeamHome, Workspace };
