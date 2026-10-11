import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { NextResponse } from "next/server";

import { isSafeKey, mimeForKey } from "@/server/storage/keys";
import { localPath } from "@/server/storage/local";

export const runtime = "nodejs";

/* Serves the local media store. With R2 configured this route is never
   linked to; objects live on the media domain. */
export async function GET(_request: Request, context: { params: Promise<{ key: string[] }> }) {
  const { key: parts } = await context.params;
  const key = parts.join("/");
  if (!isSafeKey(key)) return new NextResponse(null, { status: 400 });
  let file: string;
  try {
    file = localPath(key);
  } catch {
    return new NextResponse(null, { status: 400 });
  }
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) return new NextResponse(null, { status: 404 });
  const stream = Readable.toWeb(createReadStream(file)) as ReadableStream<Uint8Array>;
  return new NextResponse(stream, {
    headers: {
      "Content-Type": mimeForKey(key),
      "Content-Length": String(info.size),
      "Cache-Control": "public, max-age=31536000, immutable",
      "Access-Control-Allow-Origin": "*",
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": "inline",
    },
  });
}
