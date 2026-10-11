import { describe, expect, it } from "vitest";

import { ASSET_KEYS, productShelf } from "@/openhiggsfield/data";

/* The picker draws the shelf and Alt+1…9 counts it through one helper, so the
   digit on a tile is the key that attaches it. The order it pins is the
   order listAssets stores: slot first, then newest first. */

type Shelf = { id: string; kind: "image" | "video" | "audio"; productId: string | null; pin: number | null; createdAt: number };

const ASSETS: Shelf[] = [
  { id: "loose", kind: "image", productId: null, pin: null, createdAt: 900 },
  { id: "other-product", kind: "image", productId: "p2", pin: 1, createdAt: 800 },
  { id: "clip", kind: "video", productId: "p1", pin: 1, createdAt: 700 },
  { id: "unslotted-new", kind: "image", productId: "p1", pin: null, createdAt: 600 },
  { id: "unslotted-old", kind: "image", productId: "p1", pin: null, createdAt: 100 },
  { id: "slot-2", kind: "image", productId: "p1", pin: 2, createdAt: 500 },
  { id: "slot-1", kind: "image", productId: "p1", pin: 1, createdAt: 50 },
];

describe("productShelf", () => {
  it("keeps the product's files of the kind asked for, by slot then newest first", () => {
    expect(productShelf(ASSETS, "p1", "image").map((asset) => asset.id)).toEqual([
      "slot-1",
      "slot-2",
      "unslotted-new",
      "unslotted-old",
    ]);
    expect(productShelf(ASSETS, "p1", "video").map((asset) => asset.id)).toEqual(["clip"]);
  });

  it("is empty without a product", () => {
    expect(productShelf(ASSETS, null, "image")).toEqual([]);
  });

  it("leaves the input alone", () => {
    const before = ASSETS.map((asset) => asset.id);
    productShelf(ASSETS, "p1", "image");
    expect(ASSETS.map((asset) => asset.id)).toEqual(before);
  });

  it("gives the keys the first nine tiles", () => {
    expect(ASSET_KEYS).toBe(9);
    const many = Array.from({ length: 12 }, (_, i) => ({
      id: `a${i}`,
      kind: "image" as const,
      productId: "p1",
      pin: i + 1,
      createdAt: i,
    }));
    const keyed = productShelf(many, "p1", "image").slice(0, ASSET_KEYS);
    expect(keyed.map((asset) => asset.id)).toEqual(many.slice(0, 9).map((asset) => asset.id));
  });
});
