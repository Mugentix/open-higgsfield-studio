import { getSessionCookie } from "better-auth/cookies";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/* The optimistic gate: no session cookie, no studio. Every page and action
   still validates the session properly; this only spares a signed-out visitor
   a render of the studio shell before the redirect. */
const OPEN = ["/login", "/invite"];

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (OPEN.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))) {
    return NextResponse.next();
  }
  if (getSessionCookie(request)) return NextResponse.next();
  const login = new URL("/login", request.url);
  if (pathname !== "/") login.searchParams.set("next", pathname + request.nextUrl.search);
  return NextResponse.redirect(login);
}

export const config = {
  /* /media is the local store's public face and is fetched without cookies
     by the server itself; gating it would hand that fetch the sign-in page. */
  matcher: ["/((?!api|media/|_next/static|_next/image|favicon.ico|model-icons|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|txt|xml|webmanifest)$).*)"],
};
