"use client";

import { useRef, useState, type KeyboardEvent } from "react";

import { sendAgentMessage } from "@/server/agent-actions";
import { MESSAGE_MAX_CHARS, type AgentRunRecord } from "@/server/agents-contract";

import { ArrowUpIcon } from "../icons";
import { AttachmentField } from "./attachments";
import { bounceIfSignedOut } from "./client";
import { STATUS_WORDS, isOpen } from "./events";

/* The way to speak into a run: a Markdown field, files from the library,
   Cmd/Ctrl+Enter to send, as the composer sends. Open while the run is;
   once it has ended — or is winding down — the box says so and stands down,
   since words sent to a session that is closing would be lost. */
export function ReplyBox({ run, onSent }: { run: AgentRunRecord; onSent: () => void }) {
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fieldRef = useRef<HTMLTextAreaElement>(null);

  const listening = isOpen(run.status) && run.status !== "stopping";
  const ready = text.trim().length > 0 && text.length <= MESSAGE_MAX_CHARS && !busy;

  async function send() {
    if (!ready || !listening) return;
    setBusy(true);
    setError(null);
    const result = await sendAgentMessage({ runId: run.id, text: text.trim(), attachmentAssetIds: attachments });
    setBusy(false);
    if (!result.ok) {
      bounceIfSignedOut(result.code);
      setError(result.error);
      return;
    }
    setText("");
    setAttachments([]);
    onSent();
    fieldRef.current?.focus();
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void send();
    }
  };

  if (!listening) {
    const word = run.status === "stopping" ? "is stopping" : `has ${STATUS_WORDS[run.status].toLowerCase()}`;
    return (
      <p className="ohf-reply-closed" role="status">
        This run {word}. {run.status === "stopping" ? "Its last words are on their way." : "Start a new run to continue the work."}
      </p>
    );
  }

  return (
    <form
      className="ohf-reply"
      aria-label="Reply to the agent"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <textarea
        ref={fieldRef}
        className="ohf-input ohf-input--area ohf-reply-field"
        placeholder={run.status === "waiting" ? "Answer the agent — Markdown is fine" : "Tell the agent something — it reads this at its next turn"}
        aria-label="Message to the agent"
        value={text}
        maxLength={MESSAGE_MAX_CHARS}
        rows={3}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className="ohf-reply-row">
        <AttachmentField selected={attachments} onChange={setAttachments} disabled={busy} />
        <span className="ohf-reply-hint" aria-hidden>
          ⌘/Ctrl+Enter sends
        </span>
        <button type="submit" className="ohf-btn-accent ohf-reply-send" disabled={!ready} aria-label="Send">
          <ArrowUpIcon size={14} />
          {busy ? "Sending…" : "Send"}
        </button>
      </div>
      {error && (
        <div className="ohf-alert" role="alert">
          <span className="ohf-alert-text">{error}</span>
        </div>
      )}
    </form>
  );
}
