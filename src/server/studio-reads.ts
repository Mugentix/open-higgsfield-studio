import { getCredits, getKeyStatus } from "@/generation/actions";
import { listAssets } from "./asset-actions";
import { getGalleryFacets, listGallery, syncGallery } from "./gallery-actions";
import { getWorkspace } from "./project-actions";
import { getSpend } from "./spend-actions";
import { getTeamOverview } from "./team-actions";
import { listTemplates } from "./template-actions";

/* Only reads belong here. Each operation still validates the session and
   scopes its queries to the caller's team. Mutations remain server actions. */
export const studioReads = {
  workspace: getWorkspace,
  gallery: listGallery,
  changes: syncGallery,
  facets: getGalleryFacets,
  assets: listAssets,
  "key-status": getKeyStatus,
  team: getTeamOverview,
  templates: listTemplates,
  spend: getSpend,
  credits: getCredits,
};

export type StudioResource = keyof typeof studioReads;
export type StudioReadResult<K extends StudioResource> = Awaited<ReturnType<(typeof studioReads)[K]>>;
