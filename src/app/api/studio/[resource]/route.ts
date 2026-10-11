import { NextResponse } from "next/server";
import { studioReads, type StudioResource } from "@/server/studio-reads";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* GETs can load independently; browser-dispatched server actions share a
   single queue, making a slow background read hold up navigation. */
export async function GET(request: Request, context: { params: Promise<{ resource: string }> }) {
  const { resource } = await context.params;
  const headers = { "Cache-Control": "private, no-store" };
  if (!Object.hasOwn(studioReads, resource)) {
    return NextResponse.json({ ok: false, error: "No such studio resource" }, { status: 404, headers });
  }
  let input: unknown;
  try {
    const raw = new URL(request.url).searchParams.get("input");
    if (raw && raw.length > 16_000) throw new Error("Too much input");
    input = raw ? JSON.parse(raw) : undefined;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid read parameters", code: "invalid" }, { status: 400, headers });
  }
  const start = performance.now();
  const result = await studioReads[resource as StudioResource](input);
  const status = result.ok ? 200 : result.code === "unauthenticated" ? 401 : result.code === "forbidden" || result.code === "no_team" ? 403 : 400;
  return NextResponse.json(result, {
    status,
    headers: { ...headers, "Server-Timing": `read;dur=${(performance.now() - start).toFixed(1)}` },
  });
}
