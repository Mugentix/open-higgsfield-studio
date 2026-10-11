import { Resend } from "resend";

/* Magic links and invitations go out through Resend when RESEND_API_KEY is
   set. Without it (a local checkout) the message is printed to the server log
   and kept for the dev mailbox route, so the flow can be walked without an
   inbox. Nothing is ever kept in production. */

export type Mail = { to: string; subject: string; text: string; link?: string };

const DEV_MAILBOX_MAX = 20;

declare global {
  // eslint-disable-next-line no-var
  var __ohfDevMailbox: Mail[] | undefined;
}

export function devMailbox(): Mail[] {
  return (globalThis.__ohfDevMailbox ??= []);
}

export function emailConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY?.trim());
}

export async function sendMail(mail: Mail): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  if (apiKey) {
    const resend = new Resend(apiKey);
    const from = process.env.EMAIL_FROM?.trim() || "Studio <onboarding@resend.dev>";
    const { error } = await resend.emails.send({ from, to: mail.to, subject: mail.subject, text: mail.text });
    if (error) throw new Error(`Email failed: ${error.message}`);
    return;
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error("RESEND_API_KEY is not set; the studio cannot send sign-in links");
  }
  console.info(`[mail] to ${mail.to}: ${mail.subject}\n${mail.link ?? mail.text}`);
  const box = devMailbox();
  box.unshift(mail);
  if (box.length > DEV_MAILBOX_MAX) box.length = DEV_MAILBOX_MAX;
}
