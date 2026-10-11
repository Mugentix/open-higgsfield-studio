import { downloadZip } from "client-zip";

import type { RunRecord } from "./history";

/* Result media is served from the platform's own CDN, so an <a download>
   pointed at it is ignored — the attribute only names a file when the href is
   same-origin. The bytes have to be read first, which means the CDN's CORS
   policy decides whether a run can be saved at all. A refusal is reported
   rather than papered over with a new tab the popup blocker would eat. */
export async function saveFile(url: string, name: string): Promise<boolean> {
  try {
    const response = await fetch(url, { mode: "cors" });
    if (!response.ok) return false;
    offer(await response.blob(), name);
    return true;
  } catch {
    return false;
  }
}

/** One file the visitor asked for in a zip: the name it takes inside the
    archive and where its bytes live. */
export type ZipEntry = { name: string; url: string };

/* A selection saved as one archive. Browsers throttle a burst of downloads
   into a single "allow multiple files?" prompt and drop the rest, so several
   files travel as one. The zip is written as a stream while the files are
   still being read, so only the finished archive is ever held whole. One
   refused read fails the whole save: an archive quietly missing a file would
   be found out six months later, when the file is needed. */
export async function saveZip(
  entries: ZipEntry[],
  zipName: string,
  options: { onProgress?: (done: number, total: number) => void } = {},
): Promise<boolean> {
  if (entries.length === 0) return false;
  try {
    const blob = await downloadZip(readAll(uniqueEntries(entries), options.onProgress)).blob();
    offer(blob, zipName);
    return true;
  } catch {
    return false;
  }
}

/* Reads lazily so the archive writer paces the network: the next file is
   fetched as the previous one is being written. The writer only asks for the
   next entry once the last one is fully in the archive, so the count reported
   at the top of each turn is files actually written, not files started. */
async function* readAll(entries: ZipEntry[], onProgress?: (done: number, total: number) => void) {
  for (const [index, entry] of entries.entries()) {
    onProgress?.(index, entries.length);
    const response = await fetch(entry.url, { mode: "cors" });
    if (!response.ok) throw new Error(`Could not read ${entry.name}`);
    yield { input: response, name: entry.name };
  }
  onProgress?.(entries.length, entries.length);
}

function offer(blob: Blob, name: string): void {
  const href = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = href;
  link.download = name;
  link.click();
  /* Revoking on the next tick races Safari, which reads the blob after the
     click returns. The handle costs nothing until then. */
  setTimeout(() => URL.revokeObjectURL(href), 60_000);
}

/** The words the file is filed under: the product and project the run belongs
    to, as the workspace names them. Either may be unknown — a run made before
    projects existed, or a selection that spans products. */
export type ExportContext = { product?: string; project?: string };

/** What a name needs from a run; both a RunRecord and a gallery Tile carry
    these fields. */
export type ExportRecord = Pick<RunRecord, "id" | "modelId" | "ratio" | "kind" | "urls" | "createdAt">;

/* An ad team files by campaign, not by prompt: the name leads with the product
   and project so a downloads folder sorts into the shelves the workspace has,
   then the model and format so the placements of one run sit side by side,
   then the day and the id's tail so two renders of the same brief stay apart. */
export function exportNameFor(record: ExportRecord, ctx: ExportContext, index = 0): string {
  const stem = [
    slug(ctx.product ?? "", SEGMENT_MAX),
    slug(ctx.project ?? "", SEGMENT_MAX),
    slug(record.modelId),
    slug(record.ratio.replace(/\s*[/:]\s*/g, "x")),
    dayStamp(record.createdAt),
    slug(record.id.slice(-6)),
  ]
    .filter(Boolean)
    .join("-");
  /* The second file that would take a name gets "-2", the way a desktop
     numbers a duplicate; the first keeps the clean name. */
  return `${stem}${index > 0 ? `-${index + 1}` : ""}.${extensionOf(record.urls[0] ?? "", record.kind)}`;
}

/** The archive a selection is saved as, filed by the same words as its files. */
export function zipNameFor(ctx: ExportContext, now = Date.now()): string {
  const stem = [slug(ctx.product ?? "", SEGMENT_MAX), slug(ctx.project ?? "", SEGMENT_MAX)]
    .filter(Boolean)
    .join("-");
  return `${stem || "export"}-${dayStamp(now)}.zip`;
}

/* Two entries with one name would overwrite each other on extraction, or make
   an extractor refuse the archive. Later duplicates are numbered until each
   name is free, so a name that already ends in "-2" is stepped past too. */
export function uniqueEntries<T extends { name: string }>(entries: T[]): T[] {
  const used = new Set<string>();
  return entries.map((entry) => {
    let name = entry.name;
    for (let n = 1; used.has(name); n++) name = suffixed(entry.name, n);
    used.add(name);
    return name === entry.name ? entry : { ...entry, name };
  });
}

function suffixed(name: string, n: number): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? `${name.slice(0, dot)}-${n + 1}${name.slice(dot)}` : `${name}-${n + 1}`;
}

/* A product name is typed by a person and can run long; a segment is cut so
   the whole name stays well inside every filesystem's limit. */
const SEGMENT_MAX = 40;

/** Lowercase ASCII words joined by single dashes. Accents fold to their base
    letter first so "Beşir" and "Café" keep their letters instead of losing
    them to a dash. */
function slug(value: string, max = Infinity): string {
  return value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/, "");
}

/* The visitor's own calendar day, which is the day they remember making it. */
function dayStamp(at: number): string {
  const date = new Date(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
}

function extensionOf(url: string, kind: RunRecord["kind"]): string {
  const ext = /\.([a-z0-9]{2,4})(?:[?#]|$)/i.exec(url)?.[1]?.toLowerCase();
  return ext ?? (kind === "video" ? "mp4" : "png");
}

