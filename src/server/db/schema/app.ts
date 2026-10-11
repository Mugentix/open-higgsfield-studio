import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import type { AgentEventPayload, AgentInputPayload } from "../../agents-contract";
import { organization, user } from "./auth";

const ts = (name: string) => timestamp(name, { withTimezone: true });
/* Millisecond precision where a JS Date must round-trip exactly: the gallery
   keyset cursors and the change feed compare these against values the client
   hands back, and Postgres' microsecond now() would otherwise never equal them. */
const tsMs = (name: string) => timestamp(name, { withTimezone: true, precision: 3 });

/* A team is a Better Auth organization; these rows hang off it with what the
   studio needs and Better Auth does not know about. Every table below carries
   team_id so that every query is scoped by the team the session resolved. */

export const teamSettings = pgTable("team_settings", {
  teamId: text("team_id")
    .primaryKey()
    .references(() => organization.id, { onDelete: "cascade" }),
  /** AES-256-GCM under APP_SECRET_KEY; null means the deployment's env key. */
  kieApiKeyEnc: text("kie_api_key_enc"),
  kieKeyLast4: text("kie_key_last4"),
  updatedBy: text("updated_by").references(() => user.id, { onDelete: "set null" }),
  updatedAt: ts("updated_at").defaultNow().notNull(),
});

/* The offers the team promotes. */
export const products = pgTable(
  "products",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    offerUrl: text("offer_url"),
    brandNotes: text("brand_notes"),
    archivedAt: ts("archived_at"),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: ts("created_at").defaultNow().notNull(),
    updatedAt: ts("updated_at").defaultNow().notNull(),
  },
  (t) => [uniqueIndex("products_team_slug").on(t.teamId, t.slug), index("products_team").on(t.teamId, t.createdAt)],
);

/* A workspace under a product: a campaign, an angle, a test. Every run
   belongs to one. */
export const projects = pgTable(
  "projects",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    productId: text("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    brief: text("brief"),
    status: text("status").default("active").notNull(),
    lastUsedAt: ts("last_used_at").defaultNow().notNull(),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: ts("created_at").defaultNow().notNull(),
    updatedAt: ts("updated_at").defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("projects_product_slug").on(t.productId, t.slug),
    index("projects_team_recent").on(t.teamId, t.lastUsedAt),
  ],
);

/* Every byte the team owns that is not a generation result: uploads, frames
   pulled from results, product references. The object lives in the media
   store under `key`; `url` is where it is served from. */
export const assets = pgTable(
  "assets",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    productId: text("product_id").references(() => products.id, { onDelete: "set null" }),
    projectId: text("project_id").references(() => projects.id, { onDelete: "set null" }),
    userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
    /** upload | frame | import */
    source: text("source").notNull(),
    /** image | video | audio */
    kind: text("kind").notNull(),
    name: text("name").notNull(),
    mime: text("mime").notNull(),
    bytes: bigint("bytes", { mode: "number" }),
    width: integer("width"),
    height: integer("height"),
    durationMs: integer("duration_ms"),
    sha256: text("sha256"),
    key: text("key").notNull(),
    url: text("url").notNull(),
    /** A copy on KIE's scratch service, minted when the store is not public. */
    kieUrl: text("kie_url"),
    kieUrlExpiresAt: ts("kie_url_expires_at"),
    /** pending | ready | failed */
    status: text("status").default("pending").notNull(),
    /** Shelf slot 1–9 on the product, when pinned. */
    pin: integer("pin"),
    createdAt: ts("created_at").defaultNow().notNull(),
    deletedAt: ts("deleted_at"),
  },
  (t) => [
    uniqueIndex("assets_key").on(t.key),
    index("assets_team_kind").on(t.teamId, t.kind, t.createdAt),
    index("assets_team_sha").on(t.teamId, t.sha256),
  ],
);

/* One KIE task. The row exists before KIE is called; the id the studio
   watches is this one, never KIE's. */
