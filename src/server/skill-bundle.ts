import { unzipSync, zipSync } from "fflate";

import { SKILL_FILES_MAX, SKILL_ZIP_MAX_BYTES } from "./agents-contract";

/* A skill bundle is a Claude Code skill folder zipped: SKILL.md with a name
   and a description in its frontmatter, scripts, references, agents/*.md.
   This module reads one, checks it against the rules both sides enforce
   and hands back a normalised zip — SKILL.md at the root, nothing else
   moved — or the list of reasons it was refused. Pure: no store, no table. */

export type SkillBundle = {
  name: string;
  /** Folder name on the worker; lower-case, dashes. */
  slug: string;
  description: string;
  version: string | null;
  compatibility: string | null;
  /** Subagent names found in agents/*.md. */
  agents: string[];
  /** Files in the normalised bundle. */
  files: number;
  /** Unpacked bytes, what the folder weighs on disk. */
  sizeBytes: number;
  problems: string[];
  /** The normalised zip; null when `problems` is not empty. */
  zip: Uint8Array | null;
};

/** What a bundle may unpack to: beyond this a zip is a bomb, not a skill. */
export const SKILL_UNPACKED_MAX_BYTES = 4 * SKILL_ZIP_MAX_BYTES;

/* Entries macOS and Windows slip into every archive; dropped, never counted. */
const JUNK = /(^|\/)(__MACOSX\/|\.DS_Store$|Thumbs\.db$|desktop\.ini$)/;
const AGENT_FILE = /^agents\/[^/]+\.md$/;
/* Zip timestamps are DOS times from 1980 on; one fixed stamp so the same
   bundle normalises to the same bytes. */
const ZIP_MTIME = new Date("2000-01-01T00:00:00Z");
const PROBLEMS_SHOWN = 5;

type Entry = { name: string; size: number; symlink: boolean; directory: boolean };

/** Reads a zip the way the worker will have to live with it. The name and
    slug are always filled — from SKILL.md, or from the file name when the
    bundle has none — so a refused upload still has a row to hang its
    problems on. */
