import { and, eq } from "drizzle-orm";
import { headers } from "next/headers";

import { auth } from "./auth";
import { db, dbReady, schema } from "./db/client";

export type Role = "owner" | "admin" | "member";

export type TeamContext = {
  userId: string;
  userName: string;
  userEmail: string;
  teamId: string;
  teamName: string;
  role: Role;
};

export class UnauthenticatedError extends Error {
  constructor() {
    super("Sign in to continue");
    this.name = "UnauthenticatedError";
  }
}

export class NoTeamError extends Error {
  constructor() {
    super("Create or join a team to continue");
    this.name = "NoTeamError";
  }
}

export class ForbiddenError extends Error {
  constructor(message = "Your role does not allow that") {
    super(message);
    this.name = "ForbiddenError";
  }
}

/** The signed-in user, or null. */
export async function readSession() {
  await dbReady();
  return auth.api.getSession({ headers: await headers() });
}

export async function requireSession() {
  const session = await readSession();
  if (!session) throw new UnauthenticatedError();
  return session;
}

/** The first line of every server action and page that touches team data:
    who is asking, which team, and with what role. Every query downstream is
    scoped by the teamId this returns, never by anything the client sent. */
export async function requireTeam(options: { role?: Role[] } = {}): Promise<TeamContext> {
  const session = await requireSession();
  const membership = await activeMembership(session.user.id, session.session.activeOrganizationId ?? null);
  if (!membership) throw new NoTeamError();
  const role = normalizeRole(membership.role);
  if (options.role && !options.role.includes(role)) throw new ForbiddenError();
  return {
    userId: session.user.id,
    userName: session.user.name,
    userEmail: session.user.email,
    teamId: membership.organizationId,
    teamName: membership.organization.name,
    role,
  };
}

/** The membership the session points at, or the member's first team when the
    session has none yet (a sign-in that predates the invitation). */
async function activeMembership(userId: string, activeOrganizationId: string | null) {
  if (activeOrganizationId) {
    const active = await db.query.member.findFirst({
      where: and(eq(schema.member.userId, userId), eq(schema.member.organizationId, activeOrganizationId)),
      with: { organization: true },
    });
    if (active) return active;
  }
  const first = await db.query.member.findFirst({
    where: eq(schema.member.userId, userId),
    orderBy: (m, { asc }) => [asc(m.createdAt)],
    with: { organization: true },
  });
  if (first) {
    await auth.api.setActiveOrganization({
      body: { organizationId: first.organizationId },
      headers: await headers(),
    });
  }
  return first ?? null;
}

function normalizeRole(raw: string): Role {
  const roles = raw.split(",").map((part) => part.trim());
  if (roles.includes("owner")) return "owner";
  if (roles.includes("admin")) return "admin";
  return "member";
}

export function canManage(role: Role): boolean {
  return role === "owner" || role === "admin";
}
