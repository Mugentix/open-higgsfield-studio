"use server";

import { and, eq } from "drizzle-orm";

import { resolveModelId, type GenerationPlane, type MediaItem, type MediaRole } from "@/generation/catalog";
import type { CreatedRun } from "@/generation/views";

import { db, schema } from "./db/client";
import { kickJobs } from "./jobs/runner";
import { guarded, type ActionResult } from "./result";
import { createRun } from "./runs";
import { requireTeam } from "./team";

const MAX_VARIANTS = 4;

/** Variants: the plane a result was made from, submitted again N times under
    one batch, each run remembering the result it came from. */
export async function replayRun(data: unknown): Promise<ActionResult<CreatedRun[]>> {
  return guarded(async () => {
    const team = await requireTeam();
    const record = asObject(data);
    if (typeof record.resultId !== "string") throw new Error("No such result");
    const count = Math.min(MAX_VARIANTS, Math.max(1, Math.round(Number(record.count) || 1)));
    const batchId = typeof record.batchId === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(record.batchId) ? record.batchId : null;
    if (!batchId) throw new Error("Invalid batch");

    const result = await db.query.results.findFirst({
      where: and(eq(schema.results.id, record.resultId), eq(schema.results.teamId, team.teamId)),
      with: { run: true },
    });
    if (!result) throw new Error("No such result");
    const run = result.run;
    const media: GenerationPlane["media"] = {};
    for (const entry of run.media) {
      const role = entry.role as MediaRole;
      const item: MediaItem = {
        id: `${role}-${(media[role]?.length ?? 0) + 1}`,
        url: entry.url,
        role,
        ...(entry.assetId ? { assetId: entry.assetId } : {}),
        ...(entry.resultId ? { resultId: entry.resultId } : {}),
      };
      (media[role] ??= []).push(item);
    }
    const plane: GenerationPlane = {
      model: resolveModelId(run.modelId),
      prompt: { text: run.prompt },
      media,
      settings: run.settings,
    };
    const created: CreatedRun[] = [];
    for (let index = 0; index < count; index++) {
      created.push(
        await createRun(team, {
          plane,
          idempotencyKey: `${batchId}-${index}`,
          projectId: run.projectId,
          batchId,
          parentResultId: result.id,
        }),
      );
    }
    kickJobs();
    return created;
  });
}

function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
