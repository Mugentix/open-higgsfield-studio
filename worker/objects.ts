import { readFile } from "node:fs/promises";

import type { MediaStore } from "@/server/storage";
import { isSafeKey } from "@/server/storage/keys";

/* The media store knows how to write and to name objects; the worker also
   has to read them back (a skill zip, an attachment). On R2 that is the
   public url; on a local checkout the app serves /media/<key> and may not be
   running while the worker is, so the bytes are read straight from disk. */

export type ObjectReader = {
  read(key: string): Promise<Uint8Array>;
  /** The store key behind one of our own urls, or null for a foreign url. */
  keyOf(url: string): string | null;
};

export function storeReader(store: MediaStore): ObjectReader {
  const base = store.publicUrl("");
  return {
    async read(key) {
      if (!isSafeKey(key)) throw new Error(`Unsafe media key ${key}`);
      if (store.kind === "local") {
        const { localPath } = await import("@/server/storage/local");
        return new Uint8Array(await readFile(localPath(key)));
      }
      return fetchBytes(store.publicUrl(key));
    },
    keyOf(url) {
      if (!url.startsWith(base)) return null;
      const key = decodeURIComponent(url.slice(base.length).split(/[?#]/)[0] ?? "");
      return isSafeKey(key) ? key : null;
    },
  };
}

export async function fetchBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} fetching ${url.split("?")[0]}`);
  return new Uint8Array(await response.arrayBuffer());
}
