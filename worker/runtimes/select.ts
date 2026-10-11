import type { WorkerConfig } from "../env";
import type { AgentRuntime } from "../runtime";
import { FakeRuntime } from "./fake";

/* The runtime AGENT_RUNTIME names. The Claude runtime is loaded only when it
   is the one asked for: it carries the Agent SDK, which neither the fake
   runtime nor a dev server hosting the loop has any use for. */

export async function selectRuntime(config: WorkerConfig): Promise<AgentRuntime> {
  if (config.runtime === "fake") return new FakeRuntime();
  const { ClaudeRuntime } = await import("./claude");
  return new ClaudeRuntime({
    model: config.model,
    fallbackModel: config.fallbackModel,
    maxTurns: config.maxTurns,
    pathToClaudeCodeExecutable: config.claudePath,
  });
}