export const runs = pgTable(
  "runs",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    productId: text("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
    /** Presses that fan out into several tasks share one batch id. */
    batchId: text("batch_id"),
    parentResultId: text("parent_result_id"),
    idempotencyKey: text("idempotency_key").notNull(),
    surface: text("surface").notNull(),
    modelId: text("model_id").notNull(),
    modelLabel: text("model_label").notNull(),
    kieModel: text("kie_model").notNull(),
    prompt: text("prompt").notNull(),
    settings: jsonb("settings").$type<Record<string, unknown>>().notNull(),
    media: jsonb("media").$type<Array<{ role: string; url: string; assetId?: string; resultId?: string }>>().notNull(),
    kieInput: jsonb("kie_input").$type<Record<string, unknown>>().notNull(),
    expectedCount: integer("expected_count").default(1).notNull(),
    /** pending | submitting | submitted | succeeded | failed | lost */
    status: text("status").default("pending").notNull(),
    kieTaskId: text("kie_task_id"),
    kieState: text("kie_state"),
    failCode: text("fail_code"),
    failMsg: text("fail_msg"),
    creditsConsumed: numeric("credits_consumed", { precision: 12, scale: 4 }),
    costTimeRaw: bigint("cost_time_raw", { mode: "number" }),
    callbackToken: text("callback_token").notNull(),
    submitAttempts: integer("submit_attempts").default(0).notNull(),
    submittedAt: ts("submitted_at"),
    lastPolledAt: ts("last_polled_at"),
    nextPollAt: ts("next_poll_at"),
    pollAttempts: integer("poll_attempts").default(0).notNull(),
    deadlineAt: ts("deadline_at").notNull(),
    completedAt: ts("completed_at"),
    createdAt: tsMs("created_at").defaultNow().notNull(),
    updatedAt: tsMs("updated_at").defaultNow().notNull(),
    deletedAt: ts("deleted_at"),
  },
  (t) => [
    uniqueIndex("runs_team_idem").on(t.teamId, t.idempotencyKey),
    uniqueIndex("runs_kie_task").on(t.kieTaskId),
    index("runs_team_project_created").on(t.teamId, t.projectId, t.createdAt),
    index("runs_open").on(t.status, t.nextPollAt),
  ],
);

/* One row per output: the gallery tile. Pre-created at submit so its id is
   stable from skeleton to picture. Denormalized so the gallery reads one table. */
export const results = pgTable(
  "results",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    index: integer("index").notNull(),
    teamId: text("team_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    productId: text("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
    /** image | video */
    kind: text("kind").notNull(),
    modelId: text("model_id").notNull(),
    modelLabel: text("model_label").notNull(),
    prompt: text("prompt").notNull(),
    /** CSS aspect-ratio the tile reserves, e.g. "16 / 9". */
    ratio: text("ratio").notNull(),
    meta: text("meta").notNull(),
    badge: text("badge"),
    settings: jsonb("settings").$type<Record<string, unknown>>().notNull(),
    /** running | completed | failed */
    status: text("status").default("running").notNull(),
    error: text("error"),
    /** The url KIE handed back; it expires. */
    sourceUrl: text("source_url"),
    /** The copy the team owns, once the mirror job has landed it. */
    key: text("key"),
    url: text("url"),
    lastFrameKey: text("last_frame_key"),
    kieUrl: text("kie_url"),
    kieUrlExpiresAt: ts("kie_url_expires_at"),
    /** none | queued | done | failed */
    mirrorStatus: text("mirror_status").default("none").notNull(),
    mirrorAttempts: integer("mirror_attempts").default(0).notNull(),
    mirrorError: text("mirror_error"),
    bytes: bigint("bytes", { mode: "number" }),
    mime: text("mime"),
    width: integer("width"),
    height: integer("height"),
    durationMs: integer("duration_ms"),
    favorite: boolean("favorite").default(false).notNull(),
    favoritedBy: text("favorited_by"),
    tags: jsonb("tags").$type<string[]>().default([]).notNull(),
    /** winner | testing | killed — the team's call on the creative; null until
        someone makes it. Team-wide, like a favorite, and filterable. */
    verdict: text("verdict"),
    verdictBy: text("verdict_by"),
    verdictAt: ts("verdict_at"),
    /** Why, in the team's words; the action caps it at 500 characters. */
    note: text("note"),
    createdAt: tsMs("created_at").defaultNow().notNull(),
    updatedAt: tsMs("updated_at").defaultNow().notNull(),
    deletedAt: ts("deleted_at"),
    deletedBy: text("deleted_by"),
  },
  (t) => [
    uniqueIndex("results_run_index").on(t.runId, t.index),
    index("results_team_created").on(t.teamId, t.createdAt, t.id),
    index("results_team_project_created").on(t.teamId, t.projectId, t.createdAt, t.id),
    index("results_team_product_created").on(t.teamId, t.productId, t.createdAt),
    index("results_team_user_created").on(t.teamId, t.userId, t.createdAt),
    index("results_team_updated").on(t.teamId, t.updatedAt),
    index("results_team_verdict").on(t.teamId, t.verdict),
    index("results_mirror").on(t.mirrorStatus),
  ],
);

