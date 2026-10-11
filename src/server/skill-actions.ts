"use server";

import type { SkillRecord } from "./agents-contract";
import { listSkills as skillsOf, removeSkill } from "./agents";
import { guarded, type ActionResult } from "./result";
import { requireTeam } from "./team";

/* The skills library. Uploads do not come through here: a zip is a multipart
   POST to /api/skills, which runs the same install the worker trusts. */

/** The team's skills, by name; any member may look. */
export async function listSkills(): Promise<ActionResult<SkillRecord[]>> {
  return guarded(async () => {
    const team = await requireTeam();
    return skillsOf(team);
  });
}

/** Owners and admins only — a skill is code that runs as the worker. */
export async function deleteSkill(data: unknown): Promise<ActionResult<null>> {
  return guarded(async () => {
    const team = await requireTeam({ role: ["owner", "admin"] });
    return removeSkill(team, readId(typeof data === "string" ? data : asObject(data).id, "No such skill"));
  });
}

function readId(value: unknown, message: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 100) throw new Error(message);
  return value;
}

function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
