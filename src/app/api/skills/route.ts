import { NextResponse } from "next/server";

import { AGENTS_ENABLED } from "@/features";
import { installSkillFromZip } from "@/server/agents";
import { SKILL_ZIP_MAX_BYTES } from "@/server/agents-contract";
import { messageOf } from "@/server/result";
import { ForbiddenError, NoTeamError, UnauthenticatedError, requireTeam } from "@/server/team";

export const runtime = "nodejs";

/* A skill bundle arrives here as multipart (field `file`), never through a
   server action: the zip is read whole, checked and re-zipped before it is
   stored. Admins only — a skill is code that runs as the worker user. The
   answer is the SkillRecord, "invalid" with its problems when the bundle was
   refused but kept, so the library can say why. */

/* Browsers disagree on what a .zip is called. */
const ZIP_TYPES = new Set(["application/zip", "application/x-zip-compressed", "application/x-zip", "application/octet-stream", ""]);

export async function POST(request: Request): Promise<NextResponse> {
  if (!AGENTS_ENABLED) return new NextResponse(null, { status: 404 });
  let team;
  try {
    team = await requireTeam({ role: ["owner", "admin"] });
  } catch (caught) {
    if (caught instanceof UnauthenticatedError) return NextResponse.json({ error: "Sign in to upload" }, { status: 401 });
    if (caught instanceof NoTeamError) return NextResponse.json({ error: "Join a team to upload" }, { status: 403 });
    if (caught instanceof ForbiddenError) return NextResponse.json({ error: "Only admins upload skills" }, { status: 403 });
    throw caught;
  }
  /* The declared length is checked before the body is read; the file's own
     size again after, since a form carries more than the file. */
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > SKILL_ZIP_MAX_BYTES + 64 * 1024) {
    return NextResponse.json({ error: `Bundle larger than ${SKILL_ZIP_MAX_BYTES / 1024 / 1024} MB` }, { status: 413 });
  }
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "Expected a multipart upload" }, { status: 400 });
  }
  const file = form.get("file");
  if (!(file instanceof Blob)) return NextResponse.json({ error: "No file" }, { status: 400 });
  const fileName = file instanceof File ? file.name : "skill.zip";
  if (!ZIP_TYPES.has(file.type) && !/\.zip$/i.test(fileName)) {
    return NextResponse.json({ error: `Expected a .zip, not ${file.type || fileName}` }, { status: 415 });
  }
  if (file.size > SKILL_ZIP_MAX_BYTES) {
    return NextResponse.json({ error: `Bundle larger than ${SKILL_ZIP_MAX_BYTES / 1024 / 1024} MB` }, { status: 413 });
  }

  try {
    const skill = await installSkillFromZip(team, {
      bytes: new Uint8Array(await file.arrayBuffer()),
      fileName,
      createdBy: team.userId,
    });
    console.info("[skills]", skill.status, skill.slug, skill.files, skill.sizeBytes);
    return NextResponse.json(skill);
  } catch (caught) {
    return NextResponse.json({ error: messageOf(caught) }, { status: 422 });
  }
}
