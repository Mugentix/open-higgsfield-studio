import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";

import { db, dbReady, schema } from "@/server/db/client";
import { enqueue } from "@/server/jobs/queue";
import { kickJobs } from "@/server/jobs/runner";

export const runtime = "nodejs";

const TIMESTAMP_TOLERANCE_S = 300;
const MAX_BODY_BYTES = 64 * 1024;

/* KIE posts here when a task ends. The signature covers only the task id and
   the timestamp, so nothing in the body is believed: a receipt is kept, the
   run's own url token is checked, and recordInfo is asked for the truth. */
export async function POST(request: Request): Promise<NextResponse> {
  await dbReady();
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return NextResponse.json({ error: "Body too large" }, { status: 413 });
  const url = new URL(request.url);
  const runId = url.searchParams.get("run") ?? "";
  const token = url.searchParams.get("t") ?? "";
  const ts = request.headers.get("x-webhook-timestamp") ?? "";
  const signature = request.headers.get("x-webhook-signature") ?? "";

  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Expected JSON" }, { status: 400 });
  }
  const data = (body.data ?? {}) as Record<string, unknown>;
  const taskId = String(data.taskId ?? data.task_id ?? body.taskId ?? "");
  if (!taskId || !runId) return NextResponse.json({ error: "Missing task or run id" }, { status: 400 });

  const run = await db.query.runs.findFirst({ where: eq(schema.runs.id, runId) });
  const tokenValid = Boolean(run && run.callbackToken === token && run.kieTaskId === taskId);
  const signatureValid = verifySignature(taskId, ts, signature);

  /* Only a caller who holds the run's own token leaves a trace; anyone else
     could otherwise fill the table with whatever they like. */
  if (!tokenValid) return NextResponse.json({ error: "Unknown run" }, { status: 401 });
  await db
    .insert(schema.webhookReceipts)
    .values({ id: randomUUID(), kieTaskId: taskId, runId: run!.id, tsHeader: ts || "-", signatureValid, tokenValid, body })
    .onConflictDoNothing();

  if (hmacConfigured() && !signatureValid) return NextResponse.json({ error: "Bad signature" }, { status: 401 });

  await enqueue("reconcile_run", run!.id, { runId: run!.id }, { teamId: run!.teamId });
  kickJobs();
  return NextResponse.json({ status: "received" });
}

function hmacConfigured(): boolean {
  return Boolean(process.env.KIE_WEBHOOK_HMAC_KEY?.trim());
}

/** base64(HMAC-SHA256(key, `${taskId}.${timestamp}`)) within five minutes. */
export function verifySignature(taskId: string, ts: string, signature: string): boolean {
  const key = process.env.KIE_WEBHOOK_HMAC_KEY?.trim();
  if (!key || !ts || !signature) return false;
  const seconds = Number(ts);
  if (!Number.isFinite(seconds) || Math.abs(Date.now() / 1000 - seconds) > TIMESTAMP_TOLERANCE_S) return false;
  const expected = Buffer.from(createHmac("sha256", key).update(`${taskId}.${ts}`).digest("base64"));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
