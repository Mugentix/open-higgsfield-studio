/* Object keys carry real extensions (download names derive from the url) and
   ids with enough entropy that a public bucket stays unguessable. */

const MIME_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/mpeg": "mp3",
};

const EXT_MIME: Record<string, string> = Object.fromEntries(
  Object.entries(MIME_EXT).map(([mime, ext]) => [ext, mime]),
);

export function extensionFor(contentType: string | null | undefined, url?: string): string {
  const mime = contentType?.split(";")[0]?.trim().toLowerCase();
  if (mime && MIME_EXT[mime]) return MIME_EXT[mime]!;
  const fromUrl = url?.split(/[?#]/)[0]?.match(/\.([a-z0-9]{2,5})$/i)?.[1]?.toLowerCase();
  if (fromUrl && EXT_MIME[fromUrl]) return fromUrl;
  return "bin";
}

export function mimeForKey(key: string): string {
  const ext = key.match(/\.([a-z0-9]{2,5})$/i)?.[1]?.toLowerCase();
  return (ext && EXT_MIME[ext]) || "application/octet-stream";
}

export function resultKey(teamId: string, projectId: string, runId: string, index: number, ext: string): string {
  return `t/${teamId}/p/${projectId}/r/${runId}/${index}.${ext}`;
}

export function frameKey(teamId: string, projectId: string, runId: string, index: number, which: "first" | "last"): string {
  return `t/${teamId}/p/${projectId}/r/${runId}/${index}.${which}.jpg`;
}

export function uploadKey(teamId: string, assetId: string, ext: string): string {
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `t/${teamId}/u/${yyyy}/${mm}/${assetId}.${ext}`;
}

/** Keys are our own; anything with a traversal or an odd character is refused
    before it reaches a filesystem or a bucket. */
export function isSafeKey(key: string): boolean {
  return /^[A-Za-z0-9_\-./]{3,400}$/.test(key) && !key.includes("..") && !key.startsWith("/");
}
