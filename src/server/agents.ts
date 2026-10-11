import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, asc, desc, eq, exists, gt, inArray, isNull, lt, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT, PgUpdateSetSource } from "drizzle-orm/pg-core";

import {
  EVENTS_PAGE,
  EVENT_TEXT_MAX_CHARS,
  BRIEF_MAX_CHARS,
  LeaseLostError,
  MESSAGE_MAX_CHARS,
  RUN_OPEN,
  TOOL_OUTPUT_MAX_CHARS,
  type AgentArtifactRecord,
  type AgentEventPayload,
  type AgentEventRecord,
  type AgentInputPayload,
  type AgentInputRecord,
  type AgentRunRecord,
  type AgentRunStatus,
  type ArtifactKind,
  type SkillRecord,
} from "./agents-contract";
import { db, schema } from "./db/client";
import { enqueue } from "./jobs/queue";
import { formatBytes, inspectSkillBundle } from "./skill-bundle";
import { mediaStore } from "./storage";
import { mimeForKey } from "./storage/keys";
import type { TeamContext } from "./team";

/* Skills and their runs. The studio's actions call the team-scoped half with
   the session's team; the worker calls the other half by run id, because it
   has no session and the run row already says whose it is. The two never
   talk except through these tables: the worker appends events, people push
   inputs, and both sides poll. No "use server" here — the worker imports it. */

/** Who did a thing, for rows that remember it. The worker names the run's
    author when it publishes on the agent's behalf. */
export type Actor = { id: string | null; name: string | null };

export function actorOf(team: Pick<TeamContext, "userId" | "userName">): Actor {
  return { id: team.userId, name: team.userName };
}

type TeamScope = Pick<TeamContext, "teamId">;
type Executor = PgDatabase<PgQueryResultHKT, typeof schema>;

/** A worker holds a claimed run this long between renewals; past it, the run
    is assumed orphaned and goes back to the queue. */
export const RUN_LEASE_MS = 2 * 60_000;
const LEASE_SECONDS = RUN_LEASE_MS / 1000;
const RUNS_LIMIT = 200;
const GATES_LIMIT = 50;
const TITLE_MAX_CHARS = 120;
const TERMINAL: readonly AgentRunStatus[] = ["done", "failed", "stopped"];

type SkillRow = typeof schema.skills.$inferSelect;
type RunRow = typeof schema.agentRuns.$inferSelect;
type EventRow = typeof schema.agentEvents.$inferSelect;
type InputRow = typeof schema.agentInputs.$inferSelect;
type ArtifactRow = typeof schema.agentArtifacts.$inferSelect;
type Author = { name: string; email: string } | null;

/* ---------- records ---------- */

function skillOf(row: SkillRow): SkillRecord {
  return {
    id: row.id,
    teamId: row.teamId,
    name: row.name,
    slug: row.slug,
    description: row.description,
    version: row.version,
    compatibility: row.compatibility,
    agents: row.agents,
    files: row.files,
    sizeBytes: row.sizeBytes,
    storageKey: row.storageKey,
    status: row.status as SkillRecord["status"],
    problems: row.problems,
    createdBy: row.createdBy,
    createdAt: row.createdAt.getTime(),
  };
}

function runOf(row: RunRow, author: Author): AgentRunRecord {
  return {
    id: row.id,
    teamId: row.teamId,
    projectId: row.projectId,
    productId: row.productId,
    /* The skill row may be gone; the run keeps its name and slug regardless. */
    skillId: row.skillId ?? "",
    skillName: row.skillName,
    skillSlug: row.skillSlug,
    title: row.title,
    brief: row.brief,
    status: row.status as AgentRunStatus,
    sessionId: row.sessionId,
    workspace: row.workspace,
    costUsd: Number(row.costUsd),
    credits: Number(row.credits),
    lastSeq: row.lastSeq,
    error: row.error,
    createdBy: row.createdBy,
    createdByName: author ? author.name || author.email : null,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
    startedAt: row.startedAt?.getTime() ?? null,
    endedAt: row.endedAt?.getTime() ?? null,
  };
}

function eventOf(row: EventRow): AgentEventRecord {
  return { id: row.id, runId: row.runId, seq: row.seq, at: row.at.getTime(), parentToolUseId: row.parentToolUseId, payload: row.payload };
}

function inputOf(row: InputRow, author: Author): AgentInputRecord {
  return {
    id: row.id,
    runId: row.runId,
    createdBy: row.createdBy,
    createdByName: author ? author.name || author.email : null,
    createdAt: row.createdAt.getTime(),
    consumedAt: row.consumedAt?.getTime() ?? null,
    payload: row.payload,
  };
}

function artifactOf(row: ArtifactRow): AgentArtifactRecord {
  return {
    id: row.id,
    runId: row.runId,
    teamId: row.teamId,
    path: row.path,
    fileKind: row.fileKind as ArtifactKind,
    storageKey: row.storageKey,
    url: row.url,
    sizeBytes: row.sizeBytes,
    resultId: row.resultId,
    createdAt: row.createdAt.getTime(),
  };
}