/* Durable work: submitting a run KIE was too busy for, reconciling a task,
   copying a result home, purging what was deleted. Claimed with SKIP LOCKED. */
export const jobs = pgTable(
  "jobs",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id").references(() => organization.id, { onDelete: "cascade" }),
    /** submit_run | reconcile_run | mirror_result | purge_media */
    type: text("type").notNull(),
    dedupeKey: text("dedupe_key").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    /** queued | running | done | failed | dead */
    status: text("status").default("queued").notNull(),
    attempts: integer("attempts").default(0).notNull(),
    maxAttempts: integer("max_attempts").default(6).notNull(),
    runAfter: ts("run_after").defaultNow().notNull(),
    lockedUntil: ts("locked_until"),
    lockedBy: text("locked_by"),
    lastError: text("last_error"),
    createdAt: ts("created_at").defaultNow().notNull(),
    updatedAt: ts("updated_at").defaultNow().notNull(),
  },
  (t) => [uniqueIndex("jobs_type_dedupe").on(t.type, t.dedupeKey), index("jobs_queue").on(t.status, t.runAfter)],
);

/* Every callback KIE sent, whether or not it was believed. Replays are no-ops. */
export const webhookReceipts = pgTable(
  "webhook_receipts",
  {
    id: text("id").primaryKey(),
    kieTaskId: text("kie_task_id").notNull(),
    runId: text("run_id"),
    tsHeader: text("ts_header").notNull(),
    signatureValid: boolean("signature_valid").notNull(),
    tokenValid: boolean("token_valid").notNull(),
    body: jsonb("body"),
    receivedAt: ts("received_at").defaultNow().notNull(),
  },
  (t) => [uniqueIndex("receipts_task_ts").on(t.kieTaskId, t.tsHeader)],
);

/* Append-only timeline per run: what happened and when. */
export const runEvents = pgTable(
  "run_events",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    teamId: text("team_id").notNull(),
    type: text("type").notNull(),
    payload: jsonb("payload"),
    at: ts("at").defaultNow().notNull(),
  },
  (t) => [index("run_events_run").on(t.runId, t.at)],
);

/* Credits KIE reported per run, attributed to who pressed Generate. */
export const creditLedger = pgTable(
  "credit_ledger",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    runId: text("run_id").notNull(),
    projectId: text("project_id").notNull(),
    productId: text("product_id").notNull(),
    userId: text("user_id"),
    credits: numeric("credits", { precision: 12, scale: 4 }).notNull(),
    recordedAt: ts("recorded_at").defaultNow().notNull(),
  },
  (t) => [uniqueIndex("ledger_run").on(t.runId), index("ledger_team_user").on(t.teamId, t.userId, t.recordedAt)],
);

/* The lines a direct-response team writes hundreds of times — hooks, product
   shots, end cards — kept once. Team-wide, or scoped to one product; the body
   may hold {{variables}} the composer fills at insert. */
export const promptTemplates = pgTable(
  "prompt_templates",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    /** Null means any product. */
    productId: text("product_id").references(() => products.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    body: text("body").notNull(),
    tags: jsonb("tags").$type<string[]>().default([]).notNull(),
    /** image | video | any */
    surface: text("surface").default("any").notNull(),
    /** Times the body was inserted into a prompt. */
    uses: integer("uses").default(0).notNull(),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: ts("created_at").defaultNow().notNull(),
    updatedAt: ts("updated_at").defaultNow().notNull(),
  },
  (t) => [index("prompt_templates_team_product").on(t.teamId, t.productId)],
);

/* KIE allows 20 task creations per 10 s per account. One row per key. */
export const rateBuckets = pgTable("rate_buckets", {
  key: text("key").primaryKey(),
  tokens: numeric("tokens", { precision: 8, scale: 3 }).notNull(),
  updatedAt: ts("updated_at").defaultNow().notNull(),
});

/* ---------- agents ---------- */

/* A Claude Code skill the team uploaded as a zip: SKILL.md, scripts,
   references, agents/*.md. The worker installs it under the team's own HOME.
   Skills are code that runs as the worker user, so only admins upload. */