export function inspectSkillBundle(bytes: Uint8Array, fileName = "skill.zip"): SkillBundle {
  const fallback = fileName.replace(/\.zip$/i, "").split(/[\\/]/).pop() || "skill";
  const refused = (problems: string[]): SkillBundle => ({
    name: fallback,
    slug: slugify(fallback) || "skill",
    description: "",
    version: null,
    compatibility: null,
    agents: [],
    files: 0,
    sizeBytes: 0,
    problems,
    zip: null,
  });

  if (bytes.byteLength > SKILL_ZIP_MAX_BYTES) {
    return refused([`The zip is ${formatBytes(bytes.byteLength)}; the limit is ${formatBytes(SKILL_ZIP_MAX_BYTES)}`]);
  }
  let entries: Entry[];
  try {
    entries = readCentralDirectory(bytes);
  } catch (caught) {
    return refused([caught instanceof Error ? caught.message : "Not a zip file"]);
  }

  const files = entries.filter((entry) => !entry.directory && !JUNK.test(entry.name));
  if (files.length === 0) return refused(["The zip is empty"]);
  if (files.length > SKILL_FILES_MAX) return refused([`The zip holds ${files.length} files; the limit is ${SKILL_FILES_MAX}`]);

  const problems: string[] = [];
  const unsafe: string[] = [];
  const links: string[] = [];
  let unpacked = 0;
  const kept = new Map<string, string>();
  for (const entry of files) {
    const name = entry.name.replaceAll("\\", "/").replace(/^\.\//, "");
    if (!isSafePath(name)) unsafe.push(entry.name);
    else if (entry.symlink) links.push(entry.name);
    else kept.set(entry.name, name);
    unpacked += entry.size;
  }
  if (unsafe.length > 0) problems.push(listed("Unsafe path", unsafe));
  if (links.length > 0) problems.push(listed("Symbolic link", links));
  if (unpacked > SKILL_UNPACKED_MAX_BYTES) {
    problems.push(`The bundle unpacks to ${formatBytes(unpacked)}; the limit is ${formatBytes(SKILL_UNPACKED_MAX_BYTES)}`);
  }
  if (problems.length > 0) return refused(problems);

  let unzipped: Record<string, Uint8Array>;
  try {
    unzipped = unzipSync(bytes, { filter: (file) => kept.has(file.name) });
  } catch (caught) {
    return refused([`The zip could not be read: ${caught instanceof Error ? caught.message : "unsupported compression"}`]);
  }

  /* SKILL.md at the root, or inside the one folder everything shares — the
     shape a right-click "Compress" gives a skill folder. */
  const names = [...kept.values()];
  const prefix = rootPrefix(names);
  if (prefix === null) return refused(["No SKILL.md at the bundle root or inside a single top-level folder"]);
  const outside = names.filter((name) => !name.startsWith(prefix));
  if (outside.length > 0) return refused([listed(`Outside the skill folder "${prefix.slice(0, -1)}"`, outside)]);

  const normalised = new Map<string, Uint8Array>();
  let sizeBytes = 0;
  for (const [original, name] of kept) {
    const data = unzipped[original];
    if (!data) continue;
    normalised.set(name.slice(prefix.length), data);
    sizeBytes += data.byteLength;
  }

  const skillMd = normalised.get("SKILL.md");
  const frontmatter = parseFrontmatter(new TextDecoder().decode(skillMd ?? new Uint8Array()));
  const name = frontmatter.name?.trim() ?? "";
  const description = frontmatter.description?.trim() ?? "";
  if (!name) problems.push("SKILL.md has no `name` in its frontmatter");
  if (!description) problems.push("SKILL.md has no `description` in its frontmatter");
  const slug = slugify(name);
  if (name && !slug) problems.push(`The name "${name}" leaves no letters or digits for a folder name`);

  const agents: string[] = [];
  for (const [path, data] of normalised) {
    if (!AGENT_FILE.test(path)) continue;
    const agentName = parseFrontmatter(new TextDecoder().decode(data)).name?.trim();
    agents.push(agentName || path.slice("agents/".length, -".md".length));
  }
  agents.sort();

  const bundle: SkillBundle = {
    name: name || fallback,
    slug: slug || slugify(fallback) || "skill",
    description,
    version: frontmatter.version?.trim() || frontmatter["metadata.version"]?.trim() || null,
    compatibility: frontmatter.compatibility?.trim() || null,
    agents,
    files: normalised.size,
    sizeBytes,
    problems,
    zip: null,
  };
  if (problems.length > 0) return bundle;

  const zippable: Record<string, [Uint8Array, { mtime: Date }]> = {};
  for (const [path, data] of normalised) zippable[path] = [data, { mtime: ZIP_MTIME }];
  return { ...bundle, zip: zipSync(zippable, { level: 6 }) };
}

/** Lower-case letters, digits and dashes; what a skill folder is called. */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

/** The YAML frontmatter of a Markdown file as flat keys: `metadata.version`
    for a nested value. Enough of YAML for what SKILL.md and agents/*.md
    carry — scalars, quoted or not, folded or literal blocks, one level of
    nesting — and nothing a skill author has not written. */
export function parseFrontmatter(markdown: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = markdown.replace(/^\uFEFF/, "").split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return out;
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (end < 0) return out;

  const parents: Array<{ indent: number; key: string }> = [];
  let current: { key: string; indent: number; block: ">" | "|" | null } | null = null;
  for (const line of lines.slice(1, end)) {
    if (line.trim() === "" && !current?.block) continue;
    const indent = line.length - line.trimStart().length;
    const match = /^(\s*)([A-Za-z0-9_][A-Za-z0-9_.-]*)\s*:(?:\s+(.*)|\s*)$/.exec(line);
    const continues = current && indent > current.indent && (!match || current.block);
    if (continues && current) {
      const text = line.trim();
      out[current.key] = out[current.key] ? `${out[current.key]}${current.block === "|" ? "\n" : " "}${text}` : text;
      continue;
    }
    if (!match) {
      current = null;
      continue;
    }
    while (parents.length > 0 && parents[parents.length - 1]!.indent >= indent) parents.pop();
    const key = [...parents.map((parent) => parent.key), match[2]!].join(".");
    const raw = (match[3] ?? "").trim();
    if (raw === "") {
      /* A key with nothing after it opens a nested map; its children carry
         the prefix. A folded block would have said so with `>` or `|`. */
      parents.push({ indent, key: match[2]! });
      current = { key, indent, block: null };
      continue;
    }
    if (raw === ">" || raw === "|" || raw === ">-" || raw === "|-") {
      current = { key, indent, block: raw[0] as ">" | "|" };
      out[key] = "";
      continue;
    }
    out[key] = scalar(raw);
    current = { key, indent, block: null };
  }
  return out;
}

/* ---------- zip reading ---------- */

/** The central directory, which is where a zip keeps each entry's external
    attributes: fflate inflates the data but does not say what mode an entry
    was stored with, and a symbolic link must be refused before anything is
    written to a disk. */
function readCentralDirectory(bytes: Uint8Array): Entry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let at = bytes.byteLength - 22; at >= Math.max(0, bytes.byteLength - 22 - 65_535); at--) {
    if (view.getUint32(at, true) === 0x06054b50) {
      eocd = at;
      break;
    }
  }
  if (eocd < 0) throw new Error("Not a zip file");
  const count = view.getUint16(eocd + 10, true);
  const offset = view.getUint32(eocd + 16, true);
  if (count === 0xffff || offset === 0xffffffff) throw new Error("ZIP64 archives are not supported");
  const decoder = new TextDecoder();
  const entries: Entry[] = [];
  let at = offset;
  for (let index = 0; index < count; index++) {
    if (at + 46 > bytes.byteLength || view.getUint32(at, true) !== 0x02014b50) throw new Error("The zip's directory is damaged");
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const external = view.getUint32(at + 38, true);
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    const mode = external >>> 16;
    entries.push({
      name,
      size,
      symlink: (mode & 0o170000) === 0o120000,
      directory: name.endsWith("/") || (mode & 0o170000) === 0o040000 || (external & 0x10) !== 0,
    });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** Relative, no traversal, no empty or dot segments, nothing a filesystem
    would read as a device or a drive. */
function isSafePath(name: string): boolean {
  if (name.length === 0 || name.length > 512) return false;
  if (name.startsWith("/") || /^[A-Za-z]:/.test(name)) return false;
  if (/[\0]/.test(name)) return false;
  return name.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/** "" when SKILL.md sits at the root, "<folder>/" when every file sits under
    one folder that holds it, null otherwise. */
function rootPrefix(names: string[]): string | null {
  if (names.includes("SKILL.md")) return "";
  const first = names[0]?.split("/")[0];
  if (!first) return null;
  const prefix = `${first}/`;
  return names.includes(`${prefix}SKILL.md`) ? prefix : null;
}

function listed(label: string, names: string[]): string {
  const shown = names.slice(0, PROBLEMS_SHOWN).map((name) => `"${name}"`);
  const more = names.length - shown.length;
  return `${label}: ${shown.join(", ")}${more > 0 ? ` and ${more} more` : ""}`;
}

/** A plain value up to its ` # comment`; a quoted one up to its closing
    quote, whatever follows. */
function scalar(value: string): string {
  const quote = value[0];
  if (quote === '"' || quote === "'") {
    for (let at = 1; at < value.length; at++) {
      if (value[at] === "\\" && quote === '"') {
        at++;
        continue;
      }
      if (value[at] === quote) return value.slice(1, at).replace(/\\(["\\])/g, "$1");
    }
    return value.slice(1);
  }
  return value.replace(/\s+#.*$/, "");
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}
