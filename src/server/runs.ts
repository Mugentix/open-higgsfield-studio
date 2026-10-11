import { randomBytes, randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, lt, lte, or, sql } from "drizzle-orm";

import { getModel, parseSettings, type GenerationPlane } from "@/generation/catalog";
import { KieError, createKieClient, type KieRecord } from "@/generation/kie/client";
import { readTeamCredentials, type PlatformCredentials } from "@/generation/server/credentials-store";
import { toKie } from "@/generation/to-kie";
import { durationBadge, metaOf, ratioToCss } from "@/openhiggsfield/data";

import { db, schema } from "./db/client";
import { enqueue } from "./jobs/queue";
import { bucketKeyFor, takeToken } from "./rate-limit";
import { extensionFor, mediaStore, resultKey, resultUrl } from "./storage";
import { isSafeKey } from "./storage/keys";
import type { TeamContext } from "./team";

/* A run is a row before it is a KIE task. Everything paid for is recorded
   first, submitted second, reconciled from recordInfo (never from a callback
   body), and copied home the moment KIE finishes. Every write that ends a
   state is guarded by the state it leaves, so a poll racing a callback is a
   no-op rather than a double. */

export type ResultView = {
  id: string;
  index: number;
  status: "running" | "completed" | "failed";
  url: string | null;
  mirrored: boolean;
  error?: string;
};

export type RunView = {
  requestId: string;
  status: "running" | "completed" | "failed";
  /** Past the model's deadline without an answer; still checked, less often. */
  stalled: boolean;
  error?: string;
  creditsConsumed?: number;
  results: ResultView[];
};

/* Images land in half a minute, videos in minutes: quick looks first, then
   the cadence relaxes so a long render does not cost a call every few seconds. */
const POLL_BACKOFF_MS = [5_000, 5_000, 8_000, 8_000, 10_000, 10_000, 15_000, 20_000, 30_000, 60_000] as const;

/** A submit that must wait — for the account's bucket, or for KIE to recover.
    Whoever called decides how: the job runner reschedules its own row, an
    inline caller queues a submit job. */
export class RetryLaterError extends Error {
  readonly retryAfterMs: number;
  constructor(message: string, retryAfterMs: number) {
    super(message);
    this.name = "RetryLaterError";
    this.retryAfterMs = retryAfterMs;
  }
}

/** submitRun for callers with no job of their own: a wait becomes a job. */
export async function submitOrQueue(runId: string, teamId: string): Promise<void> {
  try {
    await submitRun(runId);
  } catch (caught) {
    if (!(caught instanceof RetryLaterError)) throw caught;
    await enqueue("submit_run", runId, { runId }, { teamId, runAfter: new Date(Date.now() + caught.retryAfterMs) });
  }
}
const STALLED_POLL_MS = 5 * 60_000;
const LOST_AFTER_MS = 24 * 60 * 60_000;
const MAX_SUBMIT_ATTEMPTS = 5;
const SYNC_REFRESH_BUDGET = 5;
const KIE_SCRATCH_TTL_MS = 20 * 60 * 60_000;
/* Result rows are stamped by the database clock, never by whichever instance
   wrote them: the change feed orders by updated_at and must see one clock. */
const DB_NOW = sql`now()`;

type RunRow = typeof schema.runs.$inferSelect;
type ResultRow = typeof schema.results.$inferSelect;

/* ---------- projects ---------- */

/** Every team starts with a General product and an Inbox project, made on
    first use so older teams get them too. */
export async function ensureDefaultProject(team: Pick<TeamContext, "teamId" | "userId">) {
  let product = await db.query.products.findFirst({
    where: and(eq(schema.products.teamId, team.teamId), eq(schema.products.slug, "general")),
  });
  if (!product) {
    const [made] = await db
      .insert(schema.products)
      .values({ id: randomUUID(), teamId: team.teamId, name: "General", slug: "general", createdBy: team.userId })
      .onConflictDoNothing()
      .returning();
    product =
      made ??
      (await db.query.products.findFirst({
        where: and(eq(schema.products.teamId, team.teamId), eq(schema.products.slug, "general")),
      }));
  }
  if (!product) throw new Error("Could not make the default product");
  let project = await db.query.projects.findFirst({
    where: and(eq(schema.projects.productId, product.id), eq(schema.projects.slug, "inbox")),
  });
  if (!project) {
    const [made] = await db
      .insert(schema.projects)
      .values({
        id: randomUUID(),
        teamId: team.teamId,
        productId: product.id,
        name: "Inbox",
        slug: "inbox",
        createdBy: team.userId,
      })
      .onConflictDoNothing()
      .returning();
    project =
      made ??
      (await db.query.projects.findFirst({
        where: and(eq(schema.projects.productId, product.id), eq(schema.projects.slug, "inbox")),
      }));
  }
  if (!project) throw new Error("Could not make the default project");
  return { product, project };
}