/** The names behind a set of user ids; a vanished user is a null. */
async function authorsOf(ids: Array<string | null>): Promise<Map<string, Author>> {
  const wanted = [...new Set(ids.filter((id): id is string => id !== null))];
  if (wanted.length === 0) return new Map();
  const users = await db
    .select({ id: schema.user.id, name: schema.user.name, email: schema.user.email })
    .from(schema.user)
    .where(inArray(schema.user.id, wanted));
  return new Map(users.map((row) => [row.id, { name: row.name, email: row.email }]));
}

/* ---------- skills ---------- */

/** The team's library, by name. */
export async function listSkills(team: TeamScope): Promise<SkillRecord[]> {
  const rows = await db.query.skills.findMany({ where: eq(schema.skills.teamId, team.teamId), orderBy: asc(schema.skills.name) });
  return rows.map(skillOf);
}

/** One of the team's skills, or null when it is not theirs. */
export async function getSkill(team: TeamScope, id: string): Promise<SkillRecord | null> {
  const row = await db.query.skills.findFirst({ where: and(eq(schema.skills.id, id), eq(schema.skills.teamId, team.teamId)) });
  return row ? skillOf(row) : null;
}

export type InstallSkillInput = { bytes: Uint8Array; fileName: string; createdBy: string | null };

/** Reads the bundle, stores the normalised zip and writes the row. A slug the
    team already has is the same skill in a new version: the row keeps its id,
    so runs stay attached, and gets a new key, so a cache never serves the
    old bytes. A refused bundle is kept as "invalid" with its problems, so the
    library can say why — unless it would displace a working skill of the
    same slug, in which case it is refused outright. */
export async function installSkillFromZip(team: TeamScope, input: InstallSkillInput): Promise<SkillRecord> {
  const bundle = inspectSkillBundle(input.bytes, input.fileName);
  const existing = await db.query.skills.findFirst({
    where: and(eq(schema.skills.teamId, team.teamId), eq(schema.skills.slug, bundle.slug)),
  });
  if (bundle.zip === null && existing?.status === "ready") {
    throw new Error(`The bundle was refused and "${existing.name}" stays as it was: ${bundle.problems.join("; ")}`);
  }
  const id = existing?.id ?? randomUUID();
  let storageKey = "";
  if (bundle.zip) {
    storageKey = skillKey(team.teamId, id, bundle.zip);
    await mediaStore().put(storageKey, bundle.zip, "application/zip");
  }
  const values = {
    name: bundle.name,
    description: bundle.description,
    version: bundle.version,
    compatibility: bundle.compatibility,
    agents: bundle.agents,
    files: bundle.files,
    sizeBytes: bundle.sizeBytes,
    storageKey,
    status: bundle.zip ? "ready" : "invalid",
    problems: bundle.problems,
    createdBy: input.createdBy,
    createdAt: new Date(),
  };
  const [row] = await db
    .insert(schema.skills)
    .values({ id, teamId: team.teamId, slug: bundle.slug, ...values })
    .onConflictDoUpdate({ target: [schema.skills.teamId, schema.skills.slug], set: values })
    .returning();
  if (existing?.storageKey && existing.storageKey !== storageKey) {
    await enqueue("purge_media", existing.storageKey, { key: existing.storageKey }, { teamId: team.teamId });
  }
  return skillOf(row!);
}

/** Where a skill's zip sits: under the team, named by the skill and by the
    bytes, so every version is its own object. */
function skillKey(teamId: string, skillId: string, zip: Uint8Array): string {
  return `t/${teamId}/skills/${skillId}.${createHash("sha256").update(zip).digest("hex").slice(0, 12)}.zip`;
}

/** Gone from the library and the store; runs keep the skill's name. Refused
    while a run of it is still open, since a worker may be installing it. */
export async function removeSkill(team: TeamScope, id: string): Promise<null> {
  const skill = await db.query.skills.findFirst({ where: and(eq(schema.skills.id, id), eq(schema.skills.teamId, team.teamId)) });
  if (!skill) throw new Error("No such skill");
  const open = await db.query.agentRuns.findFirst({
    where: and(eq(schema.agentRuns.skillId, id), inArray(schema.agentRuns.status, [...RUN_OPEN])),
    columns: { id: true },
  });
  if (open) throw new Error("A run of this skill is still open; stop it first");
  await db.delete(schema.skills).where(and(eq(schema.skills.id, id), eq(schema.skills.teamId, team.teamId)));
  if (skill.storageKey) await enqueue("purge_media", skill.storageKey, { key: skill.storageKey }, { teamId: team.teamId });
  return null;
}

/* ---------- runs ---------- */

export type CreateAgentRunInput = {
  skillId: string;
  projectId: string;
  title: string;
  brief: string;
  attachmentAssetIds: string[];
};

