import { defineConfig } from "drizzle-kit";

/* Postgres in production (DATABASE_URL), an embedded PGlite under .data/ for a
   local checkout. Both run the same SQL migrations under drizzle/. */
const url = process.env.DATABASE_URL?.trim();

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/server/db/schema/index.ts",
  out: "./drizzle",
  ...(url ? { dbCredentials: { url } } : { driver: "pglite", dbCredentials: { url: "./.data/pglite" } }),
});