export async function resolveProject(team: TeamContext, projectId: string | undefined) {
  if (projectId) {
    const project = await db.query.projects.findFirst({
      where: and(eq(schema.projects.id, projectId), eq(schema.projects.teamId, team.teamId)),
    });
    if (!project) throw new Error("No such project");
    return project;
  }
  return (await ensureDefaultProject(team)).project;
}

/* ---------- inputs ---------- */

/** The url KIE will be told to fetch for each attached item. A public store
    serves its own urls; a private one (the local checkout) mints a copy on
    KIE's scratch service, kept for the day it lives. Items that are neither a
    team asset nor a team result pass through as they are. */
async function resolveInputs(
  team: TeamContext,
  plane: GenerationPlane,
  credentials: PlatformCredentials,
): Promise<GenerationPlane> {
  const store = mediaStore();
  const media: GenerationPlane["media"] = {};
  const forAsset = (asset: typeof schema.assets.$inferSelect) =>
    store.public
      ? Promise.resolve(asset.url)
      : scratchUrl(credentials, asset.key, asset.kieUrl, asset.kieUrlExpiresAt, (kieUrl, at) =>
          db.update(schema.assets).set({ kieUrl, kieUrlExpiresAt: at }).where(eq(schema.assets.id, asset.id)),
        );
  const forResult = (result: typeof schema.results.$inferSelect, fallback: string) =>
    result.key && !store.public
      ? scratchUrl(credentials, result.key, result.kieUrl, result.kieUrlExpiresAt, (kieUrl, at) =>
          db.update(schema.results).set({ kieUrl, kieUrlExpiresAt: at }).where(eq(schema.results.id, result.id)),
        )
      : Promise.resolve(resultUrl(result) ?? fallback);
  for (const [role, items] of Object.entries(plane.media)) {
    if (!items) continue;
    const resolved = [];
    for (const item of items) {
      let url = item.url;
      if (item.assetId) {
        const asset = await db.query.assets.findFirst({
          where: and(eq(schema.assets.id, item.assetId), eq(schema.assets.teamId, team.teamId)),
        });
        if (!asset) throw new Error("An attached file is not in this team");
        url = await forAsset(asset);
      } else if (item.resultId) {
        const result = await db.query.results.findFirst({
          where: and(eq(schema.results.id, item.resultId), eq(schema.results.teamId, team.teamId)),
        });
        if (!result) throw new Error("An attached result is not in this team");
        url = await forResult(result, url);
      } else {
        /* A bare url of our own store arrives without a lineage — the picker's
           generations shelf hands results over that way — and a private or
           local store's url is not one KIE can fetch. The key names the row,
           so the file gets the same scratch copy an attached asset would.
           Anything foreign is sent as typed. */
        const key = ownKey(store.publicUrl(""), url);
        if (key) {
          const asset = await db.query.assets.findFirst({
            where: and(eq(schema.assets.key, key), eq(schema.assets.teamId, team.teamId)),
          });
          if (asset) url = await forAsset(asset);
          else {
            const result = await db.query.results.findFirst({
              where: and(eq(schema.results.key, key), eq(schema.results.teamId, team.teamId)),
            });
            if (result) url = await forResult(result, url);
          }
        }
      }
      resolved.push({ ...item, url });
    }
    media[role as keyof GenerationPlane["media"]] = resolved;
  }
  return { ...plane, media };
}

/** The store key behind one of our own media urls (absolute, or the app's
    relative /media/ path), or null for a url that is not ours. */
