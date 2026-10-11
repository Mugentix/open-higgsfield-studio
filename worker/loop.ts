import type { AgentRunRecord } from "@/server/agents-contract";

import { runAgent, type RunDeps, type RunEnd } from "./run";

/* One pass of the worker's loop, apart from the process that repeats it:
   main.ts runs it every AGENT_POLL_MS until SIGTERM, the dev server hosts
   it on the same rhythm behind AGENT_DEV_WORKER=1, and a test runs it once
   to see a run claimed and started. */

export type LoopDeps = RunDeps & {
  /** Runs this process holds at once; a run waiting on a person holds its slot. */
  concurrency: number;
};

/** The runs this process holds, by id; a run leaves when it ends. */
export type ActiveRuns = Map<string, Promise<RunEnd | void>>;

/** Puts lost runs back in the queue, then claims and starts runs until this
    process holds `concurrency` of them or the queue is empty. Answers the
    runs it started this pass. */
export async function workerTick(deps: LoopDeps, active: ActiveRuns): Promise<AgentRunRecord[]> {
  const { store, log, signal } = deps;
  await store.reclaimStale().catch((caught: unknown) => log.warn("reclaim failed", { error: caught }));
  const started: AgentRunRecord[] = [];
  while (active.size < deps.concurrency && !signal.aborted) {
    let claimed: AgentRunRecord | null;
    try {
      claimed = await store.claimRun(deps.workerId);
    } catch (caught) {
      log.warn("claim failed", { error: caught });
      break;
    }
    if (!claimed) break;
    const run = claimed;
    log.info("claimed", { runId: run.id, teamId: run.teamId, skill: run.skillSlug, resumed: Boolean(run.sessionId) });
    const task = runAgent(run, deps)
      .catch((caught: unknown) => log.error("run crashed", { runId: run.id, error: caught }))
      .finally(() => active.delete(run.id));
    active.set(run.id, task);
    started.push(run);
  }
  return started;
}
