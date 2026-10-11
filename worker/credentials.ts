import { MissingCredentialsError } from "@/generation/credentials";
import { readTeamCredentials } from "@/generation/server/credentials-store";

/* The keys a run's scripts read for KIE, resolved the way the studio
   resolves them: the team's own sealed key first, the deployment's fallback
   after. A team without either still runs — its paid steps will say so. */

export async function teamCredentials(teamId: string): Promise<Record<string, string>> {
  try {
    const credentials = await readTeamCredentials(teamId);
    return { KIE_API_KEY: credentials.apiKey, KIE_API_BASE_URL: credentials.baseUrl, KIE_UPLOAD_BASE_URL: credentials.uploadBaseUrl };
  } catch (caught) {
    if (caught instanceof MissingCredentialsError) return {};
    throw caught;
  }
}
