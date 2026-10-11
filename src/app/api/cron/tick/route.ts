import { timingSafeEqual } from "node:crypto";
import { and, eq, lt, lte } from "drizzle-orm";
import { NextResponse } from "next/server";

import { db, dbReady, schema } from "@/server/db/client";
import { enqueue, recoverMirrors } from "@/server/jobs/queue";
import { runJobs } from "@/server/jobs/runner";
import { openForSubmit } from "@/server/runs";

export const runtime = "nodejs";
export const maxDuration = 60;

/* The safety net, once a minute: every submitted run that is due a look gets
   a reconcile job, and the queue is drained. Nothing is lost to a closed tab. */
export async function GET(request: Request): Promise<NextResponse> {
  const secret = process.env.CRON_SECRET?.trim();
  const given = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!secret && process.env.NODE_ENV === "production") {
    /* A misconfigured deployment must show up in the cron log, not answer quietly. */
    console.error("[cron] CRON_SECRET is not set; the safety net is off");
    return NextResponse.json({ error: "CRON_SECRET is not set" }, { status: 500 });
  }
  if (secret && !sameSecret(given, secret)) return new NextResponse(null, { status: 401 });
  let stage = "database_ready";
  try {
    await dbReady();
    stage = "find_due_runs";
    const due = await db.query.runs.findMany({
      where: and(eq(schema.runs.status, "submitted"), lte(schema.runs.nextPollAt, new Date())),
      columns: { id: true, teamId: true },
      limit: 100,
    });
    stage = "queue_reconciliation";
    for (const run of due) await enqueue("reconcile_run", run.id, { runId: run.id }, { teamId: run.teamId });
    /* A run claimed for submit and never released is a submitter that died. */
    stage = "find_pending_runs";
    const pending = await db.query.runs.findMany({
      where: openForSubmit(),
      columns: { id: true, teamId: true },
      limit: 100,
    });
    stage = "queue_submissions";
    for (const run of pending) await enqueue("submit_run", run.id, { runId: run.id }, { teamId: run.teamId });
    /* Uploads that never arrived: the ticket is fifteen minutes, a day is plenty. */
    stage = "expire_uploads";
    const stale = await db
      .update(schema.assets)
      .set({ status: "failed" })
      .where(and(eq(schema.assets.status, "pending"), lt(schema.assets.createdAt, new Date(Date.now() - 24 * 60 * 60_000))))
      .returning();
    for (const asset of stale) await enqueue("purge_media", asset.key, { key: asset.key }, { teamId: asset.teamId });
    stage = "recover_media";
    const recovered = await recoverMirrors();
    stage = "run_jobs";
    const ran = await runJobs(200);
    return NextResponse.json({ due: due.length, pending: pending.length, stale: stale.length, recovered, ran });
  } catch (caught) {
    // This route is operator-authenticated; return only a stage and error code,
    // never query text, parameters, credentials or generation contents.
    const failure = { error: "Maintenance failed", stage, code: failureCode(caught) };
    console.error("[cron]", failure);
    return NextResponse.json(failure, { status: 500 });
  }
}

function sameSecret(given: string, secret: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

function failureCode(caught: unknown): string {
  let current = caught;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth++) {
    const error = current as { code?: unknown; cause?: unknown };
    if (typeof error.code === "string" && /^[A-Z0-9_]{2,40}$/.test(error.code)) return error.code;
    current = error.cause;
  }
  return "UNKNOWN";
}
