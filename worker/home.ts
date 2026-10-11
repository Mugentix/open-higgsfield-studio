import { unzipSync } from "fflate";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { AgentRunRecord, SkillRecord } from "@/server/agents-contract";

import type { ObjectReader } from "./objects";

/* Each team gets its own HOME on the worker: Claude Code reads
   ~/.claude/skills and ~/.claude/agents from it, keeps the session
   transcripts under it, and the skills' scripts write wherever a HOME lets
   them. That keeps one team's skills, transcripts and files apart from
   another's; it is not a boundary. Every HOME is made by the same unix user
   and a shell in one can read the others, so isolation between teams is the
   deployment's job: a unix user or a container per team. Under a HOME,
   runs/<runId>/ is the working directory the agent is started in: inputs/
   holds what the person attached, outputs/ is where deliverables go, .env
   carries the keys the scripts read. */

export type TeamHome = {
  teamId: string;
  dir: string;
  claudeDir: string;
  skillsDir: string;
  agentsDir: string;
  documentsDir: string;
  runsDir: string;
};

export type Workspace = {
  runId: string;
  dir: string;
  inputsDir: string;
  outputsDir: string;
  envFile: string;
  /** The attachments that were fetched, relative to `dir`. */
  inputs: string[];
};

export type Attachment = { name: string; url: string };

/** Outside any checkout: the agent's shell reads whatever its cwd's parents
    hold, and a checkout holds .env.local. */
export const DEFAULT_HOME_ROOT = path.join(os.homedir(), ".openhiggsfield", "agent-homes");
const MARKER = ".studio-skill.json";
/** inputs/.manifest.json: file name → the url it was fetched from. */
const MANIFEST = ".manifest.json";
const SCRIPT = /\.(py|sh)$/;

/** Where a team's HOME lives, with nothing created yet. The root is relative
    to the worker's cwd when it is not absolute; the team id is a UUID the
    database minted, so it is safe as a path segment. */
export function homePaths(root: string, teamId: string): TeamHome {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(teamId)) throw new Error(`Unsafe team id for a HOME: ${teamId}`);
  const dir = path.resolve(root, teamId);
  const claudeDir = path.join(dir, ".claude");
  return {
    teamId,
    dir,
    claudeDir,
    skillsDir: path.join(claudeDir, "skills"),
    agentsDir: path.join(claudeDir, "agents"),
    documentsDir: path.join(dir, "Documents"),
    runsDir: path.join(dir, "runs"),
  };
}

export async function ensureHome(root: string, teamId: string): Promise<TeamHome> {
  const home = homePaths(root, teamId);
  for (const dir of [home.dir, home.claudeDir, home.skillsDir, home.agentsDir, home.documentsDir, home.runsDir]) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  }
  return home;
}

/** Puts the skill's folder at <home>/.claude/skills/<slug>/, replacing an
    older version whole (unpacked next to it, then swapped in), and copies its
    agents/*.md into <home>/.claude/agents/ so the subagents load however
    Claude Code looks for skill-bundled agents. A folder already holding this
    exact bundle is left alone. */
export async function installSkill(home: TeamHome, skill: SkillRecord, objects: ObjectReader): Promise<{ installed: boolean; files: number }> {
  if (skill.status !== "ready") throw new Error(`Skill "${skill.name}" is ${skill.status} and cannot run`);
  if (!/^[a-z0-9-]{1,64}$/.test(skill.slug)) throw new Error(`Unsafe skill slug ${skill.slug}`);
  const target = path.join(home.skillsDir, skill.slug);
  const marker = JSON.stringify({ id: skill.id, version: skill.version, storageKey: skill.storageKey, sizeBytes: skill.sizeBytes });
  const current = await readFile(path.join(target, MARKER), "utf8").catch(() => null);
  if (current === marker) return { installed: false, files: skill.files };

  const bytes = await objects.read(skill.storageKey);
  const entries = unzipSync(bytes);
  const staging = path.join(home.skillsDir, `.${skill.slug}.${randomBytes(4).toString("hex")}`);
  await mkdir(staging, { recursive: true, mode: 0o700 });
  let files = 0;
  const agents: Array<{ name: string; data: Uint8Array }> = [];
  try {
    for (const [rawName, data] of Object.entries(entries)) {
      const name = rawName.replaceAll("\\", "/");
      if (name.endsWith("/")) continue;
      if (!isSafeRelative(name)) throw new Error(`Unsafe path in skill bundle: ${rawName}`);
      const file = path.join(staging, name);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, data);
      if (SCRIPT.test(name)) await chmod(file, 0o755);
      if (/^agents\/[^/]+\.md$/.test(name)) agents.push({ name: path.basename(name), data });
      files++;
    }
    if (!(await exists(path.join(staging, "SKILL.md")))) throw new Error("The skill bundle has no SKILL.md at its root");
    await writeFile(path.join(staging, MARKER), marker);
    const retired = `${target}.old-${randomBytes(4).toString("hex")}`;
    if (await exists(target)) await rename(target, retired);
    await rename(staging, target);
    await rm(retired, { recursive: true, force: true });
  } catch (caught) {
    await rm(staging, { recursive: true, force: true });
    throw caught;
  }
  for (const agent of agents) await writeFile(path.join(home.agentsDir, agent.name), agent.data);
  return { installed: true, files };
}

