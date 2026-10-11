"use client";

import { useState } from "react";

import type { AgentEventRecord, AgentRunStatus } from "@/server/agents-contract";

import { AgentIcon, BranchIcon, ChevronRightIcon, DocumentIcon, GlobeIcon, TerminalIcon, ToolIcon, WarningIcon } from "../icons";
import { ApprovalCard, QuestionCard, type Answers } from "./cards";
import { baseName, clockLabel } from "./client";
import {
  STATUS_WORDS,
  formatBytes,
  formatDuration,
  formatUsd,
  isKind,
  toolGlyph,
  type EventOf,
  type GroupNode,
  type StreamNode,
  type ToolGlyph,
  type ToolNode,
} from "./events";
import { Markdown } from "./markdown-view";

/* The activity stream: the worker's log as a column of what happened. Prose
   stands open; what the agent did — tools, thinking, a subagent's whole
   detour — folds to one line each and opens on request; the places it
   stopped for a person are cards that keep their decision. Nothing here is
   a dialog, so the run can be read around every card. */

export type StreamHandlers = {
  onAnswer: (event: EventOf<"question">, answers: Answers) => Promise<string | null>;
  onDecide: (event: EventOf<"approval">, decision: "approved" | "denied") => Promise<string | null>;
};

export function Stream({
  nodes,
  status,
  handlers,
  depth = 0,
}: {
  nodes: StreamNode[];
  status: AgentRunStatus;
  handlers: StreamHandlers;
  depth?: number;
}) {
  /* A card can be answered while the run is open; a run that ended, or is
     winding down, no longer listens. */
  const closed = status === "done" || status === "failed" || status === "stopped" || status === "stopping";
  return (
    <ol className="ohf-stream-list" data-depth={depth}>
      {nodes.map((node) => (
        <li key={keyOf(node)} className="ohf-stream-item">
          {node.kind === "tool" ? (
            <ToolRow node={node} running={status === "running"} />
          ) : node.kind === "group" ? (
            <GroupRow node={node} status={status} handlers={handlers} depth={depth} />
          ) : (
            <EventRow event={node.event} closed={closed} handlers={handlers} />
          )}
        </li>
      ))}
    </ol>
  );
}

function keyOf(node: StreamNode): string {
  return node.kind === "group" ? `g-${node.toolUseId}` : `e-${node.event.seq}`;
}

