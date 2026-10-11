import { NextResponse } from "next/server";

import { MissingCredentialsError } from "@/generation/credentials";
import { createKieClient } from "@/generation/kie/client";
import { readCredentials } from "@/generation/server/credentials-store";
import { NoTeamError, UnauthenticatedError, requireTeam } from "@/server/team";

export const runtime = "nodejs";

/* Mirrors ROLE_ACCEPT in src/openhiggsfield/data.ts: what the media tray lets
   a visitor pick is exactly what this route lets through. */
const ALLOWED_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "video/mp4",
  "video/quicktime",
  "audio/wav",
  "audio/x-wav",
  "audio/mpeg",
]);
const MAX_BYTES = 200 * 1024 * 1024;

export async function POST(request: Request): Promise<NextResponse> {
  let team;
  try {
    team = await requireTeam();
  } catch (caught) {
    if (caught instanceof UnauthenticatedError) return NextResponse.json({ error: "Sign in to upload" }, { status: 401 });
    if (caught instanceof NoTeamError) return NextResponse.json({ error: "Join a team to upload" }, { status: 403 });
    throw caught;
  }
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "Expected a multipart upload" }, { status: 400 });
  }
  const file = form.get("file");
  if (!(file instanceof Blob)) return NextResponse.json({ error: "No file" }, { status: 400 });
  if (!ALLOWED_TYPES.has(file.type)) {
    return NextResponse.json({ error: `Unsupported file type ${file.type || "(unknown)"}` }, { status: 415 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: "File larger than 200 MB" }, { status: 413 });
  }

  const original = file instanceof File ? file.name : "upload";
  const fileName = `${crypto.randomUUID().slice(0, 8)}-${sanitizeFilename(original)}`;
  const day = new Date().toISOString().slice(0, 10);
  try {
    const kie = createKieClient(await readCredentials(team));
    const { url } = await kie.uploadStream(file, fileName, `openhiggsfield/${day}`);
    console.info("[upload]", file.type, file.size);
    return NextResponse.json({ url });
  } catch (caught) {
    if (caught instanceof MissingCredentialsError) {
      return NextResponse.json({ error: "Add your KIE API key first" }, { status: 401 });
    }
    const message = caught instanceof Error ? caught.message : "upload failed";
    console.error("[upload] failed", message);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

function sanitizeFilename(filename: string): string {
  const base = filename.replaceAll("\\", "/").split("/").pop() ?? "";
  const cleaned = base.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "");
  return cleaned.slice(0, 120) || "file";
}
