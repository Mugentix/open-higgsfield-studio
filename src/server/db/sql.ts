import type { SQL } from "drizzle-orm";

import { db } from "./client";

/** Raw statements answer differently per driver (PGlite wraps rows, postgres.js
    is the array); this reads them the same way. */
export async function rows<T = Record<string, unknown>>(statement: SQL): Promise<T[]> {
  const result = (await db.execute(statement)) as unknown;
  if (Array.isArray(result)) return result as T[];
  const wrapped = result as { rows?: unknown };
  return Array.isArray(wrapped.rows) ? (wrapped.rows as T[]) : [];
}