export type Attachment = { assetId: string; name: string; url: string };

/** The team's ready files behind a list of asset ids, in the order asked;
    one that is not the team's fails the whole list. */
export async function resolveAttachments(team: TeamScope, assetIds: string[]): Promise<Attachment[]> {
  const ids = [...new Set(assetIds)];
  if (ids.length === 0) return [];
  const assets = await db.query.assets.findMany({
    where: and(
      eq(schema.assets.teamId, team.teamId),
      inArray(schema.assets.id, ids),
      eq(schema.assets.status, "ready"),
      isNull(schema.assets.deletedAt),
    ),
    columns: { id: true, name: true, url: true },
  });
  const byId = new Map(assets.map((asset) => [asset.id, asset]));
  return ids.map((id) => {
    const asset = byId.get(id);
    if (!asset) throw new Error("An attached file is not in this team");
    return { assetId: asset.id, name: asset.name, url: asset.url };
  });
}

/** The row, queued, and the brief as the run's first event, so the stream
    opens on what was asked. A worker picks it up from here. */
export async function createRun(team: TeamContext, input: CreateAgentRunInput): Promise<AgentRunRecord> {
  const title = input.title.trim();
  const brief = input.brief.trim();
  if (!title) throw new Error("Give the run a title");
  if (title.length > TITLE_MAX_CHARS) throw new Error(`A title runs to ${TITLE_MAX_CHARS} characters`);
  if (!brief) throw new Error("Tell the agent what to do");
  if (brief.length > BRIEF_MAX_CHARS) throw new Error(`A brief runs to ${BRIEF_MAX_CHARS} characters`);

  const skill = await db.query.skills.findFirst({
    where: and(eq(schema.skills.id, input.skillId), eq(schema.skills.teamId, team.teamId)),
  });
  if (!skill) throw new Error("No such skill");
  if (skill.status !== "ready") throw new Error("That skill was refused; upload a fixed bundle first");
  const project = await db.query.projects.findFirst({
    where: and(eq(schema.projects.id, input.projectId), eq(schema.projects.teamId, team.teamId)),
  });
  if (!project) throw new Error("No such project");
  const attachments = await resolveAttachments(team, input.attachmentAssetIds);

  const id = randomUUID();
  await db.insert(schema.agentRuns).values({
    id,
    teamId: team.teamId,
    projectId: project.id,
    productId: project.productId,
    skillId: skill.id,
    skillName: skill.name,
    skillSlug: skill.slug,
    title,
    brief,
    createdBy: team.userId,
  });
  await appendEvent(id, {
    kind: "user",
    text: brief,
    userName: team.userName,
    attachments: attachments.map(({ name, url }) => ({ name, url })),
  });
  await db.update(schema.projects).set({ lastUsedAt: new Date() }).where(eq(schema.projects.id, project.id));
  return (await getRunById(id))!;
}

/** The team's runs, newest first; a project narrows them. */
export async function listRuns(team: TeamScope, filter: { projectId?: string } = {}): Promise<AgentRunRecord[]> {
  const rows = await db
    .select({ run: schema.agentRuns, author: { name: schema.user.name, email: schema.user.email } })
    .from(schema.agentRuns)
    .leftJoin(schema.user, eq(schema.agentRuns.createdBy, schema.user.id))
    .where(
      and(
        eq(schema.agentRuns.teamId, team.teamId),
        ...(filter.projectId ? [eq(schema.agentRuns.projectId, filter.projectId)] : []),
      ),
    )
    .orderBy(desc(schema.agentRuns.createdAt), desc(schema.agentRuns.id))
    .limit(RUNS_LIMIT);
  return rows.map((row) => runOf(row.run, row.author));
}

export async function getRun(team: TeamScope, id: string): Promise<AgentRunRecord> {
  const run = await getRunById(id);
  if (!run || run.teamId !== team.teamId) throw new Error("No such run");
  return run;
}

/** By id alone, for the worker, which has no team in hand. */
export async function getRunById(id: string): Promise<AgentRunRecord | null> {
  const [row] = await db
    .select({ run: schema.agentRuns, author: { name: schema.user.name, email: schema.user.email } })
    .from(schema.agentRuns)
    .leftJoin(schema.user, eq(schema.agentRuns.createdBy, schema.user.id))
    .where(eq(schema.agentRuns.id, id))
    .limit(1);
  return row ? runOf(row.run, row.author) : null;
}

async function ownedRun(team: TeamScope, runId: string): Promise<RunRow> {
  const row = await db.query.agentRuns.findFirst({ where: and(eq(schema.agentRuns.id, runId), eq(schema.agentRuns.teamId, team.teamId)) });
  if (!row) throw new Error("No such run");
  return row;
}

