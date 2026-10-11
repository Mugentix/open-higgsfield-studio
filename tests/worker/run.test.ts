import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { childEnv, homeRootProblem, readConfig, workerScriptKeys } from "../../worker/env";
import { DEFAULT_HOME_ROOT, homePaths } from "../../worker/home";
import { createLogger } from "../../worker/log";
import { Masker } from "../../worker/mask";
import { asNote, firstPrompt, studioAppend } from "../../worker/run";
import { missingAuth } from "../../worker/runtimes/claude";

const home = homePaths("/srv/agent-homes", "team-1");

/** The app's own secrets and settings, as a deployment's environment carries
    them: none may reach the child, whatever else the allowlist passes. */
const APP_ENV = [
  "DATABASE_URL",
  "DB_AUTO_MIGRATE",
  "APP_SECRET_KEY",
  "BETTER_AUTH_SECRET",
  "BETTER_AUTH_URL",
  "RESEND_API_KEY",
  "CRON_SECRET",
  "KIE_WEBHOOK_HMAC_KEY",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET",
  "R2_PUBLIC_BASE_URL",
  "KIE_API_KEY",
  "KIE_API_BASE_URL",
  "KIE_UPLOAD_BASE_URL",
  "HF_KEY",
  "ELEVENLABS_API_KEY",
  "AGENT_HOME_ROOT",
  "AGENT_WORKER_CONCURRENCY",
  "AGENT_RUNTIME",
  "AGENT_MODEL",
  "AGENT_FALLBACK_MODEL",
  "AGENT_MAX_TURNS",
  "AGENT_CLAUDE_PATH",
  "AGENT_POLL_MS",
  "AGENT_LOG_LEVEL",
];

describe("childEnv", () => {
  it("passes the shell's basics and Claude Code's own variables, points HOME at the team and adds the run's keys", () => {
    const env = childEnv(
      {
        PATH: "/usr/bin",
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
        HTTPS_PROXY: "http://proxy:3128",
        ANTHROPIC_API_KEY: "sk-ant-xxxxxxxxxxxx",
        CLAUDE_CODE_MAX_OUTPUT_TOKENS: "8000",
        PYTHONUNBUFFERED: "1",
        DATABASE_URL: "postgres://x",
        R2_SECRET_ACCESS_KEY: "r2",
        APP_SECRET_KEY: "seal",
        KIE_API_KEY: "deployment-key-should-not-pass",
        AGENT_MODEL: "claude-x",
        UNDEFINED: undefined,
      },
      home,
      { KIE_API_KEY: "team-key-0123456789", HF_KEY: "hf_abcdefghijklmnop" },
    );
    expect(env).toMatchObject({
      PATH: "/usr/bin",
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      HTTPS_PROXY: "http://proxy:3128",
      ANTHROPIC_API_KEY: "sk-ant-xxxxxxxxxxxx",
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: "8000",
      PYTHONUNBUFFERED: "1",
      HOME: "/srv/agent-homes/team-1",
      CLAUDE_CONFIG_DIR: "/srv/agent-homes/team-1/.claude",
      KIE_API_KEY: "team-key-0123456789",
      HF_KEY: "hf_abcdefghijklmnop",
      DISABLE_AUTOUPDATER: "1",
    });
    for (const withheld of ["DATABASE_URL", "R2_SECRET_ACCESS_KEY", "APP_SECRET_KEY", "AGENT_MODEL", "UNDEFINED"]) expect(env).not.toHaveProperty(withheld);
  });

  it("is an allowlist: whatever else the box carries stays with the worker, and none of the app's own names leak", () => {
    const box: Record<string, string> = {
      PATH: "/usr/bin",
      GITHUB_TOKEN: "ghp_xxxxxxxxxxxx",
      NPM_TOKEN: "npm_xxxxxxxxxxxx",
      SSH_AUTH_SOCK: "/run/user/1000/keyring/ssh",
      GOOGLE_APPLICATION_CREDENTIALS: "/etc/gcp/sa.json",
      AWS_ACCESS_KEY_ID: "AKIA",
      AWS_SECRET_ACCESS_KEY: "aws-secret",
      NEON_API_KEY: "neon",
      VERCEL_TOKEN: "vercel",
      NODE_OPTIONS: "--require evil.js",
    };
    for (const name of APP_ENV) box[name] = `value-of-${name}`;
    const env = childEnv(box, home, {});
    for (const name of Object.keys(box)) if (name !== "PATH") expect(env).not.toHaveProperty(name);
    expect(env.PATH).toBe("/usr/bin");
  });

  it("hands a cloud switch its credentials only while that switch is on", () => {
    const box = { PATH: "/usr/bin", AWS_ACCESS_KEY_ID: "AKIA", AWS_REGION: "eu-central-1", GOOGLE_APPLICATION_CREDENTIALS: "/etc/gcp/sa.json", CLOUD_ML_REGION: "us-east5" };
    expect(childEnv({ ...box, CLAUDE_CODE_USE_BEDROCK: "1" }, home, {})).toMatchObject({ CLAUDE_CODE_USE_BEDROCK: "1", AWS_ACCESS_KEY_ID: "AKIA", AWS_REGION: "eu-central-1" });
    expect(childEnv({ ...box, CLAUDE_CODE_USE_BEDROCK: "1" }, home, {})).not.toHaveProperty("GOOGLE_APPLICATION_CREDENTIALS");
    expect(childEnv({ ...box, CLAUDE_CODE_USE_VERTEX: "1" }, home, {})).toMatchObject({ GOOGLE_APPLICATION_CREDENTIALS: "/etc/gcp/sa.json", CLOUD_ML_REGION: "us-east5" });
    expect(childEnv({ ...box, CLAUDE_CODE_USE_VERTEX: "1" }, home, {})).not.toHaveProperty("AWS_ACCESS_KEY_ID");
  });

  it("takes the scripts' extra keys from the worker's environment only when set", () => {
    expect(workerScriptKeys({ HF_KEY: " hf_x ", ELEVENLABS_API_KEY: "", OTHER: "1" })).toEqual({ HF_KEY: "hf_x" });
  });
});

