import { create } from "zustand";
import { persist } from "zustand/middleware";

import { getModel, resolveModelId } from "../catalog";
import type { Surface } from "../catalog/types";
import { browserStorage } from "./browser-storage";

/** Results one press of Generate produces. Models that do not carry a count of
    their own are submitted once per result — every unit is a real platform
    request — so the ceiling is deliberately small. */
export const MAX_BATCH = 4;

type ActiveState = {
  surface: Surface;
  model: string;
  batch: number;
  /** The project the next run lands in; null until the workspace answers. */
  projectId: string | null;
  setModel: (id: string) => void;
  setBatch: (count: number) => void;
  setProject: (id: string | null) => void;
};

export const useActive = create<ActiveState>()(
  persist(
    (set) => ({
      surface: "video",
      model: "seedance-2.5",
      batch: 1,
      projectId: null,
      setProject: (id) => set((state) => (state.projectId === id ? state : { projectId: id })),
      setModel: (id) => {
        const model = getModel(id);
        set((state) =>
          state.model === model.id && state.surface === model.surface
            ? state
            : { model: model.id, surface: model.surface },
        );
      },
      setBatch: (count) =>
        set((state) => {
          const batch = Math.min(MAX_BATCH, Math.max(1, Math.round(count)));
          return state.batch === batch ? state : { batch };
        }),
    }),
    {
      name: "openhiggsfield.active.v3",
      storage: browserStorage(),
      partialize: (state) => ({ surface: state.surface, model: state.model, batch: state.batch, projectId: state.projectId }),
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        try {
          getModel(resolveModelId(state.model));
          if (resolveModelId(state.model) !== state.model) state.setModel(resolveModelId(state.model));
        } catch {
          state.setModel("seedance-2.5");
        }
      },
    },
  ),
);
