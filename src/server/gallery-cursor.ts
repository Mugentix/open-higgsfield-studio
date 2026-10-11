/* The change feed's cursor, shared by the server that answers it and the
   studio that asks: nothing in here may import the database, or the browser
   bundle would try to carry the Postgres driver. */

/** Where a change feed left off: a keyset on (updated_at, id), so a burst of
    rows stamped in one statement can never be half-delivered. */
export type ChangeCursor = { updatedAt: number; id: string };

/** How far behind the database clock a not-full feed page answers `until`:
    at least as long as the longest write transaction, so a row stamped
    before the read but committed after it is still delivered next tick. */
export const CHANGE_OVERLAP_MS = 5_000;

export function compareChangeCursor(a: ChangeCursor, b: ChangeCursor): number {
  return a.updatedAt - b.updatedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