/** The events after `afterSeq`, oldest first, a page at a time. */
export async function listEvents(team: TeamScope, runId: string, afterSeq: number, limit = EVENTS_PAGE): Promise<AgentEventRecord[]> {
  await ownedRun(team, runId);
  const rows = await db.query.agentEvents.findMany({
    where: and(eq(schema.agentEvents.runId, runId), gt(schema.agentEvents.seq, afterSeq)),
    orderBy: asc(schema.agentEvents.seq),
    limit: Math.max(1, Math.min(limit, EVENTS_PAGE)),
  });
  return rows.map(eventOf);
}

/** The run's questions and approvals as they stand now. A decision rewrites
    an event in place, at a seq the client has already passed, so paging by
    seq alone would never show it; a client replaces what it holds by seq. */
export async function listGates(team: TeamScope, runId: string): Promise<AgentEventRecord[]> {
  await ownedRun(team, runId);
  const rows = await db.query.agentEvents.findMany({
    where: and(eq(schema.agentEvents.runId, runId), sql`${schema.agentEvents.payload}->>'kind' IN ('question', 'approval')`),
    orderBy: desc(schema.agentEvents.seq),
    limit: GATES_LIMIT,
  });
  return rows.reverse().map(eventOf);
}

/** What a person sends into a run. A message is also written to the stream
    at once, so the sender sees it before any worker does; an answer or a
    decision lands on its question or approval at once, for the same reason;
    a stop on a run no worker holds ends it here, since nothing would read
    the input. Refused once the run has ended. */
export async function pushInput(team: TeamScope, runId: string, payload: AgentInputPayload, user: Actor): Promise<AgentInputRecord> {
  const run = await ownedRun(team, runId);
  if (!RUN_OPEN.includes(run.status as AgentRunStatus)) throw new Error("The run has ended");

  if (payload.kind === "message") {
    const text = payload.text.trim();
    if (!text && payload.attachments.length === 0) throw new Error("Write something to send");
    if (text.length > MESSAGE_MAX_CHARS) throw new Error(`A message runs to ${MESSAGE_MAX_CHARS} characters`);
    const attachments = await resolveAttachments(team, payload.attachments.map((item) => item.assetId));
    payload = { kind: "message", text, attachments };
  } else if (payload.kind === "answer") {
    const settled = await settleQuestion(runId, payload.questionId, payload.answers, user.name);
    if (!settled || settled.payload.kind !== "question") throw new Error("No such question");
    if (settled.payload.answeredBy !== user.name || !sameAnswers(settled.payload.answers, payload.answers)) {
      throw new Error(`Already answered${settled.payload.answeredBy ? ` by ${settled.payload.answeredBy}` : ""}`);
    }
  } else if (payload.kind === "approval") {
    const settled = await settleApproval(runId, payload.approvalId, payload.decision, user.name);
    if (!settled || settled.payload.kind !== "approval") throw new Error("No such approval");
    if (settled.payload.decidedBy !== user.name || settled.payload.decision !== payload.decision) {
      throw new Error(`Already decided${settled.payload.decidedBy ? ` by ${settled.payload.decidedBy}` : ""}`);
    }
  } else if (run.status === "queued") {
    /* No worker holds it, so no worker would read a stop. */
    await finishRun(runId, "stopped", user.name ? `Stopped by ${user.name}` : "Stopped");
    const [row] = await db
      .insert(schema.agentInputs)
      .values({ id: randomUUID(), runId, createdBy: user.id, payload, consumedAt: new Date() })
      .returning();
    return inputOf(row!, { name: user.name ?? "", email: "" });
  }

  const [row] = await db.insert(schema.agentInputs).values({ id: randomUUID(), runId, createdBy: user.id, payload }).returning();
  if (payload.kind === "message") {
    await appendEvent(runId, {
      kind: "user",
      text: payload.text,
      userName: user.name,
      attachments: payload.attachments.map(({ name, url }) => ({ name, url })),
    });
  } else if (payload.kind === "stop") {
    await appendEvent(runId, { kind: "status", status: "stopping", reason: user.name ? `Stop asked by ${user.name}` : "Stop asked" });
  }
  return inputOf(row!, user.id ? { name: user.name ?? "", email: "" } : null);
}

function sameAnswers(a: Record<string, string | string[]> | null, b: Record<string, string | string[]>): boolean {
  return a !== null && JSON.stringify(a) === JSON.stringify(b);
}

/* ---------- artifacts ---------- */

export async function listArtifacts(team: TeamScope, runId: string): Promise<AgentArtifactRecord[]> {
  await ownedRun(team, runId);
  const rows = await db.query.agentArtifacts.findMany({
    where: eq(schema.agentArtifacts.runId, runId),
    orderBy: [asc(schema.agentArtifacts.createdAt), asc(schema.agentArtifacts.path)],
  });
  return rows.map(artifactOf);
}

/** Puts an artifact on the wall: a finished, mirrored run with one tile, in
    the run's project, under the skill as the model, so the gallery renders
    it with everything else. Publishing twice is one tile. */
