import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { redirect } from "next/navigation";

import { CROSS_VIEWS, type GalleryView } from "@/openhiggsfield/data";
import { OpenHiggsfieldApp } from "@/openhiggsfield/openhiggsfield-app";
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

/* Title, description and the Open Graph block all come from the root, which
   already describes this surface. Only the canonical link is route-specific. */
export const metadata: Metadata = {
  alternates: { canonical: "/" },
};

export default async function OpenHiggsfieldPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  let team;
  try {
    team = await requireTeam();
  } catch (caught) {
    if (caught instanceof UnauthenticatedError) redirect("/login");
    if (caught instanceof NoTeamError) redirect("/onboarding");
    throw caught;
  }
  /* The agents pages share the sidebar; a Library press there comes back
     here naming the scope. Anything else opens on the studio's own. */
  const { view } = await searchParams;
  const initialView = typeof view === "string" && CROSS_VIEWS.has(view as GalleryView) ? (view as GalleryView) : undefined;
  return (
    <Providers>
      <OpenHiggsfieldApp
        fontClassName={inter.variable}
        viewer={{ id: team.userId, name: team.userName, email: team.userEmail, teamName: team.teamName, role: team.role }}
        initialView={initialView}
      />
    </Providers>
  );
}
