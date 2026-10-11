/** Catalog ids that were retired or renamed in the move to KIE, mapped to the
    entry that now does the same job. History rows and persisted picks made
    under the old id resolve through here, so Reuse still lands on a model. */
export const LEGACY_MODEL_IDS: Record<string, string> = {
  "ideogram-4": "ideogram-3",
  "z-image-turbo": "z-image",
  "kling-o1": "kling-3-omni",
  "kling-o3": "kling-3-omni",
};

export function resolveModelId(id: string): string {
  return LEGACY_MODEL_IDS[id] ?? id;
}
