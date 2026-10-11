"use server";

import { guarded, type ActionResult } from "./result";
import { summarizeSpend, type SpendReport } from "./spend";
import { DEFAULT_SPEND_DAYS, isSpendDays, type SpendDays } from "./spend-periods";
import { requireTeam } from "./team";

/** The team's credit spend over the last 7, 30 or 90 days; any member may look. */
export async function getSpend(data: unknown): Promise<ActionResult<SpendReport>> {
  return guarded(async () => {
    const team = await requireTeam();
    return summarizeSpend(team, readDays(asObject(data).days));
  });
}

function readDays(value: unknown): SpendDays {
  return isSpendDays(value) ? value : DEFAULT_SPEND_DAYS;
}

function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
