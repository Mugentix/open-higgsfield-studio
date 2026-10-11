import type { Metadata } from "next";
import Link from "next/link";
import { eq } from "drizzle-orm";

import { Gate } from "@/app/gate";
import { LoginForm } from "@/app/login/login-form";
import { googleEnabled } from "@/server/auth";
import { db, dbReady, schema } from "@/server/db/client";
import { emailConfigured } from "@/server/email";
import { readSession } from "@/server/team";

import { AcceptButton } from "./accept-button";

/* Behind the session: answered per request, never prerendered at build,
   where a second process would open the same embedded database. */
export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Invitation", robots: { index: false } };

/* The link in the invitation email. Whoever opens it signs in with the invited
   address and joins; a session under a different address is told so rather
   than silently joined. */
export default async function InvitePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await dbReady();
  const invitation = await db.query.invitation.findFirst({
    where: eq(schema.invitation.id, id),
    with: { organization: true, user: true },
  });

  if (!invitation || invitation.status !== "pending" || invitation.expiresAt.getTime() < Date.now()) {
    return (
      <Gate
        title="This invitation is no longer open"
        copy="It was used, withdrawn, or expired. Ask a team admin to send a new one."
      >
        <div className="ohf-keys-form">
          <div className="ohf-keys-actions">
            <Link className="ohf-btn-quiet" href="/login">
              Sign in
            </Link>
          </div>
        </div>
      </Gate>
    );
  }

  const teamName = invitation.organization.name;
  const invitedBy = invitation.user.name || invitation.user.email;
  const session = await readSession();

  if (!session) {
    return (
      <Gate title={`Join ${teamName}`} copy={`${invitedBy} invited ${invitation.email}. Sign in with that address to join.`}>
        <LoginForm
          callbackURL={`/invite/${id}`}
          presetEmail={invitation.email}
          google={googleEnabled()}
          devMail={process.env.NODE_ENV !== "production" && !emailConfigured()}
        />
      </Gate>
    );
  }

  if (session.user.email.toLowerCase() !== invitation.email.toLowerCase()) {
    return (
      <Gate
        title={`Join ${teamName}`}
        copy={`This invitation is for ${invitation.email}; you are signed in as ${session.user.email}. Sign out and open the link again with the invited address.`}
      >
        <div className="ohf-keys-form">
          <div className="ohf-keys-actions">
            <Link className="ohf-btn-quiet" href="/">
              Back to the studio
            </Link>
          </div>
        </div>
      </Gate>
    );
  }

  return (
    <Gate title={`Join ${teamName}`} copy={`${invitedBy} invited you as ${invitation.role ?? "member"}.`}>
      <AcceptButton invitationId={id} teamName={teamName} />
    </Gate>
  );
}
