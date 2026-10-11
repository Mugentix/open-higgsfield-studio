import { readdir } from "node:fs/promises";
import path from "node:path";

import { DEFAULT_HOME_ROOT, type TeamHome } from "./home";
import { levelFromEnv, type Level } from "./log";

/* What the worker reads from its own environment, and what it lets the
   agent's subprocess see. The two are not the same: the worker holds the
   database, the bucket and the app's sealing key, none of which belong in a
   shell the model drives. The child gets an allowlist and nothing else: the
   shell's basics (PATH, locale, proxies, certificates), HOME pointed at the
   team, Claude Code's own switches and the Anthropic credential the CLI
   needs, Python's, and the keys the skill's scripts read. Whatever else the
   box or the unit file carries — cloud credentials, tokens, an agent socket
   — stays with the worker. */

export type WorkerConfig = {
  concurrency: number;
  homeRoot: string;
  runtime: "claude" | "fake";
  model: string | undefined;
  fallbackModel: string | undefined;
  maxTurns: number | undefined;
  claudePath: string | undefined;
  pollMs: number;
  logLevel: Level;
};

export function readConfig(env: Record<string, string | undefined>): WorkerConfig {
  const concurrency = Number.parseInt(env.AGENT_WORKER_CONCURRENCY ?? "", 10);
  const maxTurns = Number.parseInt(env.AGENT_MAX_TURNS ?? "", 10);
  const pollMs = Number.parseInt(env.AGENT_POLL_MS ?? "", 10);
  return {
    concurrency: Number.isInteger(concurrency) && concurrency > 0 ? Math.min(concurrency, 16) : 2,
    homeRoot: path.resolve(env.AGENT_HOME_ROOT?.trim() || DEFAULT_HOME_ROOT),
    runtime: env.AGENT_RUNTIME?.trim() === "fake" ? "fake" : "claude",
    model: env.AGENT_MODEL?.trim() || undefined,
    fallbackModel: env.AGENT_FALLBACK_MODEL?.trim() || undefined,
    maxTurns: Number.isInteger(maxTurns) && maxTurns > 0 ? maxTurns : undefined,
    claudePath: env.AGENT_CLAUDE_PATH?.trim() || undefined,
    pollMs: Number.isInteger(pollMs) && pollMs >= 500 ? pollMs : 3_000,
    logLevel: levelFromEnv(env.AGENT_LOG_LEVEL?.trim()),
  };
}

/** Why the worker must not start with this home root, or null: a root inside
    the worker's own working directory puts the agent's shell a `cd ..` away
    from the checkout's .env files, which hold the database url, the bucket
    credentials and the app's keys. */
export function homeRootProblem(homeRoot: string, cwd: string, envFilesInCwd: string[]): string | null {
  const relative = path.relative(cwd, homeRoot);
  const inside = relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  if (!inside || envFilesInCwd.length === 0) return null;
  return `AGENT_HOME_ROOT (${homeRoot}) is inside the worker's working directory, next to ${envFilesInCwd.join(", ")}, which the agent's shell could read. Point it outside the checkout (the default is ${DEFAULT_HOME_ROOT}).`;
}

/** The `.env*` files in a folder, by name. */
export async function dotEnvFiles(dir: string): Promise<string[]> {
  const names = await readdir(dir).catch(() => [] as string[]);
  return names.filter((name) => name.startsWith(".env")).sort();
}

/** What the child sees of the worker's environment, by exact name. */
const PASSED_ENV = new Set([
  "PATH",
  "SHELL",
  "LANG",
  "LANGUAGE",
  "TERM",
  "TZ",
  "TMPDIR",
  "USER",
  "LOGNAME",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "VIRTUAL_ENV",
  "BASH_DEFAULT_TIMEOUT_MS",
  "BASH_MAX_TIMEOUT_MS",
]);
/** …and by prefix: the locale, Claude Code's switches and the Anthropic credential, Python's. */
const PASSED_PREFIXES = ["LC_", "ANTHROPIC_", "CLAUDE_CODE_", "PYTHON"];
/** The credentials each cloud switch of the CLI needs, passed only while that switch is on. */
const CLOUD_ENV: Array<{ when: string; names: string[]; prefixes: string[] }> = [
  { when: "CLAUDE_CODE_USE_BEDROCK", names: [], prefixes: ["AWS_"] },
  { when: "CLAUDE_CODE_USE_VERTEX", names: ["GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_CLOUD_PROJECT", "CLOUD_ML_REGION"], prefixes: [] },
  { when: "CLAUDE_CODE_USE_FOUNDRY", names: [], prefixes: ["AZURE_"] },
];

/** Whether one of the worker's variables is handed to the child as it is. */
export function passesToChild(name: string, processEnv: Record<string, string | undefined>): boolean {
  if (PASSED_ENV.has(name) || PASSED_PREFIXES.some((prefix) => name.startsWith(prefix))) return true;
  return CLOUD_ENV.some((cloud) => processEnv[cloud.when] === "1" && (cloud.names.includes(name) || cloud.prefixes.some((prefix) => name.startsWith(prefix))));
}

/** Keys the scripts read that come from the worker's own environment, not
    from the team: Hugging Face and ElevenLabs are not team settings yet. Any
    other key a skill's script needs from the box is named here, or it does
    not reach the child. */
export function workerScriptKeys(env: Record<string, string | undefined>): Record<string, string> {
  const keys: Record<string, string> = {};
  for (const name of ["HF_KEY", "ELEVENLABS_API_KEY"]) {
    const value = env[name]?.trim();
    if (value) keys[name] = value;
  }
  return keys;
}

export function childEnv(processEnv: Record<string, string | undefined>, home: TeamHome, keys: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(processEnv)) {
    if (value === undefined || !passesToChild(name, processEnv)) continue;
    env[name] = value;
  }
  env.HOME = home.dir;
  env.CLAUDE_CONFIG_DIR = home.claudeDir;
  env.XDG_CONFIG_HOME = path.join(home.dir, ".config");
  env.XDG_CACHE_HOME = path.join(home.dir, ".cache");
  env.CLAUDE_AGENT_SDK_CLIENT_APP = "openhiggsfield-agent-worker/1.0";
  /* The CLI's own telemetry and auto-update have no place on a worker box. */
  env.DISABLE_AUTOUPDATER = "1";
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  for (const [name, value] of Object.entries(keys)) if (value) env[name] = value;
  return env;
}
