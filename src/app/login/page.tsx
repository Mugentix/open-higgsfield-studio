import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { Gate } from "@/app/gate";
import { googleEnabled } from "@/server/auth";
import { emailConfigured } from "@/server/email";
import { readSession } from "@/server/team";

import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in", robots: { index: false } };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const params = await searchParams;
  if (await readSession()) redirect(safeNext(params.next));
  return (
    <Gate
      title="Sign in to the studio"
      copy={
        params.error === "link"
          ? "That link has expired or was already used. Ask for a fresh one."
          : "Enter your work email and follow the link we send."
      }
    >
      <LoginForm
        callbackURL={safeNext(params.next)}
        google={googleEnabled()}
        devMail={process.env.NODE_ENV !== "production" && !emailConfigured()}
      />
    </Gate>
  );
}

function safeNext(next: string | undefined): string {
  return next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
}