export async function publishArtifact(team: TeamScope, artifactId: string, user: Actor): Promise<AgentArtifactRecord> {
  const artifact = await db.query.agentArtifacts.findFirst({
    where: and(eq(schema.agentArtifacts.id, artifactId), eq(schema.agentArtifacts.teamId, team.teamId)),
  });
  if (!artifact) throw new Error("No such file");
  if (artifact.resultId) {
    const tile = await db.query.results.findFirst({ where: eq(schema.results.id, artifact.resultId), columns: { id: true } });
    if (tile) return artifactOf(artifact);
  }
  if (artifact.fileKind !== "image" && artifact.fileKind !== "video") throw new Error("Only images and videos go on the wall");
  const run = await db.query.agentRuns.findFirst({ where: eq(schema.agentRuns.id, artifact.runId) });
  if (!run) throw new Error("No such run");

  const kind = artifact.fileKind;
  const modelId = `agent:${run.skillSlug}`;
  const prompt = `${artifact.path} — ${run.title}`;
  const ratio =
    artifact.width && artifact.height ? `${artifact.width} / ${artifact.height}` : kind === "image" ? "1 / 1" : "16 / 9";
  const ext = artifact.path.match(/\.([a-z0-9]{2,5})$/i)?.[1]?.toUpperCase();
  const meta = [ext, formatBytes(artifact.sizeBytes)].filter(Boolean).join(" · ");
  const runId = randomUUID();
  const resultId = randomUUID();
  const now = new Date();
  await db.transaction(async (tx) => {
    const [made] = await tx
      .insert(schema.runs)
      .values({
        id: runId,
        teamId: run.teamId,
        projectId: run.projectId,
        productId: run.productId,
        userId: user.id,
        idempotencyKey: `agent:${artifact.id}`,
        surface: kind,
        modelId,
        modelLabel: run.skillName,
        kieModel: modelId,
        prompt,
        settings: {},
        media: [],
        kieInput: {},
        expectedCount: 1,
        status: "succeeded",
        callbackToken: randomBytes(18).toString("base64url"),
        submittedAt: now,
        deadlineAt: now,
        completedAt: now,
      })
      .onConflictDoNothing()
      .returning();
    /* Two publishes of one file raced; the first one's tile stands. */
    if (!made) return;
    await tx.insert(schema.results).values({
      id: resultId,
      runId,
      index: 0,
      teamId: run.teamId,
      projectId: run.projectId,
      productId: run.productId,
      userId: user.id,
      kind,
      modelId,
      modelLabel: run.skillName,
      prompt,
      ratio,
      meta,
      settings: {},
      status: "completed",
      sourceUrl: artifact.url,
      key: artifact.storageKey,
      url: artifact.url,
      mirrorStatus: "done",
      bytes: artifact.sizeBytes,
      mime: mimeForKey(artifact.storageKey),
      width: artifact.width,
      height: artifact.height,
    });
    await tx.insert(schema.runEvents).values({
      id: randomUUID(),
      runId,
      teamId: run.teamId,
      type: "published",
      payload: { agentRunId: run.id, artifactId: artifact.id, by: user.id },
    });
    await tx.update(schema.agentArtifacts).set({ resultId }).where(eq(schema.agentArtifacts.id, artifact.id));
  });
  const published = await db.query.agentArtifacts.findFirst({ where: eq(schema.agentArtifacts.id, artifact.id) });
  return artifactOf(published!);
}

/* ---------- worker-facing ---------- */

/** One queued run, oldest first, leased to this worker. SKIP LOCKED keeps
    two workers off the same row; the status event is written in the same
    transaction, so nobody sees a running run without its line. */
export async function claimRun(workerId: string): Promise<AgentRunRecord | null> {
  const id = await db.transaction(async (tx) => {
    const next = tx
      .select({ id: schema.agentRuns.id })
      .from(schema.agentRuns)
      .where(eq(schema.agentRuns.status, "queued"))
      .orderBy(asc(schema.agentRuns.createdAt), asc(schema.agentRuns.id))
      .limit(1)
      .for("update", { skipLocked: true });
    const [claimed] = await tx
      .update(schema.agentRuns)
      .set({
        status: "running",
        workerId,
        leaseUntil: sql`now() + (${LEASE_SECONDS} * interval '1 second')`,
        startedAt: sql`COALESCE(${schema.agentRuns.startedAt}, now())`,
        updatedAt: new Date(),
      })
      .where(eq(schema.agentRuns.id, next))
      .returning();
    if (!claimed) return null;
    await appendWith(tx, claimed.id, { kind: "status", status: "running", reason: "A worker picked the run up" });
    return claimed.id;
  });
  return id ? getRunById(id) : null;
}

/** True while this worker still holds the run; false means another worker
    may have it, or it ended, and this one must let go. */