describe("readConfig", () => {
  it("has defaults and reads the worker's variables", () => {
    expect(readConfig({})).toMatchObject({ concurrency: 2, runtime: "claude", model: undefined, pollMs: 3_000, logLevel: "info", maxTurns: undefined });
    /* Outside any checkout by default: the agent's shell must not sit next to a .env.local. */
    expect(readConfig({}).homeRoot).toBe(path.join(os.homedir(), ".openhiggsfield", "agent-homes"));
    expect(DEFAULT_HOME_ROOT).toBe(readConfig({}).homeRoot);
    expect(
      readConfig({ AGENT_WORKER_CONCURRENCY: "4", AGENT_RUNTIME: "fake", AGENT_MODEL: "claude-fable-5", AGENT_HOME_ROOT: "/srv/homes", AGENT_MAX_TURNS: "50", AGENT_POLL_MS: "1000", AGENT_LOG_LEVEL: "debug", AGENT_CLAUDE_PATH: "/opt/claude" }),
    ).toEqual({
      concurrency: 4,
      runtime: "fake",
      model: "claude-fable-5",
      fallbackModel: undefined,
      homeRoot: "/srv/homes",
      maxTurns: 50,
      claudePath: "/opt/claude",
      pollMs: 1000,
      logLevel: "debug",
    });
    expect(readConfig({ AGENT_WORKER_CONCURRENCY: "0", AGENT_POLL_MS: "10" })).toMatchObject({ concurrency: 2, pollMs: 3_000 });
  });

  it("refuses a home root inside the checkout when a .env file sits there", () => {
    expect(homeRootProblem("/srv/open-higgsfield/.data/agent-homes", "/srv/open-higgsfield", [".env.local"])).toMatch(/inside the worker's working directory, next to \.env\.local/);
    expect(homeRootProblem("/srv/open-higgsfield", "/srv/open-higgsfield", [".env", ".env.worker"])).toMatch(/\.env, \.env\.worker/);
    expect(homeRootProblem("/srv/open-higgsfield/.data/agent-homes", "/srv/open-higgsfield", [])).toBeNull();
    expect(homeRootProblem("/var/lib/openhiggsfield/agent-homes", "/srv/open-higgsfield", [".env.local"])).toBeNull();
    expect(homeRootProblem("/srv/open-higgsfield-homes", "/srv/open-higgsfield", [".env.local"])).toBeNull();
  });
});

describe("prompts", () => {
  it("opens with the skill's slash command, the brief and the attachments", () => {
    expect(firstPrompt({ slug: "drama-ad-machine" }, { brief: "  Make three hooks.  " }, { inputs: [] })).toBe("/drama-ad-machine Make three hooks.");
    expect(firstPrompt({ slug: "x" }, { brief: "b" }, { inputs: ["inputs/ref.png", "inputs/take.mp4"] })).toBe("/x b\n\nAttached files (in the working directory):\n- ./inputs/ref.png\n- ./inputs/take.mp4");
  });

  it("tells the agent where it is and what the studio expects", () => {
    const append = studioAppend({
      context: { teamName: "Mugentix", productName: "Coffee Pods", projectName: "Q4" },
      skill: { name: "Drama Ad Machine", slug: "drama-ad-machine" },
      workspace: { inputs: ["inputs/ref.png"] },
      hasKieKey: true,
    });
    expect(append).toContain('"Drama Ad Machine" skill inside the team studio');
    expect(append).toContain("Team: Mugentix. Project: Coffee Pods › Q4.");
    expect(append).toContain("attached 1 file(s)");
    expect(append).toContain("mcp__studio__publish");
    expect(append).toContain("KIE_API_KEY");
    expect(append).toContain("Never print a key");
    const without = studioAppend({ context: { teamName: "T", productName: "", projectName: "" }, skill: { name: "S", slug: "s" }, workspace: { inputs: [] }, hasKieKey: false });
    expect(without).toContain("Project: the current project.");
    expect(without).toContain("no KIE key configured");
    expect(without).toContain("./inputs/ is empty");
  });

  it("renders a note as a blockquote", () => {
    expect(asNote("Kept the 9:16 cut.\nSee outputs/board.md")).toBe("> **Note** — Kept the 9:16 cut.\n> See outputs/board.md");
  });
});

describe("missingAuth", () => {
  it("names the missing key unless a credential or a cloud switch is set", () => {
    expect(missingAuth({})).toMatch(/no ANTHROPIC_API_KEY/);
    expect(missingAuth({ ANTHROPIC_API_KEY: " " })).toMatch(/no ANTHROPIC_API_KEY/);
    expect(missingAuth({ ANTHROPIC_API_KEY: "sk-ant-x" })).toBeNull();
    expect(missingAuth({ CLAUDE_CODE_USE_BEDROCK: "1" })).toBeNull();
    expect(missingAuth({ ANTHROPIC_AUTH_TOKEN: "tok" })).toBeNull();
  });
});

describe("logger", () => {
  it("writes one masked JSON line per entry at or above the level", () => {
    const lines: string[] = [];
    const log = createLogger(new Masker({ KIE_API_KEY: "kie-0123456789abcdef" }), { level: "info", sink: (line) => lines.push(line), now: () => new Date(0), fields: { worker: "w1" } });
    log.debug("quiet");
    log.child({ runId: "r1" }).warn("key seen", { command: "x kie-0123456789abcdef", error: new Error("boom") });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual({
      ts: "1970-01-01T00:00:00.000Z",
      level: "warn",
      msg: "key seen",
      worker: "w1",
      runId: "r1",
      command: "x •••",
      error: { name: "Error", message: "boom" },
    });
  });
});
