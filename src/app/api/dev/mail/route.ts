import { NextResponse } from "next/server";

import { devMailbox, emailConfigured } from "@/server/email";

/* The development mailbox: the sign-in links and invitations a local checkout
   would have emailed. Absent in production and whenever real email is set up. */
export async function GET(request: Request): Promise<NextResponse> {
  const host = request.headers.get("host") ?? "";
  const loopback = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host);
  if (process.env.NODE_ENV === "production" || process.env.VERCEL || emailConfigured() || !loopback) {
    return new NextResponse(null, { status: 404 });
  }
  return NextResponse.json({ mail: devMailbox() });
}
