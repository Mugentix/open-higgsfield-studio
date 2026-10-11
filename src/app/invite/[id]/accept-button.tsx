"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { acceptInvitation } from "@/server/team-actions";

export function AcceptButton({ invitationId, teamName }: { invitationId: string; teamName: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onAccept() {
    setBusy(true);
    setError(null);
    const result = await acceptInvitation(invitationId);
    if (!result.ok) {
      setBusy(false);
      setError(result.error);
      return;
    }
    router.replace("/");
  }

  return (
    <div className="ohf-keys-form">
      {error && (
        <div className="ohf-alert" role="alert">
          <span className="ohf-alert-text">{error}</span>
        </div>
      )}
      <div className="ohf-keys-actions">
        <button type="button" className="ohf-keys-save" disabled={busy} onClick={() => void onAccept()}>
          {busy ? "Joining…" : `Join ${teamName}`}
        </button>
      </div>
    </div>
  );
}
