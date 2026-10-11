"use server";

import { parseCredentialInput } from "./credentials";
import { parsePlane } from "./parse-plane";
import { createPlatformClient } from "./platform";
import { keySource, readCredentials, type KeySource } from "./server/credentials-store";
import type { CreatedRun, RunView } from "./views";
import { db, schema } from "@/server/db/client";
import { kickJobs } from "@/server/jobs/runner";
import { guarded, type ActionResult } from "@/server/result";
import { createRun, syncRuns } from "@/server/runs";
import { last4, seal } from "@/server/secrets";
import { canManage, requireTeam } from "@/server/team";

export type KeyStatus = {
  source: KeySource;
  last4: string | null;
  canManage: boolean;
};

/** Where the team's KIE key comes from and whether this member may change it. */
export async function getKeyStatus(): Promise<ActionResult<KeyStatus>> {
  return guarded(async () => {
    const team = await requireTeam();
    const source = await keySource(team.teamId);
    const row =
      source === "team"
        ? await db.query.teamSettings.findFirst({
            where: (t, { eq }) => eq(t.teamId, team.teamId),
            columns: { kieKeyLast4: true },
          })
        : null;
    return { source, last4: row?.kieKeyLast4 ?? null, canManage: canManage(team.role) };
  });
}

/** Owners and admins set the team's key. It is proved against KIE's credit
    endpoint before it is sealed and kept. */
export async function saveTeamKey(data: unknown): Promise<ActionResult<KeyStatus>> {
  return guarded(async () => {
    const team = await requireTeam({ role: ["owner", "admin"] });
    const { apiKey } = parseCredentialInput(data);
    await createPlatformClient({ apiKey }).credits();
    await db
      .insert(schema.teamSettings)
      .values({ teamId: team.teamId, kieApiKeyEnc: seal(apiKey), kieKeyLast4: last4(apiKey), updatedBy: team.userId })
      .onConflictDoUpdate({
        target: schema.teamSettings.teamId,
        set: { kieApiKeyEnc: seal(apiKey), kieKeyLast4: last4(apiKey), updatedBy: team.userId, updatedAt: new Date() },
      });
    return { source: "team" as const, last4: last4(apiKey), canManage: true };
  });
}

export async function clearTeamKey(): Promise<ActionResult<KeyStatus>> {
  return guarded(async () => {
    const team = await requireTeam({ role: ["owner", "admin"] });
    await db
      .insert(schema.teamSettings)
      .values({ teamId: team.teamId, kieApiKeyEnc: null, kieKeyLast4: null, updatedBy: team.userId })
      .onConflictDoUpdate({
        target: schema.teamSettings.teamId,
        set: { kieApiKeyEnc: null, kieKeyLast4: null, updatedBy: team.userId, updatedAt: new Date() },
      });
    return { source: await keySource(team.teamId), last4: null, canManage: true };
  });
}

/** Remaining credits on the account the team's key belongs to. */
export async function getCredits(): Promise<ActionResult<number | null>> {
  return guarded(async () => {
    const team = await requireTeam();
    try {
      return await createPlatformClient(await readCredentials(team)).credits();
    } catch {
      return null;
    }
  });
}

/** One press, one run: recorded, then handed to KIE. The idempotency key is
    the press's own, so a retried call never pays twice. */
export async function submitGeneration(data: unknown): Promise<ActionResult<CreatedRun>> {
  return guarded(async () => {
    const team = await requireTeam();
    const record = asObject(data, "Invalid generation");
    const plane = parsePlane(record.plane);
    const idempotencyKey = typeof record.idempotencyKey === "string" && record.idempotencyKey ? record.idempotencyKey : null;
    if (!idempotencyKey || idempotencyKey.length > 80) throw new Error("Invalid generation");
    const created = await createRun(team, {
      plane,
      idempotencyKey,
      ...(typeof record.projectId === "string" ? { projectId: record.projectId } : {}),
      ...(typeof record.batchId === "string" ? { batchId: record.batchId } : {}),
      ...(typeof record.parentResultId === "string" ? { parentResultId: record.parentResultId } : {}),
    });
    kickJobs();
    return created;
  });
}

/** Every run in flight, answered in one round trip. Next dispatches server
    actions one at a time per client, so a poll per run would queue ahead of the
    next submit — the fan-out belongs on this side of the call. The rows are
    read first; only runs due a look ask KIE. */
export async function getGenerationStatuses(data: unknown): Promise<ActionResult<RunView[]>> {
  return guarded(async () => {
    const team = await requireTeam();
    const views = await syncRuns(team, parseRequestIds(data));
    kickJobs();
    return views;
  });
}

function parseRequestIds(data: unknown): string[] {
  const payload = asObject(data, "Invalid status payload");
  const requestIds = payload.requestIds;
  if (!Array.isArray(requestIds) || requestIds.length === 0 || requestIds.length > 64) {
    throw new Error("Invalid request ids");
  }
  return requestIds.map((requestId) => {
    if (typeof requestId !== "string" || !requestId || requestId.length > 200) {
      throw new Error("Invalid request id");
    }
    return requestId;
  });
}

function asObject(data: unknown, message: string): Record<string, unknown> {
  if (data === null || typeof data !== "object" || Array.isArray(data)) throw new Error(message);
  return data as Record<string, unknown>;
}
