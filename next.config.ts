import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* The embedded database ships WASM; bundling it breaks it. The Agent SDK
     spawns Claude Code from inside its own package, so it stays outside the
     bundle too — it is loaded only when the dev server hosts the agent
     worker's loop (AGENT_DEV_WORKER=1). */
  serverExternalPackages: ["@electric-sql/pglite", "postgres", "@anthropic-ai/claude-agent-sdk"],
};

export default nextConfig;
