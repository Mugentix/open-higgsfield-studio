import { NextResponse } from "next/server";

import { isSafeKey } from "@/server/storage/keys";
import { LocalStore, verifyPut } from "@/server/storage/local";

export const runtime = "nodejs";

/* The local store's presigned PUT: the signature covers key, type, size and
   expiry, exactly what a bucket's presigned url would. */
export async function PUT(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  const key = url.searchParams.get("key") ?? "";
  const type = url.searchParams.get("type") ?? "";
  const size = Number(url.searchParams.get("size"));
  const exp = Number(url.searchParams.get("exp"));
  const sig = url.searchParams.get("sig") ?? "";
  if (!isSafeKey(key) || !verifyPut(key, type, size, exp, sig)) {
    return NextResponse.json({ error: "Bad or expired upload signature" }, { status: 403 });
  }
  if (!request.body) return NextResponse.json({ error: "Empty body" }, { status: 400 });
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) !== size) {
    return NextResponse.json({ error: `Expected ${size} bytes` }, { status: 400 });
  }
  let bytes: number;
  try {
    ({ bytes } = await new LocalStore().put(key, request.body, type, size));
  } catch (caught) {
    return NextResponse.json({ error: caught instanceof Error ? caught.message : "Upload failed" }, { status: 400 });
  }
  if (bytes !== size) {
    await new LocalStore().remove(key);
    return NextResponse.json({ error: `Expected ${size} bytes, received ${bytes}` }, { status: 400 });
  }
  return new NextResponse(null, { status: 200 });
}
