import type { MediaItem, MediaRole } from "./catalog/types";

/* The two media stores take attachments through these, so the picker's
   replace-the-set and a tile's add-one agree on what a full slot means. */

export type RoleStore = {
  getState(): {
    items: MediaItem[];
    add(item: MediaItem): void;
    remove(id: string): void;
  };
};

export type Attachment = { url: string; assetId?: string; resultId?: string };

function itemOf(entry: Attachment, role: MediaRole): MediaItem {
  return {
    id: crypto.randomUUID(),
    url: entry.url,
    role,
    ...(entry.assetId ? { assetId: entry.assetId } : {}),
    ...(entry.resultId ? { resultId: entry.resultId } : {}),
  };
}

/** Adds to a role. A one-slot role (a start frame) is replaced; a list role
    fills up to its cap and reports what did not fit. */
export function addToRole(
  store: RoleStore,
  role: MediaRole,
  entries: Attachment[],
  cap: number,
): { added: number; replaced: boolean; left: number } {
  const state = store.getState();
  const existing = state.items.filter((item) => item.role === role);
  if (cap <= 1) {
    const first = entries[0];
    if (!first) return { added: 0, replaced: false, left: 0 };
    for (const item of existing) state.remove(item.id);
    state.add(itemOf(first, role));
    return { added: 1, replaced: existing.length > 0, left: entries.length - 1 };
  }
  let room = cap - existing.length;
  let added = 0;
  let left = 0;
  for (const entry of entries) {
    if (existing.some((item) => item.url === entry.url)) continue;
    if (room <= 0) {
      left++;
      continue;
    }
    state.add(itemOf(entry, role));
    room--;
    added++;
  }
  return { added, replaced: false, left };
}

/** Makes a role's set exactly these urls: what survives keeps its id and its
    place, what is gone leaves, what is new arrives with the lineage the
    caller knows for it. */
export function replaceRole(
  store: RoleStore,
  role: MediaRole,
  urls: string[],
  lineage: (url: string) => Omit<Attachment, "url">,
): void {
  const state = store.getState();
  const keep = new Set(urls);
  const held = new Set<string>();
  for (const item of state.items) {
    if (item.role !== role) continue;
    if (keep.has(item.url)) held.add(item.url);
    else state.remove(item.id);
  }
  for (const url of urls) {
    if (!held.has(url)) state.add(itemOf({ url, ...lineage(url) }, role));
  }
}
