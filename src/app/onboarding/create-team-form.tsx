"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { createTeam } from "@/server/team-actions";

export function CreateTeamForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = await createTeam({ name });
    if (!result.ok) {
      setBusy(false);
      setError(result.error);
      return;
    }
    router.replace("/");
  }

  return (
    <form className="ohf-keys-form" onSubmit={(event) => void onSubmit(event)}>
      <label className="ohf-field">
        <div className="ohf-field-label">Team name</div>
        <input
          className="ohf-input"
          name="name"
          autoFocus
          required
          minLength={2}
          maxLength={80}
          placeholder="Acme Creative"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      {error && (
        <div className="ohf-alert" role="alert">
          <span className="ohf-alert-text">{error}</span>
        </div>
      )}
      <div className="ohf-keys-actions">
        <button type="submit" className="ohf-keys-save" disabled={busy || name.trim().length < 2}>
          {busy ? "Creating…" : "Create team"}
        </button>
      </div>
    </form>
  );
}