function EventRow({ event, closed, handlers }: { event: AgentEventRecord; closed: boolean; handlers: StreamHandlers }) {
  if (isKind(event, "text")) {
    return (
      <div className="ohf-ev ohf-ev-text" data-final={event.payload.final}>
        <Markdown source={event.payload.text} />
      </div>
    );
  }
  if (isKind(event, "thinking")) return <ThinkingRow event={event} />;
  if (isKind(event, "user")) {
    const { text, userName, attachments } = event.payload;
    return (
      <div className="ohf-ev ohf-ev-user">
        <div className="ohf-ev-user-head">
          <span className="ohf-ev-user-name">{userName ?? "You"}</span>
          <time className="ohf-ev-time" dateTime={new Date(event.at).toISOString()}>
            {clockLabel(event.at)}
          </time>
        </div>
        <Markdown source={text} />
        {attachments.length > 0 && (
          <ul className="ohf-ev-attachments" aria-label="Attached files">
            {attachments.map((file) => (
              <li key={`${file.url}-${file.name}`}>
                <a className="ohf-ev-attachment" href={file.url} target="_blank" rel="noopener noreferrer">
                  <DocumentIcon size={12} />
                  {file.name}
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }
  if (isKind(event, "question")) {
    return <QuestionCard event={event} disabled={closed} onAnswer={(answers) => handlers.onAnswer(event, answers)} />;
  }
  if (isKind(event, "approval")) {
    return <ApprovalCard event={event} disabled={closed} onDecide={(decision) => handlers.onDecide(event, decision)} />;
  }
  if (isKind(event, "status")) {
    const { status, reason } = event.payload;
    return (
      <div className="ohf-ev ohf-ev-line ohf-ev-status" data-status={status}>
        <span>
          {STATUS_WORDS[status]}
          {reason ? ` — ${reason}` : ""}
        </span>
        <Clock at={event.at} />
      </div>
    );
  }
  if (isKind(event, "result")) {
    const { subtype, costUsd, turns, durationMs } = event.payload;
    const label = subtype === "success" || subtype === "" ? "Turn ended" : `Turn ended (${subtype.replace(/_/g, " ")})`;
    return (
      <div className="ohf-ev ohf-ev-line ohf-ev-result">
        <span>
          {label} · {formatUsd(costUsd)} · {turns} {turns === 1 ? "turn" : "turns"} · {formatDuration(durationMs)}
        </span>
        <Clock at={event.at} />
      </div>
    );
  }
  if (isKind(event, "artifact")) {
    const { path, url, sizeBytes } = event.payload;
    return (
      <div className="ohf-ev ohf-ev-line ohf-ev-artifact">
        <DocumentIcon size={12} />
        <a href={url} target="_blank" rel="noopener noreferrer" title={path}>
          {baseName(path)}
        </a>
        <span className="ohf-ev-dim">{formatBytes(sizeBytes)}</span>
      </div>
    );
  }
  if (isKind(event, "error")) {
    return (
      <div className="ohf-ev ohf-ev-error">
        <span className="ohf-alert-ic">
          <WarningIcon size={13} />
        </span>
        <span className="ohf-ev-error-text">{event.payload.message}</span>
      </div>
    );
  }
  if (isKind(event, "tool_result")) {
    /* A result whose call this scope never saw: shown as itself. */
    return (
      <div className="ohf-ev ohf-ev-tool" data-open="true">
        <div className="ohf-ev-tool-head">
          <span className="ohf-ev-tool-ic">
            <ToolIcon />
          </span>
          <span className="ohf-ev-tool-name">Result</span>
        </div>
        <Output event={event} />
      </div>
    );
  }
  if (isKind(event, "subagent")) {
    return (
      <div className="ohf-ev ohf-ev-line">
        <BranchIcon size={12} />
        <span>
          {event.payload.name} {event.payload.state}
        </span>
      </div>
    );
  }
  return null;
}

function Clock({ at }: { at: number }) {
  return (
    <time className="ohf-ev-time" dateTime={new Date(at).toISOString()}>
      {clockLabel(at)}
    </time>
  );
}

/* The agent's reasoning, folded: one line says it happened, a press opens it. */
function ThinkingRow({ event }: { event: EventOf<"thinking"> }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="ohf-ev ohf-ev-think" data-open={open}>
      <button type="button" className="ohf-ev-fold" aria-expanded={open} onClick={() => setOpen((current) => !current)}>
        <span className="ohf-ev-chevron" aria-hidden>
          <ChevronRightIcon size={11} />
        </span>
        <span className="ohf-ev-fold-label">Thinking</span>
      </button>
      {open && <Markdown source={event.payload.text} className="ohf-ev-think-body" />}
    </div>
  );
}

const GLYPHS: Record<ToolGlyph, () => React.ReactNode> = {
  bash: () => <TerminalIcon />,
  file: () => <DocumentIcon />,
  task: () => <BranchIcon />,
  web: () => <GlobeIcon />,
  studio: () => <AgentIcon size={13} />,
  tool: () => <ToolIcon />,
};

/* One tool call: its mark, its name and one line of what it did, folded; open,
   the input it was given and the result it got back, side by side in time. */
function ToolRow({ node, running }: { node: ToolNode; running: boolean }) {
  const [open, setOpen] = useState(false);
  const { name, summary, input } = node.event.payload;
  const glyph = toolGlyph(name);
  const pending = node.result === null && running;
  const failed = node.result?.payload.isError === true;
  const inputText = typeof input.command === "string" && glyph === "bash" ? input.command : JSON.stringify(input, null, 2);
  return (
    <div className="ohf-ev ohf-ev-tool" data-open={open} data-failed={failed} data-glyph={glyph}>
      <button
        type="button"
        className="ohf-ev-fold ohf-ev-tool-head"
        aria-expanded={open}
        aria-label={`${name}: ${summary}${failed ? ", failed" : pending ? ", running" : ""}`}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="ohf-ev-chevron" aria-hidden>
          <ChevronRightIcon size={11} />
        </span>
        <span className="ohf-ev-tool-ic" aria-hidden>
          {GLYPHS[glyph]()}
        </span>
        <span className="ohf-ev-tool-name">{name}</span>
        <span className="ohf-ev-tool-summary" title={summary}>
          {summary}
        </span>
        {pending && <span className="ohf-spinner ohf-ev-tool-spin" aria-hidden />}
        {failed && <span className="ohf-ev-tool-failed">failed</span>}
      </button>
      {open && (
        <div className="ohf-ev-tool-body">
          <div className="ohf-ev-tool-part">
            <span className="ohf-ev-dim">Input</span>
            <pre className="ohf-code">{inputText}</pre>
          </div>
          {node.result ? (
            <Output event={node.result} />
          ) : (
            <p className="ohf-ev-dim">{pending ? "Running…" : "No result was recorded."}</p>
          )}
        </div>
      )}
    </div>
  );
}

function Output({ event }: { event: EventOf<"tool_result"> }) {
  const { output, isError, truncated } = event.payload;
  return (
    <div className="ohf-ev-tool-part" data-error={isError}>
      <span className="ohf-ev-dim">{isError ? "Error" : "Result"}</span>
      <pre className="ohf-code">{output || "(empty)"}</pre>
      {truncated && <span className="ohf-ev-dim">Cut here — the worker keeps the rest.</span>}
    </div>
  );
}

/* A subagent's detour: its name and brief on one line, its own stream
   nested beneath when opened. Open by default while it works, since that
   is where the news is; shut once it has reported back. */
function GroupRow({ node, status, handlers, depth }: { node: GroupNode; status: AgentRunStatus; handlers: StreamHandlers; depth: number }) {
  const [open, setOpen] = useState(node.state === "started");
  const working = node.state === "started" && status === "running";
  const count = node.children.length;
  return (
    <div className="ohf-ev ohf-ev-group" data-open={open} data-working={working}>
      <button
        type="button"
        className="ohf-ev-fold ohf-ev-tool-head"
        aria-expanded={open}
        aria-label={`Subagent ${node.name}${node.description ? `: ${node.description}` : ""}${working ? ", working" : ", finished"}`}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="ohf-ev-chevron" aria-hidden>
          <ChevronRightIcon size={11} />
        </span>
        <span className="ohf-ev-tool-ic" aria-hidden>
          <BranchIcon />
        </span>
        <span className="ohf-ev-tool-name">{node.name}</span>
        <span className="ohf-ev-tool-summary" title={node.description}>
          {node.description}
        </span>
        <span className="ohf-ev-dim">{count === 1 ? "1 step" : `${count} steps`}</span>
        {working && <span className="ohf-spinner ohf-ev-tool-spin" aria-hidden />}
      </button>
      {open && (
        <div className="ohf-ev-group-body">
          {count > 0 ? (
            <Stream nodes={node.children} status={status} handlers={handlers} depth={depth + 1} />
          ) : (
            <p className="ohf-ev-dim">{working ? "Starting…" : "Nothing was recorded."}</p>
          )}
          {node.result && <Output event={node.result} />}
        </div>
      )}
    </div>
  );
}