function ownKey(base: string, url: string): string | null {
  const path = url.startsWith(base) ? url.slice(base.length) : url.startsWith("/media/") ? url.slice("/media/".length) : null;
  if (!path) return null;
  const key = path.split(/[?#]/)[0] ?? "";
  return isSafeKey(key) ? key : null;
}

async function scratchUrl(
  credentials: PlatformCredentials,
  key: string,
  cached: string | null,
  cachedUntil: Date | null,
  remember: (url: string, expiresAt: Date) => Promise<unknown>,
): Promise<string> {
  if (cached && cachedUntil && cachedUntil.getTime() > Date.now() + 60 * 60_000) return cached;
  const store = mediaStore();
  const response = await fetch(store.publicUrl(key), { redirect: "manual" });
  const type = response.headers.get("content-type") ?? "";
  if (!response.ok || response.redirected || type.startsWith("text/")) {
    throw new Error("Could not read the attached file");
  }
  const blob = await response.blob();
  const kie = createKieClient(credentials);
  const name = key.split("/").pop() ?? "input";
  const { url } = await kie.uploadStream(blob, name, "openhiggsfield/inputs");
  const expiresAt = new Date(Date.now() + KIE_SCRATCH_TTL_MS);
  await remember(url, expiresAt);
  return url;
}

/* ---------- create ---------- */

export type CreateRunInput = {
  plane: GenerationPlane;
  idempotencyKey: string;
  projectId?: string;
  batchId?: string;
  parentResultId?: string;
};

export type CreatedRun = { requestId: string; resultIds: string[] };

/** The row, the tiles, then KIE. A retry with the same idempotency key finds
    the row it made before and never submits twice. */
export async function createRun(team: TeamContext, input: CreateRunInput): Promise<CreatedRun> {
  const existing = await db.query.runs.findFirst({
    where: and(eq(schema.runs.teamId, team.teamId), eq(schema.runs.idempotencyKey, input.idempotencyKey)),
    with: { results: { orderBy: asc(schema.results.index) } },
  });
  if (existing) return { requestId: existing.id, resultIds: existing.results.map((r) => r.id) };

  const model = getModel(input.plane.model);
  const plane: GenerationPlane = { ...input.plane, settings: parseSettings(model, input.plane.settings) };
  const project = await resolveProject(team, input.projectId);
  /* Lineage ids are trusted only once they are seen to be the team's own. */
  if (input.parentResultId) {
    const parent = await db.query.results.findFirst({
      where: and(eq(schema.results.id, input.parentResultId), eq(schema.results.teamId, team.teamId)),
      columns: { id: true },
    });
    if (!parent) throw new Error("No such result");
  }
  if (input.batchId && !/^[A-Za-z0-9_-]{8,64}$/.test(input.batchId)) throw new Error("Invalid batch");
  const credentials = await readTeamCredentials(team.teamId);
  const request = toKie(await resolveInputs(team, plane, credentials));

  const expectedCount = model.countKey ? Math.max(1, Number(plane.settings[model.countKey]) || 1) : 1;
  const ratio = ratioToCss(plane.settings.aspectRatio, model.surface === "image" ? "4 / 3" : "16 / 9");
  const meta = metaOf(model, plane.settings);
  const badge = model.surface === "video" ? durationBadge(plane.settings) : undefined;
  const runId = randomUUID();
  const resultIds = Array.from({ length: expectedCount }, () => randomUUID());
  const deadlineAt = new Date(Date.now() + (model.kie.deadlineMs ?? 10 * 60_000));
  const media = Object.values(plane.media)
    .flat()
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .map((item) => ({ role: item.role, url: item.url, assetId: item.assetId, resultId: item.resultId }));

  const inserted = await db.transaction(async (tx) => {
    const [run] = await tx
      .insert(schema.runs)
      .values({
        id: runId,
        teamId: team.teamId,
        projectId: project.id,
        productId: project.productId,
        userId: team.userId,
        batchId: input.batchId ?? null,
        parentResultId: input.parentResultId ?? null,
        idempotencyKey: input.idempotencyKey,
        surface: model.surface,
        modelId: model.id,
        modelLabel: model.label,
        kieModel: request.model,
        prompt: plane.prompt.text,
        settings: plane.settings,
        media,
        kieInput: request as unknown as Record<string, unknown>,
        expectedCount,
        callbackToken: randomBytes(18).toString("base64url"),
        deadlineAt,
      })
      .onConflictDoNothing()
      .returning();
    if (!run) return false;
    await tx.insert(schema.results).values(
      resultIds.map((id, index) => ({
        id,
        runId,
        index,
        teamId: team.teamId,
        projectId: project.id,
        productId: project.productId,
        userId: team.userId,
        kind: model.surface,
        modelId: model.id,
        modelLabel: model.label,
        prompt: plane.prompt.text,
        ratio,
        meta,
        badge: badge ?? null,
        settings: plane.settings,
      })),
    );
    await tx.insert(schema.runEvents).values({ id: randomUUID(), runId, teamId: team.teamId, type: "created", payload: { model: model.id } });
    return true;
  });

  if (!inserted) {
    const raced = await db.query.runs.findFirst({
      where: and(eq(schema.runs.teamId, team.teamId), eq(schema.runs.idempotencyKey, input.idempotencyKey)),
      with: { results: { orderBy: asc(schema.results.index) } },
    });
    if (!raced) throw new Error("The run could not be recorded");
    return { requestId: raced.id, resultIds: raced.results.map((r) => r.id) };
  }

  await db.update(schema.projects).set({ lastUsedAt: new Date() }).where(eq(schema.projects.id, project.id));
  await submitOrQueue(runId, team.teamId);
  return { requestId: runId, resultIds };
}

/* ---------- submit ---------- */

/** A claim on a pending run is held this long before another submitter may
    assume the holder died mid-call and take the run over. */
export const SUBMIT_CLAIM_STALE_MS = 2 * 60_000;

/** Runs a submitter may take: pending, or claimed by one that never let go. */
export function openForSubmit() {
  return or(
    eq(schema.runs.status, "pending"),
    and(eq(schema.runs.status, "submitting"), lt(schema.runs.updatedAt, new Date(Date.now() - SUBMIT_CLAIM_STALE_MS))),
  )!;
}

/** Hands a pending run to KIE if the account's bucket has a token; otherwise
    the submit job comes back when it does. A KIE refusal that a retry would
    not change fails the run with KIE's words.

    The run is claimed ('submitting') in one statement before KIE is called,
    so a studio poll and the job runner that both see it pending buy one task
    between them, not two. A wait hands the claim back; a hard refusal ends
    the run from the claim. */
export async function submitRun(runId: string): Promise<void> {
  const [run] = await db
    .update(schema.runs)
    .set({ status: "submitting", updatedAt: new Date() })
    .where(and(eq(schema.runs.id, runId), openForSubmit()))
    .returning();
  if (!run) return;
  const release = () =>
    db
      .update(schema.runs)
      .set({ status: "pending", updatedAt: new Date() })
      .where(and(eq(schema.runs.id, run.id), eq(schema.runs.status, "submitting")));

  let credentials: PlatformCredentials;
  let token: Awaited<ReturnType<typeof takeToken>>;
  try {
    credentials = await readTeamCredentials(run.teamId);
    token = await takeToken(bucketKeyFor(credentials.apiKey));
  } catch (caught) {
    await release();
    throw caught;
  }
  if (!token.granted) {
    await release();
    throw new RetryLaterError("KIE's rate limit is full; retrying shortly", token.retryAfterMs);
  }
  const kie = createKieClient(credentials);
  const request = run.kieInput as unknown as { model: string; input: Record<string, unknown> };
  let taskId: string;
  try {
    ({ taskId } = await kie.createTask({ ...request, ...callbackFor(run) }));
  } catch (caught) {
    /* KIE's own 429 is the bucket's job, not the run's: it waits without
       spending an attempt. */
    if (caught instanceof KieError && (caught.status === 429 || caught.code === 429)) {
      await release();
      throw new RetryLaterError(caught.message, 10_000);
    }
    const attempts = run.submitAttempts + 1;
    if (isRetryableSubmitError(caught) && attempts < MAX_SUBMIT_ATTEMPTS) {
      await db
        .update(schema.runs)
        .set({ status: "pending", submitAttempts: attempts, updatedAt: new Date() })
        .where(and(eq(schema.runs.id, run.id), eq(schema.runs.status, "submitting")));
      throw new RetryLaterError(caught instanceof Error ? caught.message : String(caught), 5_000 * 2 ** attempts);
    }
    await failRun(
      run.id,
      ["submitting"],
      caught instanceof Error ? caught.message : "KIE refused the task",
      caught instanceof KieError ? String(caught.code) : null,
    );
    return;
  }
  /* From here the task is paid for; a database hiccup must surface to the
     caller (and its retry ladder), never turn into failRun. */
  const [submitted] = await db
    .update(schema.runs)
    .set({
      status: "submitted",
      kieTaskId: taskId,
      kieState: "waiting",
      submittedAt: new Date(),
      submitAttempts: run.submitAttempts + 1,
      nextPollAt: new Date(Date.now() + POLL_BACKOFF_MS[0]),
      updatedAt: new Date(),
    })
    .where(and(eq(schema.runs.id, run.id), eq(schema.runs.status, "submitting")))
    .returning();
  if (!submitted) {
    /* Someone ended the run while KIE was creating the task (a stale-claim
       takeover, an operator). The task exists and is paid for; say so. */
    await event(run, "submit_orphaned", { taskId });
    return;
  }
  await event(run, "submitted", { taskId });
}

/** A refusal a retry might change: KIE's retryable codes, and a transport
    failure (reset, timeout) where no answer means nothing is known. */
function isRetryableSubmitError(caught: unknown): boolean {
  if (caught instanceof KieError) return caught.retryable;
  if (caught instanceof TypeError) return true;
  return caught instanceof Error && (caught.name === "AbortError" || caught.name === "TimeoutError");
}

function callbackFor(run: RunRow): { callBackUrl?: string } {
  const base = process.env.APP_PUBLIC_URL?.trim().replace(/\/$/, "");
  if (!base || !base.startsWith("https://")) return {};
  return { callBackUrl: `${base}/api/kie/callback?run=${run.id}&t=${run.callbackToken}` };
}

/* ---------- reconcile ---------- */

/** recordInfo is the only source of truth; a callback merely hurries this. */
export async function reconcileRun(runId: string): Promise<void> {
  const run = await db.query.runs.findFirst({ where: eq(schema.runs.id, runId) });
  if (!run || run.status !== "submitted" || !run.kieTaskId) return;
  const credentials = await readTeamCredentials(run.teamId);
  const kie = createKieClient(credentials);
  let record: KieRecord;
  try {
    record = await kie.recordInfo(run.kieTaskId);
  } catch (caught) {
    /* Our own failure to ask is never the run's failure. */
    await scheduleNextPoll(run, run.kieState, caught instanceof Error ? caught.message : String(caught));
    return;
  }
  await applyRecord(run, record);
}

export async function applyRecord(run: RunRow, record: KieRecord): Promise<void> {
  if (record.state === "success") {
    await settleSuccess(run, record);
    return;
  }
  if (record.state === "fail") {
    const why = record.failMsg || "the platform reported a failure";
    await failRun(
      run.id,
      ["submitted"],
      record.failCode && !why.includes(record.failCode) ? `${why} (${record.failCode})` : why,
      record.failCode || null,
    );
    return;
  }
  await scheduleNextPoll(run, record.state, null);
}

async function scheduleNextPoll(run: RunRow, kieState: string | null, error: string | null): Promise<void> {
  const now = Date.now();
  const submittedAt = run.submittedAt?.getTime() ?? run.createdAt.getTime();
  if (now - submittedAt > LOST_AFTER_MS) {
    await failRun(run.id, ["submitted"], "the platform never answered for this run", "LOST", "lost");
    return;
  }
  const stalled = now > run.deadlineAt.getTime();
  const wait = stalled ? STALLED_POLL_MS : POLL_BACKOFF_MS[Math.min(run.pollAttempts, POLL_BACKOFF_MS.length - 1)]!;
  await db
    .update(schema.runs)
    .set({
      kieState: kieState ?? run.kieState,
      lastPolledAt: new Date(now),
      nextPollAt: new Date(now + wait),
      pollAttempts: run.pollAttempts + 1,
      updatedAt: new Date(now),
    })
    .where(and(eq(schema.runs.id, run.id), eq(schema.runs.status, "submitted")));
  if (error) {
    /* A KIE outage would otherwise write one row per poll for a day; only a
       new message earns an event. */
    const last = await db.query.runEvents.findFirst({
      where: eq(schema.runEvents.runId, run.id),
      orderBy: desc(schema.runEvents.at),
      columns: { type: true, payload: true },
    });
    const same = last?.type === "poll_error" && (last.payload as { error?: string } | null)?.error === error.slice(0, 300);
    if (!same) await event(run, "poll_error", { error: error.slice(0, 300) });
  }
}

async function settleSuccess(run: RunRow, record: KieRecord): Promise<void> {
  const urls = record.resultUrls;
  await db.transaction(async (tx) => {
    const [claimed] = await tx
      .update(schema.runs)
      .set({
        status: "succeeded",
        kieState: "success",
        creditsConsumed: record.creditsConsumed !== undefined ? String(record.creditsConsumed) : null,
        costTimeRaw: record.costTime ?? null,
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(schema.runs.id, run.id), eq(schema.runs.status, "submitted")))
      .returning();
    if (!claimed) return null;

    const results = await tx.query.results.findMany({ where: eq(schema.results.runId, run.id), orderBy: asc(schema.results.index) });
    const toMirror: string[] = [];
    for (const [index, result] of results.entries()) {
      const url = urls[index];
      if (url) {
        await tx
          .update(schema.results)
          .set({ status: "completed", sourceUrl: url, mirrorStatus: "queued", error: null, updatedAt: DB_NOW })
          .where(eq(schema.results.id, result.id));
        toMirror.push(result.id);
      } else {
        await tx
          .update(schema.results)
          .set({ status: "failed", error: "the platform delivered fewer results than expected", updatedAt: DB_NOW })
          .where(eq(schema.results.id, result.id));
      }
    }
    /* More urls than tiles: the extra results still belong to the press. */
    for (let index = results.length; index < urls.length; index++) {
      const template = results[0];
      if (!template) break;
      const id = randomUUID();
      await tx.insert(schema.results).values({
        id,
        runId: run.id,
        index,
        teamId: run.teamId,
        projectId: run.projectId,
        productId: run.productId,
        userId: run.userId,
        kind: template.kind,
        modelId: template.modelId,
        modelLabel: template.modelLabel,
        prompt: template.prompt,
        ratio: template.ratio,
        meta: template.meta,
        badge: template.badge,
        settings: template.settings,
        status: "completed",
        sourceUrl: urls[index]!,
        mirrorStatus: "queued",
      });
      toMirror.push(id);
    }
    if (record.creditsConsumed !== undefined) {
      await tx
        .insert(schema.creditLedger)
        .values({
          id: randomUUID(),
          teamId: run.teamId,
          runId: run.id,
          projectId: run.projectId,
          productId: run.productId,
          userId: run.userId,
          credits: String(record.creditsConsumed),
        })
        .onConflictDoNothing();
    }
    await tx.insert(schema.runEvents).values({
      id: randomUUID(),
      runId: run.id,
      teamId: run.teamId,
      type: "succeeded",
      payload: { results: urls.length, credits: record.creditsConsumed ?? null },
    });
    // Completion and its durable-copy jobs commit together. A killed request
    // can no longer leave completed files with nothing for the worker to do.
    if (toMirror.length) {
      await tx.insert(schema.jobs).values(toMirror.map((resultId) => ({
        id: randomUUID(), teamId: run.teamId, type: "mirror_result", dedupeKey: resultId, payload: { resultId },
      }))).onConflictDoNothing();
    }
  });
}

async function failRun(
  runId: string,
  from: string[],
  message: string,
  code: string | null,
  status: "failed" | "lost" = "failed",
): Promise<void> {
  await db.transaction(async (tx) => {
    const [claimed] = await tx
      .update(schema.runs)
      .set({ status, failMsg: message, failCode: code, completedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(schema.runs.id, runId), inArray(schema.runs.status, from)))
      .returning();
    if (!claimed) return;
    await tx
      .update(schema.results)
      .set({ status: "failed", error: message, updatedAt: DB_NOW })
      .where(and(eq(schema.results.runId, runId), eq(schema.results.status, "running")));
    await tx.insert(schema.runEvents).values({ id: randomUUID(), runId, teamId: claimed.teamId, type: status, payload: { message, code } });
  });
}

async function event(run: RunRow, type: string, payload: Record<string, unknown>): Promise<void> {
  await db.insert(schema.runEvents).values({ id: randomUUID(), runId: run.id, teamId: run.teamId, type, payload });
}

/* ---------- mirror ---------- */

/** Copies one finished result from KIE's expiring url into the team's store.
    A stale url is refreshed through KIE's download-link endpoint once. */
export async function mirrorResult(resultId: string): Promise<void> {
  const result = await db.query.results.findFirst({ where: eq(schema.results.id, resultId) });
  if (!result || result.mirrorStatus === "done") return;
  if (!result.sourceUrl) throw new Error("Result has no source url");
  const credentials = await readTeamCredentials(result.teamId);
  try {
    let response = await fetch(result.sourceUrl);
    if (!response.ok && [403, 404, 410].includes(response.status)) {
      const fresh = await createKieClient(credentials).downloadUrl(result.sourceUrl);
      response = await fetch(fresh);
    }
    if (!response.ok || !response.body) throw new Error(`KIE answered ${response.status} for the result`);
    const contentType = response.headers.get("content-type") ?? "";
    const ext = extensionFor(contentType, result.sourceUrl);
    const mime = contentType.split(";")[0]?.trim() || undefined;
    const key = resultKey(result.teamId, result.projectId, result.runId, result.index, ext);
    const store = mediaStore();
    const { bytes } = await store.put(key, response.body, mime ?? "application/octet-stream");
    await db
      .update(schema.results)
      .set({ key, url: store.publicUrl(key), status: "completed", error: null, mirrorStatus: "done", mirrorError: null, bytes, mime: mime ?? null, updatedAt: DB_NOW })
      .where(and(eq(schema.results.id, result.id), sql`${schema.results.mirrorStatus} <> 'done'`));
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    await db
      .update(schema.results)
      .set({ mirrorStatus: "failed", mirrorAttempts: result.mirrorAttempts + 1, mirrorError: message.slice(0, 500), updatedAt: DB_NOW })
      .where(eq(schema.results.id, result.id));
    throw caught;
  }
}

/** The mirror job is buried: the tile can no longer pretend to be a picture
    KIE's expiring url will serve. The source url stays for support. */
export async function markMirrorLost(resultId: string): Promise<void> {
  await db
    .update(schema.results)
    .set({ status: "failed", error: "the platform's copy expired before it could be saved", updatedAt: DB_NOW })
    .where(and(eq(schema.results.id, resultId), sql`${schema.results.mirrorStatus} <> 'done'`));
}

export async function purgeMedia(key: string): Promise<void> {
  await mediaStore().remove(key);
}

/* ---------- sync (what the studio polls) ---------- */

/** Return database state promptly; slow provider calls run after the response.
    An open tab still hurries reconciliation, without blocking gallery actions. */
export async function syncRuns(team: TeamContext, runIds: string[]): Promise<RunView[]> {
  const due = await db.query.runs.findMany({
    where: and(
      eq(schema.runs.teamId, team.teamId),
      inArray(schema.runs.id, runIds),
      eq(schema.runs.status, "submitted"),
      lte(schema.runs.nextPollAt, new Date()),
    ),
    orderBy: asc(schema.runs.nextPollAt),
    limit: SYNC_REFRESH_BUDGET,
  });
  await Promise.all(due.map((run) => enqueue("reconcile_run", run.id, { runId: run.id }, { teamId: run.teamId })));
  const pending = await db.query.runs.findMany({
    where: and(eq(schema.runs.teamId, team.teamId), inArray(schema.runs.id, runIds), openForSubmit()),
    limit: SYNC_REFRESH_BUDGET,
  });
  await Promise.all(pending.map((run) => enqueue("submit_run", run.id, { runId: run.id }, { teamId: run.teamId })));

  const runs = await db.query.runs.findMany({
    where: and(eq(schema.runs.teamId, team.teamId), inArray(schema.runs.id, runIds)),
    with: { results: { orderBy: asc(schema.results.index) } },
  });
  return runs.map(viewOf);
}

export function viewOf(run: RunRow & { results: ResultRow[] }): RunView {
  const status = run.status === "succeeded" ? "completed" : run.status === "failed" || run.status === "lost" ? "failed" : "running";
  return {
    requestId: run.id,
    status,
    stalled: status === "running" && Date.now() > run.deadlineAt.getTime(),
    ...(run.failMsg ? { error: run.failMsg } : {}),
    ...(run.creditsConsumed !== null ? { creditsConsumed: Number(run.creditsConsumed) } : {}),
    results: run.results.map((result) => ({
      id: result.id,
      index: result.index,
      status: result.status as ResultView["status"],
      url: resultUrl(result),
      mirrored: result.mirrorStatus === "done",
      ...(result.error ? { error: result.error } : {}),
    })),
  };
}
