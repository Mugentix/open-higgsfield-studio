"use server";

import { and, desc, eq, isNull } from "drizzle-orm";

import { db, schema } from "./db/client";
import { guarded, type ActionResult } from "./result";
import { requireTeam } from "./team";

export type AssetRecord = {
  id: string;
  url: string;
  kind: "image" | "video" | "audio";
  name: string;
  productId: string | null;
  pin: number | null;
  createdAt: number;
};

const LIMIT = 300;

/** The team's ready uploads and frames, newest first. */
export async function listAssets(data: unknown): Promise<ActionResult<AssetRecord[]>> {
  return guarded(async () => {
    const team = await requireTeam();
    const record = asObject(data);
    const kind = typeof record.kind === "string" ? record.kind : undefined;
    const rows = await db.query.assets.findMany({
      where: and(
        eq(schema.assets.teamId, team.teamId),
        eq(schema.assets.status, "ready"),
        isNull(schema.assets.deletedAt),
        ...(kind ? [eq(schema.assets.kind, kind)] : []),
      ),
      orderBy: desc(schema.assets.createdAt),
      limit: LIMIT,
    });
    return rows.map((row) => ({
      id: row.id,
      url: row.url,
      kind: row.kind as AssetRecord["kind"],
      name: row.name,
      productId: row.productId,
      pin: row.pin,
      createdAt: row.createdAt.getTime(),
    }));
  });
}

/** Puts a file on a product's shelf (or takes it off with productId null). */
export async function setAssetProduct(data: unknown): Promise<ActionResult<AssetRecord>> {
  return guarded(async () => {
    const team = await requireTeam();
    const record = asObject(data);
    if (typeof record.assetId !== "string") throw new Error("No such file");
    const productId = typeof record.productId === "string" ? record.productId : null;
    if (productId) {
      const product = await db.query.products.findFirst({
        where: and(eq(schema.products.id, productId), eq(schema.products.teamId, team.teamId)),
        columns: { id: true },
      });
      if (!product) throw new Error("No such product");
    }
    const [row] = await db
      .update(schema.assets)
      .set({ productId, pin: productId ? undefined : null })
      .where(and(eq(schema.assets.id, record.assetId), eq(schema.assets.teamId, team.teamId)))
      .returning();
    if (!row) throw new Error("No such file");
    return {
      id: row.id,
      url: row.url,
      kind: row.kind as AssetRecord["kind"],
      name: row.name,
      productId: row.productId,
      pin: row.pin,
      createdAt: row.createdAt.getTime(),
    };
  });
}

export async function removeAsset(assetId: unknown): Promise<ActionResult<null>> {
  return guarded(async () => {
    const team = await requireTeam();
    if (typeof assetId !== "string") throw new Error("No such file");
    await db
      .update(schema.assets)
      .set({ deletedAt: new Date() })
      .where(and(eq(schema.assets.id, assetId), eq(schema.assets.teamId, team.teamId)));
    return null;
  });
}

function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
