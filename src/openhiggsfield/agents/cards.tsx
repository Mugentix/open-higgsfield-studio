"use client";

import { useState, type FormEvent } from "react";

import type { Question } from "@/server/agents-contract";

import { CheckIcon } from "../icons";
import type { EventOf } from "./events";
import { Markdown } from "./markdown-view";

/* The two places a run stops and waits for a person: a question the agent
   asked through AskUserQuestion, and a paid command the worker held at the
   gate. Both are inline cards in the stream, never dialogs, so a run can be
   read around them; both keep showing the decision once it is made, and who
   made it. */

export type Answers = Record<string, string | string[]>;

const OTHER = "__other__";

export function QuestionCard({
  event,
  disabled,
  onAnswer,
}: {
  event: EventOf<"question">;
  /** The run is no longer listening — ended, or stopping. */
  disabled: boolean;
  onAnswer: (answers: Answers) => Promise<string | null>;
}) {
  const { questions, answers, answeredBy } = event.payload;
  const settled = answers !== null;
  /* Per question: the labels picked, and the free text when "Other" is. */
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const answerOf = (question: Question): string | string[] | null => {
    const labels = picked[question.question] ?? [];
    const free = (other[question.question] ?? "").trim();
    const withOther = labels.includes(OTHER);
    const chosen = labels.filter((label) => label !== OTHER);
    if (withOther) {
      if (!free) return null;
      return question.multiSelect ? [...chosen, free] : free;
    }
    if (chosen.length === 0) return null;
    return question.multiSelect ? chosen : chosen[0]!;
  };
  const complete = questions.every((question) => answerOf(question) !== null);

  const pick = (question: Question, label: string) => {
    setPicked((current) => {
      const held = current[question.question] ?? [];
      if (question.multiSelect) {
        return { ...current, [question.question]: held.includes(label) ? held.filter((entry) => entry !== label) : [...held, label] };
      }
      return { ...current, [question.question]: held.includes(label) ? [] : [label] };
    });
  };

  async function onSubmit(submit: FormEvent) {
    submit.preventDefault();
    if (!complete || busy) return;
    const body: Answers = {};
    for (const question of questions) body[question.question] = answerOf(question)!;
    setBusy(true);
    setError(null);
    const refused = await onAnswer(body);
    setBusy(false);
    if (refused) setError(refused);
  }

  return (
    <form className="ohf-ev-card ohf-ev-card--question" data-settled={settled} onSubmit={(submit) => void onSubmit(submit)}>
      <div className="ohf-ev-card-head">
        <span className="ohf-ev-card-kind">{settled ? "Answered" : "The agent asks"}</span>
        {settled && answeredBy && <span className="ohf-ev-card-by">by {answeredBy}</span>}
      </div>
      {questions.map((question) => {
        const held = picked[question.question] ?? [];
        const given = answers?.[question.question];
        return (
          <fieldset key={question.question} className="ohf-ev-question" disabled={settled || disabled || busy}>
            <legend className="ohf-ev-question-legend">
              {question.header && <span className="ohf-ev-question-header">{question.header}</span>}
              <Markdown source={question.question} className="ohf-md--inline" />
            </legend>
            {settled ? (
              <p className="ohf-ev-answer">{Array.isArray(given) ? given.join(", ") : (given ?? "—")}</p>
            ) : (
              <div className="ohf-ev-options" role={question.multiSelect ? "group" : "radiogroup"} aria-label={question.header || question.question}>
                {question.options.map((option) => {
                  const on = held.includes(option.label);
                  return (
                    <button
                      key={option.label}
                      type="button"
                      className="ohf-ev-option"
                      role={question.multiSelect ? "checkbox" : "radio"}
                      aria-checked={on}
                      data-on={on}
                      onClick={() => pick(question, option.label)}
                    >
                      <span className="ohf-ev-option-mark" aria-hidden>
                        {on && <CheckIcon size={11} />}
                      </span>
                      <span className="ohf-ev-option-text">
                        <span className="ohf-ev-option-label">{option.label}</span>
                        {option.description && <span className="ohf-ev-option-desc">{option.description}</span>}
                      </span>
                    </button>
                  );
                })}
                <button
                  type="button"
                  className="ohf-ev-option"
                  role={question.multiSelect ? "checkbox" : "radio"}
                  aria-checked={held.includes(OTHER)}
                  data-on={held.includes(OTHER)}
                  onClick={() => pick(question, OTHER)}
                >
                  <span className="ohf-ev-option-mark" aria-hidden>
                    {held.includes(OTHER) && <CheckIcon size={11} />}
                  </span>
                  <span className="ohf-ev-option-text">
                    <span className="ohf-ev-option-label">Other</span>
                  </span>
                </button>
                {held.includes(OTHER) && (
                  <input
                    className="ohf-input ohf-ev-other"
                    placeholder="Your answer"
                    aria-label={`Your answer to: ${question.question}`}
                    value={other[question.question] ?? ""}
                    autoFocus
                    onChange={(change) => setOther((current) => ({ ...current, [question.question]: change.target.value }))}
                  />
                )}
              </div>
            )}
          </fieldset>
        );
      })}
      {!settled && (
        <div className="ohf-ev-card-actions">
          {disabled ? (
            <span className="ohf-ev-card-note">The run is no longer listening.</span>
          ) : (
            <button type="submit" className="ohf-btn-accent" disabled={!complete || busy}>
              {busy ? "Sending…" : "Answer"}
            </button>
          )}
        </div>
      )}
      {error && (
        <div className="ohf-alert" role="alert">
          <span className="ohf-alert-text">{error}</span>
        </div>
      )}
    </form>
  );
}

