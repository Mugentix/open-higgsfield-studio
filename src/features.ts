/* Surfaces that are built and tested but not offered to the team yet. The
   flag is a build-time constant in the browser and reads the environment on
   the server, so a checkout turns a surface on by setting it in .env.local
   and restarting. Off, the surface is absent: no entry, no page, no upload. */

/** The skill runner at /agents (see docs/agent-worker.md for the worker). */
export const AGENTS_ENABLED = process.env.NEXT_PUBLIC_AGENTS === "1";
