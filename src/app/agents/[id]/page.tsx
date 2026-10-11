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

/** Run ids are the studio's own; anything else is not a run of this team. */
const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const metadata: Metadata = { title: "Agents", robots: { index: false } };

export default async function AgentRunPage({ params }: { params: Promise<{ id: string }> }) {
  if (!AGENTS_ENABLED) notFound();
  const { id } = await params;
  if (!RUN_ID.test(id)) notFound();
  let team;
  try {
    team = await requireTeam();
  } catch (caught) {
    if (caught instanceof UnauthenticatedError) redirect(`/login?next=/agents/${id}`);
    if (caught instanceof NoTeamError) redirect("/onboarding");
    throw caught;
  }
  /* The run itself is read on the client, scoped by the team the actions
     resolve; a run of another team answers as not found there. */
  return (
    <Providers>
      <AgentsApp
        fontClassName={inter.variable}
        viewer={{ id: team.userId, name: team.userName, email: team.userEmail, teamName: team.teamName, role: team.role }}
        runId={id}
      />
    </Providers>
  );
}
