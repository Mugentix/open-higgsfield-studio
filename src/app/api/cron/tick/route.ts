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
  await dbReady();
  const due = await db.query.runs.findMany({
    where: and(eq(schema.runs.status, "submitted"), lte(schema.runs.nextPollAt, new Date())),
    columns: { id: true, teamId: true },
    limit: 100,
  });
  for (const run of due) await enqueue("reconcile_run", run.id, { runId: run.id }, { teamId: run.teamId });
  /* A run claimed for submit and never released is a submitter that died. */
  const pending = await db.query.runs.findMany({
    where: openForSubmit(),
    columns: { id: true, teamId: true },
    limit: 100,
  });
  for (const run of pending) await enqueue("submit_run", run.id, { runId: run.id }, { teamId: run.teamId });
  /* Uploads that never arrived: the ticket is fifteen minutes, a day is plenty. */
  const stale = await db
    .update(schema.assets)
    .set({ status: "failed" })
    .where(and(eq(schema.assets.status, "pending"), lt(schema.assets.createdAt, new Date(Date.now() - 24 * 60 * 60_000))))
    .returning();
  for (const asset of stale) await enqueue("purge_media", asset.key, { key: asset.key }, { teamId: asset.teamId });
  const recovered = await recoverMirrors();
  const ran = await runJobs(200);
  return NextResponse.json({ due: due.length, pending: pending.length, stale: stale.length, recovered, ran });
}

function sameSecret(given: string, secret: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}
