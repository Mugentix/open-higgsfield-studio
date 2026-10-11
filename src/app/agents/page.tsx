import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { notFound, redirect } from "next/navigation";

import { AGENTS_ENABLED } from "@/features";
import { AgentsApp } from "@/openhiggsfield/agents/agents-app";
import { Providers } from "@/openhiggsfield/providers";
import { NoTeamError, UnauthenticatedError, requireTeam } from "@/server/team";

import "@/openhiggsfield/openhiggsfield.css";

/* Behind the session: answered per request, never prerendered at build,
   where a second process would open the same embedded database. */
export const dynamic = "force-dynamic";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-ohf-inter",
  display: "swap",
});

/* Behind the gate like the studio itself, so no crawler is pointed at it. */
export const metadata: Metadata = { title: "Agents", robots: { index: false } };

export default async function AgentsPage() {
  if (!AGENTS_ENABLED) notFound();
  let team;
  try {
    team = await requireTeam();
  } catch (caught) {
    if (caught instanceof UnauthenticatedError) redirect("/login?next=/agents");
    if (caught instanceof NoTeamError) redirect("/onboarding");
    throw caught;
  }
  return (
    <Providers>
      <AgentsApp
        fontClassName={inter.variable}
        viewer={{ id: team.userId, name: team.userName, email: team.userEmail, teamName: team.teamName, role: team.role }}
      />
    </Providers>
  );
}