/** <home>/runs/<runId>/ with inputs/, outputs/ and a .env only the worker
    user can read. Attachments land in inputs/ under their original names
    (made unique when two share one); a file already there from the same url
    is kept, so a run a second worker picks up does not fetch everything again. */
export async function prepareWorkspace(
  home: TeamHome,
  run: Pick<AgentRunRecord, "id">,
  options: { attachments: Attachment[]; env: Record<string, string>; objects: ObjectReader; fetch?: (url: string) => Promise<Uint8Array> },
): Promise<Workspace> {
  const dir = path.join(home.runsDir, run.id);
  const inputsDir = path.join(dir, "inputs");
  const outputsDir = path.join(dir, "outputs");
  for (const folder of [dir, inputsDir, outputsDir]) await mkdir(folder, { recursive: true, mode: 0o700 });
  const envFile = path.join(dir, ".env");
  await writeFile(envFile, dotenv(options.env), { mode: 0o600 });
  await chmod(envFile, 0o600);
  const inputs = await fetchInputs(inputsDir, options.attachments, options.objects, options.fetch);
  return { runId: run.id, dir, inputsDir, outputsDir, envFile, inputs: inputs.map((file) => path.posix.join("inputs", file)) };
}

/** Later attachments (a reply with files) go to the same inputs/ folder. A
    file already there is reused only when it came from the same url — the
    manifest remembers where each one came from — so a different file sent
    later under a name already taken gets a numbered name instead, and the
    agent is never pointed at the old bytes. */
export async function fetchInputs(
  inputsDir: string,
  attachments: Attachment[],
  objects: ObjectReader,
  fetchUrl: (url: string) => Promise<Uint8Array> = defaultFetch,
): Promise<string[]> {
  const manifestFile = path.join(inputsDir, MANIFEST);
  const manifest = await readManifest(manifestFile);
  const taken = new Set(await readdir(inputsDir).catch(() => [] as string[]));
  const names: string[] = [];
  let changed = false;
  for (const attachment of attachments) {
    const wanted = safeFileName(attachment.name, attachment.url);
    if (manifest[wanted] === attachment.url && (await exists(path.join(inputsDir, wanted)))) {
      names.push(wanted);
      continue;
    }
    const name = uniqueName(wanted, taken);
    const key = objects.keyOf(attachment.url);
    const bytes = key ? await objects.read(key) : await fetchUrl(attachment.url);
    await writeFile(path.join(inputsDir, name), bytes);
    manifest[name] = attachment.url;
    changed = true;
    names.push(name);
  }
  if (changed) await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  return names;
}

async function readManifest(file: string): Promise<Record<string, string>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    }
  } catch {
    /* none yet, or unreadable: nothing is reused */
  }
  return {};
}

/** `KEY=value` lines; values are quoted so a `#` or a space survives
    python-dotenv and `source` alike. */
export function dotenv(env: Record<string, string>): string {
  return `${Object.entries(env)
    .filter(([key, value]) => /^[A-Z_][A-Z0-9_]*$/.test(key) && value !== "")
    .map(([key, value]) => `${key}="${value.replace(/(["\\$`])/g, "\\$1")}"`)
    .join("\n")}\n`;
}

/** An attachment's name as a file name: the last segment, odd characters
    folded to `_`, an extension taken from the url when the name has none. */
export function safeFileName(name: string, url = ""): string {
  let base = (name.split(/[\\/]/).pop() ?? "").trim().replace(/[^\w.() -]+/g, "_").replace(/^\.+/, "");
  if (!base) base = "attachment";
  if (!/\.[A-Za-z0-9]{1,8}$/.test(base)) {
    const ext = url.split(/[?#]/)[0]?.match(/\.([A-Za-z0-9]{1,8})$/)?.[1];
    if (ext) base = `${base}.${ext}`;
  }
  return base.slice(0, 120);
}

function uniqueName(name: string, taken: Set<string>): string {
  let candidate = name;
  let index = 2;
  while (taken.has(candidate)) {
    const dot = name.lastIndexOf(".");
    candidate = dot > 0 ? `${name.slice(0, dot)}-${index}${name.slice(dot)}` : `${name}-${index}`;
    index++;
  }
  taken.add(candidate);
  return candidate;
}

function isSafeRelative(name: string): boolean {
  if (name.length === 0 || name.startsWith("/") || /^[A-Za-z]:/.test(name) || name.includes("\0")) return false;
  return name.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

async function exists(file: string): Promise<boolean> {
  return stat(file).then(
    () => true,
    () => false,
  );
}

async function defaultFetch(url: string): Promise<Uint8Array> {
  const { fetchBytes } = await import("./objects");
  return fetchBytes(url);
}