export async function renewLease(runId: string, workerId: string): Promise<boolean> {
  const [row] = await db
    .update(schema.agentRuns)
    .set({ leaseUntil: sql`now() + (${LEASE_SECONDS} * interval '1 second')` })
    .where(
      and(eq(schema.agentRuns.id, runId), eq(schema.agentRuns.workerId, workerId), inArray(schema.agentRuns.status, [...RUN_OPEN])),
    )
    .returning();
  return Boolean(row);
}

/** The next line of the stream. The seq is taken from the run row in the
    same statement that bumps it, so two writers never share one; a `status`
    event moves the run, a `result` event adds its cost and keeps the
    session id. Long text is cut to the limits both sides enforce. A worker
    names itself, and the write lands only while the run is leased to it:
    a reclaimed run answers LeaseLostError instead of taking the line. The
    studio's own writes (the brief, a message, a stop) name no worker. */
export async function appendEvent(runId: string, payload: AgentEventPayload, parentToolUseId?: string | null, workerId?: string): Promise<AgentEventRecord> {
  return db.transaction((tx) => appendWith(tx, runId, payload, parentToolUseId, workerId));
}

async function appendWith(exec: Executor, runId: string, payload: AgentEventPayload, parentToolUseId?: string | null, workerId?: string): Promise<AgentEventRecord> {
  const clipped = clip(payload);
  const now = new Date();
  const [run] = await exec
    .update(schema.agentRuns)
    .set({ lastSeq: sql`${schema.agentRuns.lastSeq} + 1`, updatedAt: now, ...effectsOf(clipped, now) })
    .where(workerId ? and(eq(schema.agentRuns.id, runId), eq(schema.agentRuns.workerId, workerId)) : eq(schema.agentRuns.id, runId))
    .returning({ lastSeq: schema.agentRuns.lastSeq });
  if (!run) throw await missingOrLost(exec, runId, workerId);
  const [row] = await exec
    .insert(schema.agentEvents)
    .values({ id: randomUUID(), runId, seq: run.lastSeq, at: now, parentToolUseId: parentToolUseId ?? null, payload: clipped })
    .returning();
  return eventOf(row!);
}

/** Why a worker's write matched no row: the run is gone, or it is someone
    else's now. */
async function missingOrLost(exec: Executor, runId: string, workerId: string | undefined): Promise<Error> {
  if (!workerId) return new Error("No such run");
  const [row] = await exec.select({ id: schema.agentRuns.id }).from(schema.agentRuns).where(eq(schema.agentRuns.id, runId)).limit(1);
  return row ? new LeaseLostError(runId) : new Error("No such run");
}

function effectsOf(payload: AgentEventPayload, now: Date): PgUpdateSetSource<typeof schema.agentRuns> {
  if (payload.kind === "status") {
    if (TERMINAL.includes(payload.status)) {
      return { status: payload.status, endedAt: now, leaseUntil: null, workerId: null, ...(payload.reason && payload.status !== "done" ? { error: payload.reason } : {}) };
    }
    if (payload.status === "queued") return { status: "queued", leaseUntil: null, workerId: null };
    /* A stop that was asked stands: the worker's running/waiting lines while it winds down do not move the run back. */
    return {
      status: sql`CASE WHEN ${schema.agentRuns.status} = 'stopping' THEN ${schema.agentRuns.status} ELSE ${payload.status} END`,
      startedAt: sql`COALESCE(${schema.agentRuns.startedAt}, now())`,
    };
  }
  if (payload.kind === "result") {
    return {
      costUsd: sql`${schema.agentRuns.costUsd} + ${String(Math.max(0, payload.costUsd) || 0)}`,
      ...(payload.sessionId ? { sessionId: payload.sessionId } : {}),
    };
  }
  return {};
}

function clip(payload: AgentEventPayload): AgentEventPayload {
  if (payload.kind === "text" || payload.kind === "thinking") {
    return payload.text.length > EVENT_TEXT_MAX_CHARS ? { ...payload, text: payload.text.slice(0, EVENT_TEXT_MAX_CHARS) } : payload;
  }
  if (payload.kind === "tool_result" && payload.output.length > TOOL_OUTPUT_MAX_CHARS) {
    return { ...payload, output: payload.output.slice(0, TOOL_OUTPUT_MAX_CHARS), truncated: true };
  }
  return payload;
}

/** Everything people sent since the last take, oldest first, marked consumed
    in the same statement so a second worker never reads them. A worker that
    names itself takes only while the run is leased to it; once the run is
    someone else's (or back in the queue) the take is LeaseLostError, so the
    inbox learns of the loss on its own rhythm. */
