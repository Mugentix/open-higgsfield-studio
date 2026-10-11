import { randomBytes } from "node:crypto";
import os from "node:os";

import { dbKind, dbReady } from "@/server/db/client";
import { mediaStore } from "@/server/storage";

import { coreStore } from "./core-store";
import { teamCredentials } from "./credentials";
import { dotEnvFiles, homeRootProblem, readConfig } from "./env";
import { createLogger } from "./log";
import { workerTick, type ActiveRuns, type LoopDeps } from "./loop";
import { Masker } from "./mask";
import { storeReader } from "./objects";
import { selectRuntime } from "./runtimes/select";

/* The agent worker: a long-running Node process on a box with Python, ffmpeg
   and Whisper. It shares nothing with the web app but the database and the
   media store: it claims queued runs, drives them, writes events, and the
   studio polls. `corepack pnpm agent-worker` runs it from the repo root
   (the database and the local media store resolve against the cwd). The
   pass itself is in loop.ts; this file is the process around it. */

const SHUTDOWN_GRACE_MS = 20_000;

async function main(): Promise<void> {
  const config = readConfig(process.env);
  /* The agent's shell must not sit inside the checkout, next to its .env files. */
  const problem = homeRootProblem(config.homeRoot, process.cwd(), await dotEnvFiles(process.cwd()));
  if (problem) throw new Error(problem);
  const workerId = `${os.hostname()}-${process.pid}-${randomBytes(3).toString("hex")}`;
  const mask = new Masker(process.env);
  const log = createLogger(mask, { level: config.logLevel, fields: { worker: workerId } });

  /* The embedded PGlite admits one process and that process is the app
     (its dev server hosts the worker when AGENT_DEV_WORKER=1). A second
     opener would corrupt the data directory, so a standalone worker needs
     a Postgres of its own unless the operator says the app is not running. */
  if (dbKind() === "pglite" && process.env.AGENT_ALLOW_PGLITE !== "1") {
    throw new Error(
      "No DATABASE_URL: the standalone worker would open the embedded PGlite database that the app holds. " +
        "Run the worker inside the dev server (AGENT_DEV_WORKER=1 in .env.local, then pnpm dev), " +
        "point it at Postgres with DATABASE_URL, or set AGENT_ALLOW_PGLITE=1 when the app is not running.",
    );
  }
  await dbReady();
  const media = mediaStore();
  const runtime = await selectRuntime(config);
  log.info("worker up", {
    runtime: runtime.name,
    concurrency: config.concurrency,
    homeRoot: config.homeRoot,
    media: media.kind,
    model: config.model ?? "default",
    anthropicKey: Boolean(process.env.ANTHROPIC_API_KEY?.trim()),
  });

  const shutdown = new AbortController();
  const stop = (signal: string) => {
    if (shutdown.signal.aborted) return;
    log.info("stopping", { signal });
    shutdown.abort();
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));

  const deps: LoopDeps = {
    store: coreStore(),
    media,
    objects: storeReader(media),
    runtime,
    homeRoot: config.homeRoot,
    workerId,
    credentials: teamCredentials,
    processEnv: process.env,
    signal: shutdown.signal,
    log,
    concurrency: config.concurrency,
  };
  const active: ActiveRuns = new Map();
  while (!shutdown.signal.aborted) {
    await workerTick(deps, active);
    await sleep(config.pollMs, shutdown.signal);
  }

  if (active.size > 0) {
    log.info("waiting for active runs to wind down", { active: active.size });
    await Promise.race([Promise.allSettled(active.values()), sleep(SHUTDOWN_GRACE_MS)]);
  }
  log.info("worker down");
  process.exit(0);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

main().catch((caught: unknown) => {
  /* The masker is not up yet when this fires; the message alone is printed. */
  console.error(JSON.stringify({ level: "error", msg: "worker failed to start", error: caught instanceof Error ? caught.message : String(caught) }));
  process.exit(1);
});
