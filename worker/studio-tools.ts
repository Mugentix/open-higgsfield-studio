import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import type { StudioHooks } from "./runtime";

/* The agent's hands into the studio, as an in-process MCP server. Claude
   Code sees them as mcp__studio__publish, mcp__studio__note and
   mcp__studio__report_credits; the system prompt append tells the agent
   when to reach for each. The handlers only call back into the run's hooks,
   so the same tools serve a test double. */

export const STUDIO_SERVER_NAME = "studio";

export function studioToolDefinitions(hooks: StudioHooks) {
  return [
    tool(
      "publish",
      "Publish a finished deliverable from this run to the team's wall (the gallery). `path` is relative to the working directory, usually under outputs/. Returns the public url. Call it once per finished file; the studio also keeps every file under outputs/ as a run artifact without publishing it.",
      { path: z.string().min(1).max(500), title: z.string().max(200).optional() },
      async ({ path, title }) => {
        try {
          const { url } = await hooks.publish(path, title ?? null);
          return { content: [{ type: "text" as const, text: `Published ${path} → ${url}` }] };
        } catch (caught) {
          return { content: [{ type: "text" as const, text: `Could not publish ${path}: ${message(caught)}` }], isError: true };
        }
      },
    ),
    tool(
      "note",
      "Leave a short note in the run's activity stream for the team (a decision taken, a caveat, where a file is). Markdown. Not for questions: ask those by ending your turn.",
      { text: z.string().min(1).max(4000) },
      async ({ text }) => {
        await hooks.note(text);
        return { content: [{ type: "text" as const, text: "Noted." }] };
      },
    ),
    tool(
      "report_credits",
      "Report KIE credits this run spent (from a job's creditsConsumed or a script's summary) so the studio can show the run's spend next to its dollar cost. Add up what you report; call it once per paid batch.",
      { credits: z.number().nonnegative().max(1_000_000) },
      async ({ credits }) => {
        await hooks.reportCredits(credits);
        return { content: [{ type: "text" as const, text: `Recorded ${credits} credits.` }] };
      },
    ),
  ];
}

export function createStudioServer(hooks: StudioHooks) {
  return createSdkMcpServer({
    name: STUDIO_SERVER_NAME,
    version: "1.0.0",
    instructions: "Tools of the studio this run lives in: publish deliverables to the team wall, leave notes, report KIE credits spent.",
    tools: studioToolDefinitions(hooks),
  });
}

function message(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}
