import { drizzle as drizzlePg } from "drizzle-orm/postgres-js";
import { migrate as migratePg } from "drizzle-orm/postgres-js/migrator";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import { mkdirSync } from "node:fs";
import path from "node:path";
import postgres from "postgres";

import * as schema from "./schema";

/* One database module for two drivers. DATABASE_URL points at Postgres (Neon,
   Supabase, a box); without it a local checkout gets an embedded PGlite under
   .data/pglite so nothing waits on infrastructure. The schema and the SQL
   migrations under drizzle/ are the same either way. */

export type Db = ReturnType<typeof drizzlePg<typeof schema>> | ReturnType<typeof drizzlePglite<typeof schema>>;

const MIGRATIONS = path.join(process.cwd(), "drizzle");
const PGLITE_DIR = path.join(process.cwd(), ".data", "pglite");

type Holder = { db: Db; ready: Promise<void>; kind: "postgres" | "pglite" };

declare global {
  // eslint-disable-next-line no-var
  var __ohfDb: Holder | undefined;
}

function open(): Holder {
  const url = process.env.DATABASE_URL?.trim();
  if (url) {
    const client = postgres(url, { max: 10, prepare: false });
    const db = drizzlePg(client, { schema });
    /* Production runs `pnpm db:migrate` at deploy time; here we only make sure
       a fresh database is not silently empty. */
    const ready = process.env.DB_AUTO_MIGRATE === "1" ? migratePg(db, { migrationsFolder: MIGRATIONS }) : Promise.resolve();
    return { db, ready, kind: "postgres" };
  }
  mkdirSync(PGLITE_DIR, { recursive: true });
  const db = drizzlePglite(PGLITE_DIR, { schema });
  const ready = migratePglite(db, { migrationsFolder: MIGRATIONS });
  return { db, ready, kind: "pglite" };
}

function holder(): Holder {
  /* Next's dev server re-evaluates modules; the handle survives on the global.
     A migration that failed is not kept: the next request opens again. */
  if (!globalThis.__ohfDb) {
    const next = open();
    next.ready.catch(() => {
      if (globalThis.__ohfDb === next) globalThis.__ohfDb = undefined;
    });
    globalThis.__ohfDb = next;
  }
  return globalThis.__ohfDb;
}

export const db: Db = new Proxy({} as Db, {
  get(_target, prop) {
    const value = Reflect.get(holder().db as object, prop);
    return typeof value === "function" ? value.bind(holder().db) : value;
  },
});

/** Resolves once migrations have run; every request path awaits it first. */
export function dbReady(): Promise<void> {
  return holder().ready;
}

export function dbKind(): "postgres" | "pglite" {
  return holder().kind;
}

export { schema };
