import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth";
import { nextCookies } from "better-auth/next-js";
import { magicLink, organization } from "better-auth/plugins";
import { eq } from "drizzle-orm";

import { db, schema } from "./db/client";
import { sendMail } from "./email";

/* Sign-in is a magic link (and Google when the deployment has credentials);
   there are no passwords to reset or leak. A team is a Better Auth
   organization: owners and admins hold the key and invite, members generate.
   New sessions land on the member's first team so the studio never asks. */

const appUrl = process.env.BETTER_AUTH_URL?.trim() || process.env.APP_URL?.trim() || "http://localhost:3000";

/* `next build` imports every route to collect page data under NODE_ENV=production;
   the placeholder only ever serves that phase, never a request. */
const BUILDING = process.env.NEXT_PHASE === "phase-production-build";

function secret(): string {
  const raw = process.env.BETTER_AUTH_SECRET?.trim();
  if (raw) return raw;
  if (process.env.NODE_ENV === "production" && !BUILDING) throw new Error("BETTER_AUTH_SECRET is not set");
  return "openhiggsfield-dev-only-session-secret-not-for-production";
}

const google =
  process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
    ? {
        google: {
          clientId: process.env.GOOGLE_CLIENT_ID,
          clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        },
      }
    : {};

export const auth = betterAuth({
  baseURL: appUrl,
  secret: secret(),
  database: drizzleAdapter(db, { provider: "pg", schema }),
  socialProviders: google,
  session: {
    cookieCache: { enabled: true, maxAge: 5 * 60 },
  },
  databaseHooks: {
    session: {
      create: {
        before: async (session) => {
          const first = await db.query.member.findFirst({
            where: eq(schema.member.userId, session.userId),
            orderBy: (m, { asc }) => [asc(m.createdAt)],
          });
          return { data: { ...session, activeOrganizationId: first?.organizationId ?? null } };
        },
      },
    },
  },
  plugins: [
    organization({
      async sendInvitationEmail(data) {
        const link = `${appUrl}/invite/${data.id}`;
        await sendMail({
          to: data.email,
          subject: `${data.inviter.user.name || data.inviter.user.email} invited you to ${data.organization.name}`,
          text: `Join the ${data.organization.name} studio: ${link}\n\nThe invitation expires in 48 hours.`,
          link,
        });
      },
    }),
    magicLink({
      async sendMagicLink({ email, url }) {
        await sendMail({
          to: email,
          subject: "Your studio sign-in link",
          text: `Sign in: ${url}\n\nThe link works once and expires in 5 minutes.`,
          link: url,
        });
      },
    }),
    nextCookies(),
  ],
});

export type Session = typeof auth.$Infer.Session;

export function googleEnabled(): boolean {
  return "google" in google;
}
