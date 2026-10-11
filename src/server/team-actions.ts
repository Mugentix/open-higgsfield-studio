"use server";

import { and, eq } from "drizzle-orm";
import { headers } from "next/headers";

import { auth } from "./auth";
import { db, schema } from "./db/client";
import { guarded, type ActionResult } from "./result";
import { ForbiddenError, canManage, requireSession, requireTeam, type Role } from "./team";

export type TeamMember = {
  memberId: string;
  userId: string;
  name: string;
  email: string;
  role: Role;
  joinedAt: number;
  isSelf: boolean;
};

export type PendingInvitation = {
  id: string;
  email: string;
  role: Role;
  expiresAt: number;
};

export type TeamOverview = {
  teamId: string;
  teamName: string;
  me: { userId: string; name: string; email: string; role: Role; canManage: boolean };
  members: TeamMember[];
  invitations: PendingInvitation[];
};

export async function getTeamOverview(): Promise<ActionResult<TeamOverview>> {
  return guarded(async () => {
    const team = await requireTeam();
    const [members, invitations] = await Promise.all([
      db.query.member.findMany({
        where: eq(schema.member.organizationId, team.teamId),
        with: { user: true },
        orderBy: (m, { asc }) => [asc(m.createdAt)],
      }),
      db.query.invitation.findMany({
        where: and(eq(schema.invitation.organizationId, team.teamId), eq(schema.invitation.status, "pending")),
        orderBy: (i, { desc }) => [desc(i.createdAt)],
      }),
    ]);
    return {
      teamId: team.teamId,
      teamName: team.teamName,
      me: { userId: team.userId, name: team.userName, email: team.userEmail, role: team.role, canManage: canManage(team.role) },
      members: members.map((m) => ({
        memberId: m.id,
        userId: m.userId,
        name: m.user.name,
        email: m.user.email,
        role: roleOf(m.role),
        joinedAt: m.createdAt.getTime(),
        isSelf: m.userId === team.userId,
      })),
      invitations: invitations
        .filter((i) => i.expiresAt.getTime() > Date.now())
        .map((i) => ({ id: i.id, email: i.email, role: roleOf(i.role ?? "member"), expiresAt: i.expiresAt.getTime() })),
    };
  });
}

/** The first member creates the team; everyone else arrives by invitation. */
export async function createTeam(data: unknown): Promise<ActionResult<{ teamId: string }>> {
  return guarded(async () => {
    await requireSession();
    const name = readName(data);
    const org = await auth.api.createOrganization({
      body: { name, slug: `${slugify(name)}-${suffix()}` },
      headers: await headers(),
    });
    if (!org) throw new Error("Could not create the team");
    await auth.api.setActiveOrganization({ body: { organizationId: org.id }, headers: await headers() });
    return { teamId: org.id };
  });
}

export async function inviteMember(data: unknown): Promise<ActionResult<PendingInvitation>> {
  return guarded(async () => {
    const team = await requireTeam({ role: ["owner", "admin"] });
    const { email, role } = readInvite(data);
    if (role === "owner" && team.role !== "owner") throw new ForbiddenError("Only an owner can invite an owner");
    const invitation = await auth.api.createInvitation({
      body: { email, role, organizationId: team.teamId, resend: true },
      headers: await headers(),
    });
    return { id: invitation.id, email: invitation.email, role, expiresAt: new Date(invitation.expiresAt).getTime() };
  });
}

export async function cancelInvitation(invitationId: string): Promise<ActionResult<null>> {
  return guarded(async () => {
    await requireTeam({ role: ["owner", "admin"] });
    await auth.api.cancelInvitation({ body: { invitationId: String(invitationId) }, headers: await headers() });
    return null;
  });
}

export async function acceptInvitation(invitationId: string): Promise<ActionResult<{ teamId: string }>> {
  return guarded(async () => {
    await requireSession();
    const accepted = await auth.api.acceptInvitation({ body: { invitationId: String(invitationId) }, headers: await headers() });
    if (!accepted) throw new Error("The invitation could not be accepted");
    await auth.api.setActiveOrganization({
      body: { organizationId: accepted.invitation.organizationId },
      headers: await headers(),
    });
    return { teamId: accepted.invitation.organizationId };
  });
}

export async function removeMember(memberId: string): Promise<ActionResult<null>> {
  return guarded(async () => {
    const team = await requireTeam({ role: ["owner", "admin"] });
    const target = await db.query.member.findFirst({
      where: and(eq(schema.member.id, String(memberId)), eq(schema.member.organizationId, team.teamId)),
    });
    if (!target) throw new Error("No such member");
    if (target.userId === team.userId) throw new ForbiddenError("Leave the team from another owner's account");
    if (roleOf(target.role) === "owner" && team.role !== "owner") throw new ForbiddenError("Only an owner can remove an owner");
    await auth.api.removeMember({
      body: { memberIdOrEmail: target.id, organizationId: team.teamId },
      headers: await headers(),
    });
    return null;
  });
}

export async function setMemberRole(data: unknown): Promise<ActionResult<null>> {
  return guarded(async () => {
    const team = await requireTeam({ role: ["owner", "admin"] });
    const { memberId, role } = readRoleChange(data);
    if (role === "owner" && team.role !== "owner") throw new ForbiddenError("Only an owner can make an owner");
    await auth.api.updateMemberRole({
      body: { memberId, role, organizationId: team.teamId },
      headers: await headers(),
    });
    return null;
  });
}

export async function signOut(): Promise<ActionResult<null>> {
  return guarded(async () => {
    await auth.api.signOut({ headers: await headers() });
    return null;
  });
}

const ROLES: readonly Role[] = ["owner", "admin", "member"];

function roleOf(raw: string): Role {
  const roles = raw.split(",").map((part) => part.trim());
  if (roles.includes("owner")) return "owner";
  if (roles.includes("admin")) return "admin";
  return "member";
}

function readName(data: unknown): string {
  const name = typeof data === "object" && data !== null ? (data as { name?: unknown }).name : data;
  if (typeof name !== "string" || name.trim().length < 2) throw new Error("Give the team a name");
  return name.trim().slice(0, 80);
}

function readInvite(data: unknown): { email: string; role: Role } {
  const record = typeof data === "object" && data !== null ? (data as { email?: unknown; role?: unknown }) : {};
  const email = typeof record.email === "string" ? record.email.trim().toLowerCase() : "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Enter an email address");
  const role = ROLES.includes(record.role as Role) ? (record.role as Role) : "member";
  return { email, role };
}

function readRoleChange(data: unknown): { memberId: string; role: Role } {
  const record = typeof data === "object" && data !== null ? (data as { memberId?: unknown; role?: unknown }) : {};
  if (typeof record.memberId !== "string" || !record.memberId) throw new Error("No such member");
  if (!ROLES.includes(record.role as Role)) throw new Error("Unknown role");
  return { memberId: record.memberId, role: record.role as Role };
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "team";
}

function suffix(): string {
  return Math.random().toString(36).slice(2, 6);
}
