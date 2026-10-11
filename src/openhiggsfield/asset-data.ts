"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import { listAssets, type AssetRecord } from "@/server/asset-actions";
import { unwrap } from "@/server/result";

/* The team's uploads, read from the server: what one member sends from a
   laptop is on every teammate's shelf a moment later. */

export const ASSETS_KEY = ["assets"] as const;

export function useAssets() {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ASSETS_KEY,
    queryFn: async () => unwrap(await listAssets({})),
    staleTime: 15_000,
  });
  const refresh = useCallback(() => void client.invalidateQueries({ queryKey: ASSETS_KEY }), [client]);
  const remember = useCallback(
    (asset: AssetRecord) =>
      client.setQueryData<AssetRecord[]>(ASSETS_KEY, (current) => [asset, ...(current ?? []).filter((a) => a.id !== asset.id)]),
    [client],
  );
  return { assets: query.data ?? [], loading: query.isPending, refresh, remember };
}
