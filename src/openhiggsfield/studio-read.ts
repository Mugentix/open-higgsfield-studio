import type { StudioReadResult, StudioResource } from "@/server/studio-reads";

/** Independent screen reads must not wait behind Next's server-action queue.
    Preserve the action result envelope so callers keep their error handling. */
export async function readStudio<K extends StudioResource>(resource: K, input?: unknown, signal?: AbortSignal): Promise<StudioReadResult<K>> {
  const query = input === undefined ? "" : `?${new URLSearchParams({ input: JSON.stringify(input) })}`;
  try {
    const response = await fetch(`/api/studio/${resource}${query}`, { cache: "no-store", credentials: "same-origin", signal });
    return await response.json();
  } catch (caught) {
    if (signal?.aborted) throw caught;
    return { ok: false, error: "Could not load the studio; check your connection and try again" } as StudioReadResult<K>;
  }
}
