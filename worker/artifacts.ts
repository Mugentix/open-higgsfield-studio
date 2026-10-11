import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";

import type { AgentRunRecord, ArtifactKind } from "@/server/agents-contract";
import type { MediaStore } from "@/server/storage";

import type { ArtifactDraft } from "./store";

/* What the agent made, found on disk after every turn: everything under
   outputs/, plus pictures, videos and Markdown it left anywhere shallow in
   the workspace. New or changed files are copied into the media store under
   t/<team>/agents/<runId>/<path> and recorded; a file whose size and mtime
   have not moved, or whose bytes hash the same, is not copied twice. */

export const ARTIFACT_MAX_BYTES = 500 * 1024 * 1024;
/** Files outside outputs/ are looked for this deep (workspace root = 0). */
export const LOOSE_MAX_DEPTH = 2;
const OUTPUTS_MAX_DEPTH = 8;
const SCAN_MAX_FILES = 500;
const SKIP_DIRS = new Set(["inputs", "node_modules", "__pycache__", ".venv", "venv", ".git", ".claude"]);

export type Fingerprint = { size: number; mtimeMs: number; sha256: string };
export type Snapshot = Map<string, Fingerprint>;

export type FoundFile = {
  /** Relative to the workspace, posix separators. */
  path: string;
  absolute: string;
  size: number;
  fileKind: ArtifactKind;
  mime: string;
};

const EXT: Record<string, { kind: ArtifactKind; mime: string }> = {
  png: { kind: "image", mime: "image/png" },
  jpg: { kind: "image", mime: "image/jpeg" },
  jpeg: { kind: "image", mime: "image/jpeg" },
  webp: { kind: "image", mime: "image/webp" },
  gif: { kind: "image", mime: "image/gif" },
  svg: { kind: "image", mime: "image/svg+xml" },
  mp4: { kind: "video", mime: "video/mp4" },
  mov: { kind: "video", mime: "video/quicktime" },
  webm: { kind: "video", mime: "video/webm" },
  wav: { kind: "audio", mime: "audio/wav" },
  mp3: { kind: "audio", mime: "audio/mpeg" },
  m4a: { kind: "audio", mime: "audio/mp4" },
  md: { kind: "document", mime: "text/markdown" },
  txt: { kind: "document", mime: "text/plain" },
  json: { kind: "document", mime: "application/json" },
  csv: { kind: "document", mime: "text/csv" },
  srt: { kind: "document", mime: "text/plain" },
  vtt: { kind: "document", mime: "text/vtt" },
  html: { kind: "document", mime: "text/html" },
  pdf: { kind: "document", mime: "application/pdf" },
};
const LOOSE_KINDS = new Set<ArtifactKind>(["image", "video"]);

export function describeFile(relative: string): { fileKind: ArtifactKind; mime: string } {
  const ext = relative.match(/\.([A-Za-z0-9]{1,8})$/)?.[1]?.toLowerCase() ?? "";
  const known = EXT[ext];
  return known ? { fileKind: known.kind, mime: known.mime } : { fileKind: "other", mime: "application/octet-stream" };
}

/** Walks the workspace and returns the files that are new or changed against
    `previous`, with the snapshot to keep for the next scan. */
export async function scanWorkspace(dir: string, previous: Snapshot): Promise<{ changed: FoundFile[]; snapshot: Snapshot }> {
  const found: FoundFile[] = [];
  await walk(dir, dir, 0, found);
  const snapshot: Snapshot = new Map();
  const changed: FoundFile[] = [];
  for (const file of found) {
    const info = await stat(file.absolute).catch(() => null);
    if (!info?.isFile()) continue;
    const before = previous.get(file.path);
    if (before && before.size === info.size && before.mtimeMs === info.mtimeMs) {
      snapshot.set(file.path, before);
      continue;
    }
    const sha256 = await hashFile(file.absolute);
    snapshot.set(file.path, { size: info.size, mtimeMs: info.mtimeMs, sha256 });
    if (before && before.sha256 === sha256) continue;
    changed.push({ ...file, size: info.size });
  }
  return { changed, snapshot };
}

async function walk(root: string, dir: string, depth: number, out: FoundFile[]): Promise<void> {
  if (out.length >= SCAN_MAX_FILES) return;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (out.length >= SCAN_MAX_FILES) return;
    if (entry.name.startsWith(".")) continue;
    /* A link may point anywhere — another team's HOME included — so it is neither a file nor a folder here. */
    if (entry.isSymbolicLink()) continue;
    const absolute = path.join(dir, entry.name);
    const relative = path.relative(root, absolute).split(path.sep).join("/");
    const inOutputs = relative === "outputs" || relative.startsWith("outputs/");
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) && !inOutputs) continue;
      const limit = inOutputs ? OUTPUTS_MAX_DEPTH : LOOSE_MAX_DEPTH;
      if (depth + 1 <= limit) await walk(root, absolute, depth + 1, out);
      continue;
    }
    if (!entry.isFile()) continue;
    const { fileKind, mime } = describeFile(relative);
    if (!inOutputs && !LOOSE_KINDS.has(fileKind) && !relative.endsWith(".md")) continue;
    const info = await stat(absolute).catch(() => null);
    if (!info || info.size === 0 || info.size > ARTIFACT_MAX_BYTES) continue;
    out.push({ path: relative, absolute, size: info.size, fileKind, mime });
  }
}

/** The store key for an artifact: our own charset, the workspace path kept
    readable. Two paths that fold to one key are the same artifact to the
    store, which is acceptable for a `My Take (1).png` next to `My_Take_1.png`. */
export function artifactKey(teamId: string, runId: string, relative: string): string {
  const folded = relative
    .split("/")
    .filter((segment) => segment && segment !== "." && segment !== "..")
    .map((segment) => segment.replace(/[^A-Za-z0-9_.-]+/g, "_").replace(/^\.+/, "_"))
    .join("/");
  return `t/${teamId}/agents/${runId}/${folded || "file"}`;
}

export async function uploadArtifact(media: MediaStore, run: Pick<AgentRunRecord, "id" | "teamId">, file: FoundFile): Promise<ArtifactDraft> {
  const storageKey = artifactKey(run.teamId, run.id, file.path);
  const body = Readable.toWeb(createReadStream(file.absolute)) as ReadableStream<Uint8Array>;
  const { bytes } = await media.put(storageKey, body, file.mime);
  return { path: file.path, fileKind: file.fileKind, storageKey, url: media.publicUrl(storageKey), sizeBytes: bytes };
}

/** A path the agent named (the publish tool) as a FoundFile, or null when it
    points outside the workspace or at nothing. A symlink anywhere in the
    path — the file itself or a folder on the way — is outside too: the
    publish would otherwise read through it into whatever it points at. */
export async function locateFile(workspaceDir: string, requested: string): Promise<FoundFile | null> {
  const absolute = path.resolve(workspaceDir, requested);
  const relative = path.relative(workspaceDir, absolute);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  const info = await lstat(absolute).catch(() => null);
  if (!info?.isFile() || info.size === 0 || info.size > ARTIFACT_MAX_BYTES) return null;
  const real = await Promise.all([realpath(absolute), realpath(workspaceDir)]).catch(() => null);
  if (!real || real[0] !== path.join(real[1], relative)) return null;
  const posix = relative.split(path.sep).join("/");
  return { path: posix, absolute, size: info.size, ...describeFile(posix) };
}

export function hashFile(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(file)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}
