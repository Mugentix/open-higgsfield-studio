/* Runs once when the Next server starts. The one thing it does: in a local
   checkout with AGENT_DEV_WORKER=1, host the agent worker's loop, since the
   embedded database admits one process (src/server/agent-dev-worker.ts).
   The production check stands here, ahead of the import, so a production
   build never follows it: the worker's modules read and write under paths
   the bundler cannot scope, and tracing them would ship the whole checkout
   with the server. */
export async function register(): Promise<void> {
  if (process.env.NODE_ENV === "production") return;
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startAgentDevWorker } = await import("./server/agent-dev-worker");
  startAgentDevWorker();
}
