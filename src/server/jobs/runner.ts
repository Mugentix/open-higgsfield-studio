import { randomUUID } from "node:crypto";

import { RetryLaterError, markMirrorLost, mirrorResult, purgeMedia, reconcileRun, submitRun } from "../runs";
import { claim, complete, fail, type Job, type JobType } from "./queue";

type Handler = (job: Job) => Promise<void>;

const HANDLERS: Record<JobType, Handler> = {
  submit_run: (job) => submitRun(String(job.payload.runId)),
  reconcile_run: (job) => reconcileRun(String(job.payload.runId)),
  mirror_result: (job) => mirrorResult(String(job.payload.resultId)),
  purge_media: (job) => purgeMedia(String(job.payload.key)),
};

const WORKER_ID = `${process.pid}-${randomUUID().slice(0, 8)}`;
const BATCH = 5;
/* A drain frozen with the flag up (a serverless instance suspended mid-work)
   must not keep every later drain on that instance from running. */
export const DRAIN_LOCK_STALE_MS = 5 * 60_000;

declare global {
  // eslint-disable-next-line no-var
  var __ohfJobsRunning: boolean | undefined;
  // eslint-disable-next-line no-var
  var __ohfJobsRunningSince: number | undefined;
  // eslint-disable-next-line no-var
  var __ohfDevWorker: ReturnType<typeof setInterval> | undefined;
}

/** Drains due jobs, a batch at a time, until none are left or the cap is
    reached. One drain per process at a time; a second call is a no-op. */
export async function runJobs(maxJobs = 25): Promise<number> {
  const heldSince = globalThis.__ohfJobsRunningSince;
  if (globalThis.__ohfJobsRunning && (heldSince === undefined || Date.now() - heldSince < DRAIN_LOCK_STALE_MS)) return 0;
  globalThis.__ohfJobsRunning = true;
  globalThis.__ohfJobsRunningSince = Date.now();
  let done = 0;
  try {
    while (done < maxJobs) {
      const jobs = await claim(Math.min(BATCH, maxJobs - done), WORKER_ID);
      if (jobs.length === 0) break;
      await Promise.all(jobs.map(runOne));
      done += jobs.length;
    }
  } catch (caught) {
    console.error("[jobs] drain failed", caught instanceof Error ? caught.message : caught);
  } finally {
    globalThis.__ohfJobsRunning = false;
    globalThis.__ohfJobsRunningSince = undefined;
  }
  return done;
}

async function runOne(job: Job): Promise<void> {
  try {
    await HANDLERS[job.type](job);
    await complete(job.id);
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    /* A handler that only asks for a little more time is not a failure the
       ladder should punish: it names its own delay and keeps its attempts. */
    const wait = caught instanceof RetryLaterError ? caught.retryAfterMs : undefined;
    const outcome = await fail(job, message, wait);
    if (!wait) console.warn(`[jobs] ${job.type} ${job.dedupeKey} ${outcome}: ${message}`);
    /* A buried mirror leaves a tile whose only url is KIE's expiring one. */
    if (outcome === "dead" && job.type === "mirror_result") await markMirrorLost(String(job.payload.resultId));
  }
}

/** Runs the queue once the response is out, if a request is in scope;
    otherwise right away. Server actions and routes call this after they
    queue work, so the work never waits for a cron. */
export function kickJobs(): void {
  void import("next/server")
    .then(({ after }) => after(() => runJobs()))
    .catch(() => void runJobs());
  startDevWorker();
}

/** A local checkout has no cron; the process itself drains the queue every
    few seconds so a closed tab still gets its results copied home. */
export function startDevWorker(): void {
  if (process.env.NODE_ENV === "production" || globalThis.__ohfDevWorker) return;
  globalThis.__ohfDevWorker = setInterval(() => void runJobs(), 15_000);
  globalThis.__ohfDevWorker.unref?.();
}