export async function takeInputs(runId: string, workerId?: string): Promise<AgentInputRecord[]> {
  const leased = workerId
    ? exists(
        db
          .select({ id: schema.agentRuns.id })
          .from(schema.agentRuns)
          .where(and(eq(schema.agentRuns.id, runId), eq(schema.agentRuns.workerId, workerId))),
      )
    : undefined;
  const pending = db
    .select({ id: schema.agentInputs.id })
    .from(schema.agentInputs)
    .where(and(eq(schema.agentInputs.runId, runId), isNull(schema.agentInputs.consumedAt), leased))
    .orderBy(asc(schema.agentInputs.createdAt), asc(schema.agentInputs.id))
    .for("update", { skipLocked: true });
  const rows = await db
    .update(schema.agentInputs)
    .set({ consumedAt: new Date() })
    .where(inArray(schema.agentInputs.id, pending))
    .returning();
  if (rows.length === 0 && workerId) {
    const run = await db.query.agentRuns.findFirst({ where: eq(schema.agentRuns.id, runId), columns: { status: true, workerId: true } });
    if (run && run.workerId !== workerId && RUN_OPEN.includes(run.status as AgentRunStatus)) throw new LeaseLostError(runId);
  }
  rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
  const authors = await authorsOf(rows.map((row) => row.createdBy));
  return rows.map((row) => inputOf(row, row.createdBy ? (authors.get(row.createdBy) ?? null) : null));
}

/** Writes the answers onto the question event. The first answer stands:
    a second call finds the event settled and hands it back unchanged. Null
    when the run has no such question. */
export async function settleQuestion(
  runId: string,
  questionId: string,
  answers: Record<string, string | string[]>,
  by: string | null,
): Promise<AgentEventRecord | null> {
  return settleGate(runId, "question", "questionId", questionId, (payload) =>
    payload.kind === "question" && payload.answers === null ? { ...payload, answers, answeredBy: by } : null,
  );
}

/** Writes the decision onto the approval event; the first decision stands. */
export async function settleApproval(
  runId: string,
  approvalId: string,
  decision: "approved" | "denied",
  by: string | null,
): Promise<AgentEventRecord | null> {
  return settleGate(runId, "approval", "approvalId", approvalId, (payload) =>
    payload.kind === "approval" && payload.decision === null ? { ...payload, decision, decidedBy: by } : null,
  );
}

async function settleGate(
  runId: string,
  kind: "question" | "approval",
  idField: "questionId" | "approvalId",
  gateId: string,
  settle: (payload: AgentEventPayload) => AgentEventPayload | null,
): Promise<AgentEventRecord | null> {
  const where = and(
    eq(schema.agentEvents.runId, runId),
    sql`${schema.agentEvents.payload}->>'kind' = ${kind}`,
    sql`${schema.agentEvents.payload}->>${idField} = ${gateId}`,
  );
  const row = await db.query.agentEvents.findFirst({ where });
  if (!row) return null;
  const next = settle(row.payload);
  if (next) {
    /* Guarded by the open state, so two decisions at once leave one. */
    const openField = kind === "question" ? "answers" : "decision";
    const [updated] = await db
      .update(schema.agentEvents)
      .set({ payload: next })
      .where(and(eq(schema.agentEvents.id, row.id), sql`${schema.agentEvents.payload}->${openField} = 'null'::jsonb`))
      .returning();
    if (updated) {
      await db.update(schema.agentRuns).set({ updatedAt: new Date() }).where(eq(schema.agentRuns.id, runId));
      return eventOf(updated);
    }
  }
  const settled = await db.query.agentEvents.findFirst({ where: eq(schema.agentEvents.id, row.id) });
  return settled ? eventOf(settled) : null;
}

export type RecordArtifactInput = {
  path: string;
  fileKind: ArtifactKind;
  storageKey: string;
  url: string;
  sizeBytes: number;
  /** Pixel size when the worker read it; the wall tile keeps that shape. */
  width?: number | null;
  height?: number | null;
};

/** A file the run produced, by path: a changed file replaces its row and
    keeps its id and its place on the wall. Writes the `artifact` event too,
    since only here is the id known. */
export async function recordArtifact(runId: string, input: RecordArtifactInput, workerId?: string): Promise<AgentArtifactRecord> {
  const run = await db.query.agentRuns.findFirst({
    where: workerId ? and(eq(schema.agentRuns.id, runId), eq(schema.agentRuns.workerId, workerId)) : eq(schema.agentRuns.id, runId),
    columns: { teamId: true },
  });
  if (!run) throw await missingOrLost(db, runId, workerId);
  const values = {
    fileKind: input.fileKind,
    storageKey: input.storageKey,
    url: input.url,
    sizeBytes: input.sizeBytes,
    width: input.width ?? null,
    height: input.height ?? null,
    createdAt: new Date(),
  };
  const [row] = await db
    .insert(schema.agentArtifacts)
    .values({ id: randomUUID(), runId, teamId: run.teamId, path: input.path, ...values })
    .onConflictDoUpdate({ target: [schema.agentArtifacts.runId, schema.agentArtifacts.path], set: values })
    .returning();
  const artifact = artifactOf(row!);
  await appendEvent(
    runId,
    {
      kind: "artifact",
      artifactId: artifact.id,
      path: artifact.path,
      fileKind: artifact.fileKind,
      url: artifact.url,
      sizeBytes: artifact.sizeBytes,
    },
    null,
    workerId,
  );
  return artifact;
}

