import { randomBytes } from "node:crypto";
import os from "node:os";

import type { ActiveRuns, LoopDeps } from "../../worker/loop";
import { dbReady } from "./db/client";
import { mediaStore } from "./storage";

/* A local checkout is one process: the embedded database admits a single
   one, so `pnpm agent-worker` cannot run beside `pnpm dev`. With
   AGENT_DEV_WORKER=1 the dev server hosts the worker's loop itself — the
   same pass, store, runtimes and home layout as worker/main.ts, on the same
   rhythm — so a run started on /agents is picked up here. Never in
   production, where the worker is its own process on its own box. The
   worker's modules load on demand, so a server that did not ask carries
   none of them. */

declare global {
  // eslint-disable-next-line no-var
  var __ohfAgentDevWorker: boolean | undefined;
}

/** Starts the loop once per process when the flag is up; a no-op otherwise. */
export function startAgentDevWorker(): void {
  if (process.env.NODE_ENV === "production" || process.env.AGENT_DEV_WORKER !== "1") return;
  if (globalThis.__ohfAgentDevWorker) return;
  globalThis.__ohfAgentDevWorker = true;
  void loop().catch((caught: unknown) => {
    globalThis.__ohfAgentDevWorker = false;
    console.error("[agent-worker] stopped:", caught instanceof Error ? caught.message : caught);
  });
}

async function loop(): Promise<void> {
  const [{ coreStore }, { teamCredentials }, { dotEnvFiles, homeRootProblem, readConfig }, { createLogger }, { workerTick }, { Masker }, { storeReader }, { selectRuntime }] =
    await Promise.all([
      import("../../worker/core-store"),
      import("../../worker/credentials"),
      import("../../worker/env"),
      import("../../worker/log"),
      import("../../worker/loop"),
      import("../../worker/mask"),
      import("../../worker/objects"),
      import("../../worker/runtimes/select"),
    ]);
  const config = readConfig(process.env);
  /* The dev server runs from the checkout; the agent's HOMEs may not. */
  const problem = homeRootProblem(config.homeRoot, process.cwd(), await dotEnvFiles(process.cwd()));
  if (problem) throw new Error(problem);
  await dbReady();
  const workerId = `dev-${os.hostname()}-${process.pid}-${randomBytes(3).toString("hex")}`;
  const log = createLogger(new Masker(process.env), { level: config.logLevel, fields: { worker: workerId } });
  const media = mediaStore();
  const runtime = await selectRuntime(config);
  log.info("agent worker up inside the dev server", {
    runtime: runtime.name,
    concurrency: config.concurrency,
    homeRoot: config.homeRoot,
    media: media.kind,
    anthropicKey: Boolean(process.env.ANTHROPIC_API_KEY?.trim()),
  });
  const deps: LoopDeps = {
    store: coreStore(),
    media,
    objects: storeReader(media),
    runtime,
    homeRoot: config.homeRoot,
    workerId,
    credentials: teamCredentials,
    processEnv: process.env,
    /* The dev server has no graceful stop of its own; a run it held is
       reclaimed by the next process once the lease runs out. */
    signal: new AbortController().signal,
    log,
    concurrency: config.concurrency,
  };
  const active: ActiveRuns = new Map();
  for (;;) {
    await workerTick(deps, active);
    await new Promise((resolve) => setTimeout(resolve, config.pollMs));
  }
}