export const skills = pgTable(
  "skills",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** Folder name on the worker; one per team. */
    slug: text("slug").notNull(),
    description: text("description").notNull(),
    version: text("version"),
    compatibility: text("compatibility"),
    /** Subagent names found in agents/*.md. */
    agents: jsonb("agents").$type<string[]>().default([]).notNull(),
    files: integer("files").default(0).notNull(),
    sizeBytes: integer("size_bytes").default(0).notNull(),
    /** The normalised zip in the media store; a new key for every upload. */
    storageKey: text("storage_key").notNull(),
    /** ready | invalid */
    status: text("status").default("ready").notNull(),
    problems: jsonb("problems").$type<string[]>().default([]).notNull(),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: ts("created_at").defaultNow().notNull(),
  },
  (t) => [uniqueIndex("skills_team_slug").on(t.teamId, t.slug)],
);

/* One agent session: a skill run against a brief inside a project. Queued
   until a worker claims it; the worker renews the lease while it works, so a
   run whose worker died is re-claimed rather than lost. The skill's name and
   slug are kept on the row because the skill may be removed later. */
export const agentRuns = pgTable(
  "agent_runs",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    productId: text("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    skillId: text("skill_id").references(() => skills.id, { onDelete: "set null" }),
    skillName: text("skill_name").notNull(),
    skillSlug: text("skill_slug").notNull(),
    title: text("title").notNull(),
    brief: text("brief").notNull(),
    /** queued | running | waiting | stopping | stopped | done | failed */
    status: text("status").default("queued").notNull(),
    /** The Agent SDK session, once the first turn answered. */
    sessionId: text("session_id"),
    /** The run's working directory on the worker. */
    workspace: text("workspace"),
    costUsd: numeric("cost_usd", { precision: 12, scale: 4 }).default("0").notNull(),
    credits: numeric("credits", { precision: 12, scale: 4 }).default("0").notNull(),
    /** Highest event seq written; appendEvent bumps it in the same statement. */
    lastSeq: integer("last_seq").default(0).notNull(),
    error: text("error"),
    workerId: text("worker_id"),
    leaseUntil: ts("lease_until"),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: ts("created_at").defaultNow().notNull(),
    updatedAt: ts("updated_at").defaultNow().notNull(),
    startedAt: ts("started_at"),
    endedAt: ts("ended_at"),
  },
  (t) => [index("agent_runs_team_created").on(t.teamId, t.createdAt), index("agent_runs_lease").on(t.status, t.leaseUntil)],
);

/* Everything the worker tells the studio about a run, numbered per run so a
   client resumes from the last seq it saw. */
export const agentEvents = pgTable(
  "agent_events",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    at: ts("at").defaultNow().notNull(),
    /** Set on a subagent's events: the Task tool_use they belong under. */
    parentToolUseId: text("parent_tool_use_id"),
    payload: jsonb("payload").$type<AgentEventPayload>().notNull(),
  },
  (t) => [uniqueIndex("agent_events_run_seq").on(t.runId, t.seq)],
);

/* What people send into a run — messages, answers, approvals, stop — taken
   by the worker in order and marked consumed once. */
export const agentInputs = pgTable(
  "agent_inputs",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: ts("created_at").defaultNow().notNull(),
    consumedAt: ts("consumed_at"),
    payload: jsonb("payload").$type<AgentInputPayload>().notNull(),
  },
  (t) => [index("agent_inputs_run_consumed").on(t.runId, t.consumedAt)],
);

/* A file the run produced, copied into the media store; one row per path,
   the latest version. `result_id` once it went up on the wall. */
export const agentArtifacts = pgTable(
  "agent_artifacts",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    teamId: text("team_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    /** Relative to the run's workspace. */
    path: text("path").notNull(),
    /** image | video | audio | document | other */
    fileKind: text("file_kind").notNull(),
    storageKey: text("storage_key").notNull(),
    url: text("url").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).default(0).notNull(),
    /** Pixel size when the worker could read it, so the wall tile keeps its shape. */
    width: integer("width"),
    height: integer("height"),
    resultId: text("result_id").references(() => results.id, { onDelete: "set null" }),
    createdAt: ts("created_at").defaultNow().notNull(),
  },
  (t) => [uniqueIndex("agent_artifacts_run_path").on(t.runId, t.path)],
);