/** The end of a run, from any open state; a second finish is a no-op and
    answers null. The lease goes with it. A worker that names itself ends
    only a run still leased to it; one that was reclaimed is LeaseLostError. */
export async function finishRun(runId: string, status: "done" | "failed" | "stopped", error?: string | null, workerId?: string): Promise<AgentRunRecord | null> {
  const ended = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(schema.agentRuns)
      .set({ status, error: error ?? null, endedAt: new Date(), updatedAt: new Date(), leaseUntil: null, workerId: null })
      .where(
        and(
          eq(schema.agentRuns.id, runId),
          inArray(schema.agentRuns.status, [...RUN_OPEN]),
          ...(workerId ? [eq(schema.agentRuns.workerId, workerId)] : []),
        ),
      )
      .returning();
    if (!row) {
      if (!workerId) return false;
      const open = await tx.query.agentRuns.findFirst({ where: eq(schema.agentRuns.id, runId), columns: { status: true, workerId: true } });
      if (open && open.workerId !== workerId && RUN_OPEN.includes(open.status as AgentRunStatus)) throw new LeaseLostError(runId);
      return false;
    }
    await appendWith(tx, runId, { kind: "status", status, reason: error ?? null });
    return true;
  });
  return ended ? getRunById(runId) : null;
}

/** Runs whose worker stopped renewing: back to the queue, where another
    worker resumes the session; one that was already stopping has nobody
    left to stop it, so it ends here. Answers the ids it touched. The lease
    was set by the database clock, so it is read against the same clock. */
export async function reclaimStale(): Promise<string[]> {
  const now = sql`now()`;
  return db.transaction(async (tx) => {
    const lost = await tx
      .update(schema.agentRuns)
      .set({ status: "queued", workerId: null, leaseUntil: null, updatedAt: now })
      .where(and(inArray(schema.agentRuns.status, ["running", "waiting"]), lt(schema.agentRuns.leaseUntil, now)))
      .returning();
    for (const run of lost) await appendWith(tx, run.id, { kind: "status", status: "queued", reason: "worker lost" });
    const stopping = await tx
      .update(schema.agentRuns)
      .set({ status: "stopped", error: "worker lost", workerId: null, leaseUntil: null, endedAt: now, updatedAt: now })
      .where(and(eq(schema.agentRuns.status, "stopping"), lt(schema.agentRuns.leaseUntil, now)))
      .returning();
    for (const run of stopping) await appendWith(tx, run.id, { kind: "status", status: "stopped", reason: "worker lost" });
    return [...lost, ...stopping].map((run) => run.id);
  });
}

/** The files attached to the brief, as the first event carries them, for
    the worker to lay into the run's inputs/. */
export async function runAttachments(runId: string): Promise<Array<{ name: string; url: string }>> {
  const first = await db.query.agentEvents.findFirst({
    where: and(eq(schema.agentEvents.runId, runId), eq(schema.agentEvents.seq, 1)),
  });
  return first?.payload.kind === "user" ? first.payload.attachments : [];
}

/* ---------- worker bookkeeping ---------- */

/** Where the run works on the worker, once its folder is laid out. */
export async function setRunWorkspace(runId: string, workspace: string): Promise<void> {
  await db.update(schema.agentRuns).set({ workspace, updatedAt: new Date() }).where(eq(schema.agentRuns.id, runId));
}

/** KIE credits a skill reported through the studio tool, on top of what the
    run already carries. Nothing, zero and less are ignored: a skill reports
    what a batch consumed, never a refund. */
export async function addCredits(runId: string, credits: number): Promise<void> {
  if (!Number.isFinite(credits) || credits <= 0) return;
  const rounded = Math.round(credits * 10_000) / 10_000;
  await db
    .update(schema.agentRuns)
    .set({ credits: sql`${schema.agentRuns.credits} + ${String(rounded)}`, updatedAt: new Date() })
    .where(eq(schema.agentRuns.id, runId));
}

/** The names the worker's system prompt speaks: whose team the run is, and
    the product and project it lands in. A name that is gone reads empty. */
export type RunPlace = { teamName: string; productName: string; projectName: string };

export async function runPlace(run: Pick<AgentRunRecord, "teamId" | "productId" | "projectId">): Promise<RunPlace> {
  const [team, product, project] = await Promise.all([
    db.query.organization.findFirst({ where: eq(schema.organization.id, run.teamId), columns: { name: true } }),
    db.query.products.findFirst({ where: eq(schema.products.id, run.productId), columns: { name: true } }),
    db.query.projects.findFirst({ where: eq(schema.projects.id, run.projectId), columns: { name: true } }),
  ]);
  return { teamName: team?.name ?? "the team", productName: product?.name ?? "", projectName: project?.name ?? "" };
}
