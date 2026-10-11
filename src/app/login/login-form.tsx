"use client";

import { useState, type FormEvent } from "react";

import { authClient } from "@/server/auth-client";

/* One field. The link that comes back signs the visitor in; there is no
   password to invent. A local checkout without email prints the link to the
   server log and the dev mailbox instead. */
export function LoginForm({
  callbackURL,
  presetEmail = "",
  google = false,
  devMail = false,
}: {
  callbackURL: string;
  presetEmail?: string;
  google?: boolean;
  devMail?: boolean;
}) {
  const [email, setEmail] = useState(presetEmail);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const { error: failure } = await authClient.signIn.magicLink({
      email: email.trim(),
      callbackURL,
      errorCallbackURL: "/login?error=link",
    });
    setBusy(false);
    if (failure) {
      setError(failure.message ?? "The link could not be sent");
      return;
    }
    setSent(email.trim());
  }

  async function onGoogle() {
    setBusy(true);
    await authClient.signIn.social({ provider: "google", callbackURL });
  }

  if (sent) {
    return (
      <div className="ohf-keys-form">
        <p className="ohf-keys-copy">
          A sign-in link is on its way to <strong>{sent}</strong>. It works once and expires in five minutes.
        </p>
        {devMail && (
          <p className="ohf-keys-copy">
            This checkout sends no email: the link is in the server log and at{" "}
            <a className="ohf-link" href="/api/dev/mail" target="_blank" rel="noreferrer">
              /api/dev/mail
            </a>
            .
          </p>
        )}
        <div className="ohf-keys-actions">
          <button type="button" className="ohf-btn-quiet" onClick={() => setSent(null)}>
            Use another address
          </button>
        </div>
      </div>
    );
  }

  return (
    <form className="ohf-keys-form" onSubmit={(event) => void onSubmit(event)}>
      <label className="ohf-field">
        <div className="ohf-field-label">Work email</div>
        <input
          className="ohf-input"
          name="email"
          type="email"
          autoComplete="email"
          autoFocus
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
      </label>
      {error && (
        <div className="ohf-alert" role="alert">
          <span className="ohf-alert-text">{error}</span>
        </div>
      )}
      <div className="ohf-keys-actions">
        {google && (
          <button type="button" className="ohf-btn-quiet" disabled={busy} onClick={() => void onGoogle()}>
            Continue with Google
          </button>
        )}
        <button type="submit" className="ohf-keys-save" disabled={busy || !email.trim()}>
          {busy ? "Sending…" : "Email me a link"}
        </button>
      </div>
    </form>
  );
}
