import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

import { db, schema } from "../db/client";
import { rows } from "../db/sql";

export type JobType = "submit_run" | "reconcile_run" | "mirror_result" | "purge_media";

export type Job = {
  id: string;
  teamId: string | null;
  type: JobType;
  dedupeKey: string;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
};

/** After a failure, how long until the next try: inside KIE's 24-hour url
    window at every rung, and long enough at the end for an outage to pass. */
export const RETRY_LADDER_MS = [30_000, 2 * 60_000, 10 * 60_000, 60 * 60_000, 6 * 60 * 60_000] as const;

export function backoffMs(attempt: number): number {
  return RETRY_LADDER_MS[Math.min(Math.max(attempt - 1, 0), RETRY_LADDER_MS.length - 1)]!;
}

const LEASE_SECONDS = 120;

/** Idempotent: the same (type, dedupe key) is one job. A finished job asked
    for again is reset and runs again; a running one is left alone. */
export async function enqueue(
  type: JobType,
  dedupeKey: string,
  payload: Record<string, unknown>,
  options: { teamId?: string | null; runAfter?: Date; maxAttempts?: number } = {},
): Promise<void> {
  const runAfter = options.runAfter ?? new Date();
  await db
    .insert(schema.jobs)
    .values({
      id: randomUUID(),
      teamId: options.teamId ?? null,
      type,
      dedupeKey,
      payload,
      runAfter,
      maxAttempts: options.maxAttempts ?? RETRY_LADDER_MS.length + 1,
    })
    .onConflictDoUpdate({
      target: [schema.jobs.type, schema.jobs.dedupeKey],
      set: {
        payload,
        runAfter: sql`CASE WHEN ${schema.jobs.status} = 'running' THEN ${schema.jobs.runAfter} ELSE ${runAfter} END`,
        status: sql`CASE WHEN ${schema.jobs.status} = 'running' THEN ${schema.jobs.status} ELSE 'queued' END`,
        attempts: sql`CASE WHEN ${schema.jobs.status} IN ('done', 'failed', 'dead') THEN 0 ELSE ${schema.jobs.attempts} END`,
        lastError: null,
        updatedAt: new Date(),
      },
    });
}

/** Takes up to `limit` due jobs for this worker, including ones whose lease
    ran out. SKIP LOCKED keeps two workers off the same row. */
export async function claim(limit: number, workerId: string): Promise<Job[]> {
  const claimed = await rows<{
    id: string;
    team_id: string | null;
    type: JobType;
    dedupe_key: string;
    payload: Record<string, unknown>;
    attempts: number;
    max_attempts: number;
    run_after: string | Date;
  }>(sql`
    UPDATE jobs SET
      status = 'running',
      locked_until = now() + (${LEASE_SECONDS} * interval '1 second'),
      locked_by = ${workerId},
      attempts = attempts + 1,
      updated_at = now()
    WHERE id IN (
      SELECT id FROM jobs
      WHERE (status = 'queued' AND run_after <= now())
         OR (status = 'running' AND locked_until < now())
      ORDER BY run_after, created_at
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, team_id, type, dedupe_key, payload, attempts, max_attempts, run_after
  `);
  /* RETURNING rows come back in no particular order; the oldest is worked first. */
  claimed.sort((a, b) => new Date(a.run_after).getTime() - new Date(b.run_after).getTime());
  return claimed.map((row) => ({
    id: row.id,
    teamId: row.team_id,
    type: row.type,
    dedupeKey: row.dedupe_key,
    payload: typeof row.payload === "string" ? (JSON.parse(row.payload) as Record<string, unknown>) : row.payload,
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
  }));
}

export async function complete(id: string): Promise<void> {
  await db.execute(sql`UPDATE jobs SET status = 'done', locked_until = NULL, locked_by = NULL, updated_at = now() WHERE id = ${id}`);
}

/** With `retryAfterMs` the handler only asked for time: the claim's attempt
    is handed back and the job can never be buried for waiting. */
export async function fail(job: Job, error: string, retryAfterMs?: number): Promise<"retry" | "dead"> {
  const waiting = retryAfterMs !== undefined;
  const dead = !waiting && job.attempts >= job.maxAttempts;
  const runAfter = new Date(Date.now() + (retryAfterMs ?? backoffMs(job.attempts)));
  await db.execute(sql`
    UPDATE jobs SET
      status = ${dead ? "dead" : "queued"},
      attempts = ${waiting ? sql`GREATEST(attempts - 1, 0)` : sql`attempts`},
      run_after = ${runAfter},
      locked_until = NULL,
      locked_by = NULL,
      last_error = ${error.slice(0, 1000)},
      updated_at = now()
    WHERE id = ${job.id}
  `);
  return dead ? "dead" : "retry";
}
