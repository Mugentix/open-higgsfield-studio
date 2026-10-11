import { beginUpload, finalizeUpload } from "@/server/uploads";
import { unwrap } from "@/server/result";

/** Sends a file to the team's store and returns the url the generate request
    carries plus the asset it became. Hashing lets a file the team already
    holds be reused without a second upload. */
export async function uploadMedia(file: File): Promise<{ url: string; assetId: string }> {
  const sha256 = file.size <= HASH_LIMIT ? await digest(file) : null;
  const ticket = unwrap(await beginUpload({ name: file.name, mime: file.type, size: file.size, sha256 }));
  if (ticket.existing) return { url: ticket.url, assetId: ticket.assetId };
  const res = await fetch(ticket.put.url, { method: "PUT", headers: ticket.put.headers, body: file });
  if (!res.ok) throw new Error(`the store refused the file (${res.status})`);
  const done = unwrap(await finalizeUpload(ticket.assetId));
  return { url: done.url, assetId: done.assetId };
}

const HASH_LIMIT = 64 * 1024 * 1024;

async function digest(file: File): Promise<string | null> {
  try {
    const buffer = await file.arrayBuffer();
    const hash = await crypto.subtle.digest("SHA-256", buffer);
    return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    return null;
  }
}
