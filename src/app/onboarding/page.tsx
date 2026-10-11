import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { Gate } from "@/app/gate";
import { NoTeamError, requireTeam, readSession } from "@/server/team";

import { CreateTeamForm } from "./create-team-form";

/* Behind the session: answered per request, never prerendered at build,
   where a second process would open the same embedded database. */
export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Your team", robots: { index: false } };

/* The first member's first screen. Everyone after them arrives through an
   invitation and never sees it. */
export default async function OnboardingPage() {
  const session = await readSession();
  if (!session) redirect("/login?next=/onboarding");
  try {
    await requireTeam();
    redirect("/");
  } catch (caught) {
    if (!(caught instanceof NoTeamError)) throw caught;
  }
  return (
    <Gate
      title="Name your team"
      copy="Products, projects and every generation live under the team. Invite the others from the studio once it exists."
    >
      <CreateTeamForm />
    </Gate>
  );
}
