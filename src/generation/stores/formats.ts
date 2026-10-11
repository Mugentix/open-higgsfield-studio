import { create } from "zustand";
import { persist } from "zustand/middleware";

import { browserStorage } from "./browser-storage";

type FormatsState = {
  /** Extra ratios per model — the "also render in" set beside the primary
      aspectRatio the settings store holds. Kept as toggled; ratiosFor in
      src/generation/formats.ts checks them against the catalog on read. */
  byModel: Record<string, string[]>;
  toggle: (modelId: string, ratio: string) => void;
  clear: (modelId: string) => void;
};

/* A model with no extra ratios has no entry at all, so the record only ever
   lists models that fan out. */
function without(byModel: FormatsState["byModel"], modelId: string): FormatsState["byModel"] {
  const { [modelId]: _dropped, ...rest } = byModel;
  return rest;
}

export const useFormats = create<FormatsState>()(
  persist(
    (set) => ({
      byModel: {},
      toggle: (modelId, ratio) =>
        set((state) => {
          const current = state.byModel[modelId] ?? [];
          const next = current.includes(ratio)
            ? current.filter((entry) => entry !== ratio)
            : [...current, ratio];
          if (next.length === 0) return { byModel: without(state.byModel, modelId) };
          return { byModel: { ...state.byModel, [modelId]: next } };
        }),
      clear: (modelId) =>
        set((state) => (modelId in state.byModel ? { byModel: without(state.byModel, modelId) } : state)),
    }),
    { name: "openhiggsfield.formats.v1", storage: browserStorage(), partialize: (state) => ({ byModel: state.byModel }) },
  ),
);
