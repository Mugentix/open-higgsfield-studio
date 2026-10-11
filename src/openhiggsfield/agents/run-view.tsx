"use client";

import Link from "next/link";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { answerAgentQuestion, decideAgentApproval, listAgentArtifacts, stopAgentRun } from "@/server/agent-actions";
import type { AgentArtifactRecord } from "@/server/agents-contract";
import type { Workspace } from "@/server/project-actions";

import { StopIcon } from "../icons";
import { ArtifactsPanel } from "./artifacts-panel";
import type { Answers } from "./cards";
import { bounceIfSignedOut, projectLabel } from "./client";
import { buildStream, formatUsd, isKind, isLive, isOpen, type EventOf } from "./events";
import { ReplyBox } from "./reply-box";
import { StatusPill } from "./status-pill";
import { Stream, type StreamHandlers } from "./stream";
import { useAgentRun } from "./use-agent-run";

const CREDITS = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

/* One run: its facts in the head, the stream on the left, what it made on the
   right, and the reply box under the stream. The page lives off the poll in
   useAgentRun; every press here writes an input and asks for the news. */
export function RunView({
  runId,
  viewer,
  workspace,
  announce,
  onBusy,
}: {
  runId: string;
  viewer: { name: string; email: string };
  workspace: Workspace | null;
  announce: (line: string | null) => void;
  /** The sidebar's lamp: pulsing while this run is live. */
  onBusy: (busy: boolean) => void;
}) {
  const { run, events, error, refresh, patchEvent, patchRun } = useAgentRun(runId, announce);
  const [artifacts, setArtifacts] = useState<AgentArtifactRecord[]>([]);
  const [stopArmed, setStopArmed] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);
  const streamRef = useRef<HTMLDivElement>(null);
  /* Whether the reader is at the foot of the stream, where new lines land;
     scrolled up, the stream holds still under them. */
  const pinned = useRef(true);

  const nodes = useMemo(() => buildStream(events), [events]);
  const artifactEvents = useMemo(() => events.filter((event) => isKind(event, "artifact")).length, [events]);

  const loadArtifacts = useCallback(async () => {
    const result = await listAgentArtifacts(runId);
    if (result.ok) setArtifacts(result.data);
  }, [runId]);
  useEffect(() => {
    void loadArtifacts();
  }, [loadArtifacts, artifactEvents]);

  const live = run ? isLive(run.status) : false;
  useEffect(() => {
    onBusy(live);
    return () => onBusy(false);
  }, [live, onBusy]);

  /* The tab names the run and carries a dot while the agent works, so the
     run can be left in a background tab and watched from its title. */
  const titleBefore = useRef<string | null>(null);
  useEffect(() => {
    if (!run) return;
    titleBefore.current ??= document.title;
    document.title = `${run.status === "running" ? "● " : ""}${run.title} — Agents`;
  }, [run]);
  useEffect(
    () => () => {
      if (titleBefore.current !== null) document.title = titleBefore.current;
    },
    [],
  );

  useLayoutEffect(() => {
    const stream = streamRef.current;
    if (stream && pinned.current) stream.scrollTop = stream.scrollHeight;
  }, [nodes]);

  const onStreamScroll = () => {
    const stream = streamRef.current;
    if (!stream) return;
    pinned.current = stream.scrollHeight - stream.scrollTop - stream.clientHeight < 80;
  };

  /* Each card settles on screen before the server confirms it; a refusal
     puts the card back and hands the words to it. */
  const handlers = useMemo<StreamHandlers>(
    () => ({
      onAnswer: async (event: EventOf<"question">, answers: Answers) => {
        const before = event.payload;
        patchEvent(event.seq, (payload) => (payload.kind === "question" ? { ...payload, answers, answeredBy: viewer.name || viewer.email } : payload));
        const result = await answerAgentQuestion({ runId, questionId: event.payload.questionId, answers });
        if (!result.ok) {
          bounceIfSignedOut(result.code);
          patchEvent(event.seq, () => before);
          return result.error;
        }
        patchRun({ status: "running" });
        refresh();
        return null;
      },
      onDecide: async (event: EventOf<"approval">, decision: "approved" | "denied") => {
        const before = event.payload;
        patchEvent(event.seq, (payload) => (payload.kind === "approval" ? { ...payload, decision, decidedBy: viewer.name || viewer.email } : payload));
        const result = await decideAgentApproval({ runId, approvalId: event.payload.approvalId, decision });
        if (!result.ok) {
          bounceIfSignedOut(result.code);
          patchEvent(event.seq, () => before);
          return result.error;
        }
        patchRun({ status: "running" });
        refresh();
        return null;
      },
    }),
    [runId, viewer.name, viewer.email, patchEvent, patchRun, refresh],
  );

  /* Stop is two presses: the first arms the button and names what it will
     do, the second does it. A pipeline mid-spend should not end on a slip. */
  useEffect(() => {
    if (!stopArmed) return;
    const timer = setTimeout(() => setStopArmed(false), 5000);
    return () => clearTimeout(timer);
  }, [stopArmed]);

  async function stop() {
    if (!stopArmed) {
      setStopArmed(true);
      return;
    }
    setStopArmed(false);
    setStopError(null);
    const result = await stopAgentRun(runId);
    if (!result.ok) {
      bounceIfSignedOut(result.code);
      setStopError(result.error);
      return;
    }
    patchRun({ status: "stopping" });
    refresh();
  }

  if (!run) {
    return (
      <>
        <header className="ohf-agents-top">
          <Link href="/agents" className="ohf-agents-crumb">
            Agents
          </Link>
          <span className="ohf-agents-crumb-sep" aria-hidden>
            ›
          </span>
          <h1 className="ohf-agents-title">{error ? "Run not found" : "Loading…"}</h1>
        </header>
        <div className="ohf-agents-body">
          {error && (
            <div className="ohf-alert" role="alert">
              <span className="ohf-alert-text">{error}</span>
            </div>
          )}
        </div>
      </>
    );
  }

  const open = isOpen(run.status);

  return (
    <>
      <header className="ohf-agents-top ohf-run-head">
        <div className="ohf-run-head-main">
          <div className="ohf-run-crumbs">
            <Link href="/agents" className="ohf-agents-crumb">
              Agents
            </Link>
            <span className="ohf-agents-crumb-sep" aria-hidden>
              ›
            </span>
            <span className="ohf-run-head-sub">
              {run.skillName} · {projectLabel(workspace, run.projectId)}
            </span>
          </div>
          <h1 className="ohf-agents-title" title={run.title}>
            {run.title}
          </h1>
        </div>
        <div className="ohf-run-head-facts">
          <StatusPill status={run.status} />
          <span className="ohf-run-figure" title="What the model loop has cost so far">
            {formatUsd(run.costUsd)}
          </span>
          {run.credits > 0 && (
            <span className="ohf-run-figure" title="KIE credits the run reported spending">
              {CREDITS.format(run.credits)} credits
            </span>
          )}
          {open && run.status !== "stopping" && (
            <button
              type="button"
              className="ohf-btn-solid ohf-run-stop"
              data-armed={stopArmed}
              aria-label={stopArmed ? "Confirm: stop this run" : "Stop this run"}
              onClick={() => void stop()}
              onBlur={() => setStopArmed(false)}
            >
              <StopIcon size={11} />
              {stopArmed ? "Stop the run?" : "Stop"}
            </button>
          )}
        </div>
      </header>
      {(error || stopError) && (
        <div className="ohf-alert ohf-run-alert" role="alert">
          <span className="ohf-alert-text">{stopError ?? error}</span>
        </div>
      )}
      <div className="ohf-run-panes">
        <section className="ohf-run-pane ohf-run-pane--stream" aria-labelledby="ohf-run-activity">
          <h2 id="ohf-run-activity" className="ohf-sr">
            Activity
          </h2>
          <div ref={streamRef} className="ohf-stream ohf-scroll" onScroll={onStreamScroll}>
            {nodes.length === 0 ? (
              <p className="ohf-ev-dim ohf-stream-empty">{run.status === "queued" ? "Waiting for a worker to pick the run up…" : "Nothing recorded yet."}</p>
            ) : (
              <Stream nodes={nodes} status={run.status} handlers={handlers} />
            )}
          </div>
          <ReplyBox run={run} onSent={refresh} />
        </section>
        <aside className="ohf-run-pane ohf-run-pane--artifacts" aria-labelledby="ohf-run-artifacts">
          <h2 id="ohf-run-artifacts" className="ohf-agents-h2">
            Artifacts
            {artifacts.length > 0 && <span className="ohf-agents-count">{artifacts.length}</span>}
          </h2>
          <div className="ohf-run-artifacts-body ohf-scroll">
            <ArtifactsPanel artifacts={artifacts} onChanged={() => void loadArtifacts()} announce={announce} />
          </div>
        </aside>
      </div>
    </>
  );
}