export function ApprovalCard({
  event,
  disabled,
  onDecide,
}: {
  event: EventOf<"approval">;
  disabled: boolean;
  onDecide: (decision: "approved" | "denied") => Promise<string | null>;
}) {
  const { command, reason, toolName, decision, decidedBy } = event.payload;
  const [busy, setBusy] = useState<"approved" | "denied" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function decide(next: "approved" | "denied") {
    if (busy) return;
    setBusy(next);
    setError(null);
    const refused = await onDecide(next);
    setBusy(null);
    if (refused) setError(refused);
  }

  return (
    <div className="ohf-ev-card ohf-ev-card--approval" data-settled={decision !== null} data-decision={decision ?? undefined}>
      <div className="ohf-ev-card-head">
        <span className="ohf-ev-card-kind">
          {decision === null ? "Approval needed" : decision === "approved" ? "Approved" : "Declined"}
        </span>
        {decision !== null && decidedBy && <span className="ohf-ev-card-by">by {decidedBy}</span>}
      </div>
      <p className="ohf-ev-card-copy">
        {decision === null ? "The agent wants to run a command that spends money." : "A paid command, held at the gate."}
        {reason && <> {reason}</>}
      </p>
      <pre className="ohf-code" aria-label={`${toolName} command`}>
        {command}
      </pre>
      {decision === null && (
        <div className="ohf-ev-card-actions">
          {disabled ? (
            <span className="ohf-ev-card-note">The run is no longer listening.</span>
          ) : (
            <>
              <button type="button" className="ohf-btn-accent" disabled={busy !== null} onClick={() => void decide("approved")}>
                {busy === "approved" ? "Approving…" : "Approve"}
              </button>
              <button type="button" className="ohf-btn-solid" disabled={busy !== null} onClick={() => void decide("denied")}>
                {busy === "denied" ? "Declining…" : "Decline"}
              </button>
            </>
          )}
        </div>
      )}
      {error && (
        <div className="ohf-alert" role="alert">
          <span className="ohf-alert-text">{error}</span>
        </div>
      )}
    </div>
  );
}
