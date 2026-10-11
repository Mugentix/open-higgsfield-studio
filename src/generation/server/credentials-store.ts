import { eq } from "drizzle-orm";

import { MissingCredentialsError } from "../credentials";
import { KIE_API_BASE_URL, KIE_UPLOAD_BASE_URL } from "../kie/client";
import { db, schema } from "@/server/db/client";
import { unseal } from "@/server/secrets";
import type { TeamContext } from "@/server/team";

/* Server-only. The team's own key, sealed in team_settings, wins; a deployment
   may hold one KIE_API_KEY as the fallback for every team that has not set
   its own. Nothing here ever reaches the browser. */

export type PlatformCredentials = {
  apiKey: string;
  baseUrl: string;
  uploadBaseUrl: string;
};

export type KeySource = "team" | "env" | null;

export async function readTeamKey(teamId: string): Promise<{ apiKey: string; last4: string } | null> {
  const row = await db.query.teamSettings.findFirst({ where: eq(schema.teamSettings.teamId, teamId) });
  if (!row?.kieApiKeyEnc) return null;
  return { apiKey: unseal(row.kieApiKeyEnc), last4: row.kieKeyLast4 ?? "" };
}

export async function keySource(teamId: string): Promise<KeySource> {
  if (await readTeamKey(teamId)) return "team";
  return keyFromEnvironment() ? "env" : null;
}

/** Credentials for a team by id: what jobs use, with no session in scope. */
export async function readTeamCredentials(teamId: string): Promise<PlatformCredentials> {
  const own = await readTeamKey(teamId);
  const apiKey = own?.apiKey ?? process.env.KIE_API_KEY?.trim();
  if (!apiKey) throw new MissingCredentialsError();
  return {
    apiKey,
    baseUrl: process.env.KIE_API_BASE_URL?.trim() || KIE_API_BASE_URL,
    uploadBaseUrl: process.env.KIE_UPLOAD_BASE_URL?.trim() || KIE_UPLOAD_BASE_URL,
  };
}

export async function readCredentials(team: TeamContext): Promise<PlatformCredentials> {
  return readTeamCredentials(team.teamId);
}

export function keyFromEnvironment(): boolean {
  return Boolean(process.env.KIE_API_KEY?.trim());
}
