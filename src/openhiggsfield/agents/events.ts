/* What the run view makes of the worker's event log: the log is flat and
   numbered, the stream is a tree. Tool results ride on the tool call they
   answer, a subagent's events fold under the Task that spawned it, a text
   block that streamed in pieces is shown once, and the open questions and
   approvals are known by the fact that nothing has landed on them yet. Pure,
   so tests/agents-ui.test.ts pins every rule; the words the pills and the
   live region use live here for the same reason. */

import type { AgentEventPayload, AgentEventRecord, AgentRunRecord, AgentRunStatus } from "@/server/agents-contract";
import { RUN_OPEN } from "@/server/agents-contract";

/** An event whose payload is one kind. */
export type EventOf<K extends AgentEventPayload["kind"]> = AgentEventRecord & { payload: Extract<AgentEventPayload, { kind: K }> };

export function isKind<K extends AgentEventPayload["kind"]>(event: AgentEventRecord, kind: K): event is EventOf<K> {
  return event.payload.kind === kind;
}

/* ---------- status words ---------- */

export const STATUS_WORDS: Record<AgentRunStatus, string> = {
  queued: "Queued",
  running: "Running",
  waiting: "Waiting for you",
  stopping: "Stopping",
  stopped: "Stopped",
  done: "Done",
  failed: "Failed",
};

/** A run a person can still speak into. */
export function isOpen(status: AgentRunStatus): boolean {
  return RUN_OPEN.includes(status);
}

/** The two states the accent marks: the agent at work, or waiting on us.
    Queued and stopping are facts, not liveness; the terminal ones are past. */
export function isLive(status: AgentRunStatus): boolean {
  return status === "running" || status === "waiting";
}

/** How often the view asks for news. Brisk while the agent works, slower
    while it waits on a person, never once the run has ended. */
export function pollInterval(status: AgentRunStatus): number | null {
  if (!isOpen(status)) return null;
  return status === "waiting" ? 4000 : 1500;
}

/* ---------- the event log ---------- */

/** Known events plus a page from the server, by seq: a seq already held is
    replaced, since a question or approval event is rewritten in place when
    it is settled, and the order is the log's. */
export function mergeEvents(known: readonly AgentEventRecord[], incoming: readonly AgentEventRecord[]): AgentEventRecord[] {
  if (incoming.length === 0) return [...known];
  const bySeq = new Map<number, AgentEventRecord>();
  for (const event of known) bySeq.set(event.seq, event);
  for (const event of incoming) bySeq.set(event.seq, event);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

/** One page of sync folded into what the tab holds, with the watermark the
    next ask starts from. The watermark moves only over the events page: the
    gates come back as they stand whatever their seq, and one from past the
    page, merged as if fetched, would carry the watermark over events never
    seen. Such a gate waits for the page that holds it. */
export function receivePage(
  known: readonly AgentEventRecord[],
  page: { events: readonly AgentEventRecord[]; gates: readonly AgentEventRecord[] },
  lastSeq: number,
): { events: AgentEventRecord[]; lastSeq: number } {
  const next = page.events.reduce((max, event) => Math.max(max, event.seq), lastSeq);
  const gates = page.gates.filter((gate) => gate.seq <= next);
  return { events: mergeEvents(known, [...page.events, ...gates]), lastSeq: next };
}

/* ---------- the stream ---------- */

export type ToolNode = {
  kind: "tool";
  event: EventOf<"tool_use">;
  result: EventOf<"tool_result"> | null;
};

export type GroupNode = {
  kind: "group";
  toolUseId: string;
  name: string;
  description: string;
  state: "started" | "stopped";
  seq: number;
  at: number;
  /** The Task call the agent made, when the worker recorded one. */
  task: EventOf<"tool_use"> | null;
  result: EventOf<"tool_result"> | null;
  children: StreamNode[];
};

export type PlainNode = { kind: "event"; event: AgentEventRecord };

export type StreamNode = ToolNode | GroupNode | PlainNode;

/** The events of a scope — the run itself, or one subagent — ordered. */
type Scope = {
  events: AgentEventRecord[];
  children: Map<string, AgentEventRecord[]>;
  results: Map<string, EventOf<"tool_result">>;
};

/** The stream as the view draws it. Rules: a tool_result folds onto its
    tool_use; a Task's subagent events fold under one group, together with
    the subagent started/stopped marks and the Task call itself; a `text`
    event that is not final is dropped when the next event of its scope
    (results, status lines and artifacts aside) is another text — the final
    block, or the next partial; an orphan result stands on its own. */
export function buildStream(events: readonly AgentEventRecord[]): StreamNode[] {
  const children = new Map<string, AgentEventRecord[]>();
  const results = new Map<string, EventOf<"tool_result">>();
  const root: AgentEventRecord[] = [];
  for (const event of events) {
    if (isKind(event, "tool_result")) results.set(event.payload.toolUseId, event);
    if (event.parentToolUseId) {
      const list = children.get(event.parentToolUseId) ?? [];
      list.push(event);
      children.set(event.parentToolUseId, list);
    } else root.push(event);
  }
  return buildScope({ events: root, children, results });
}

const QUIET: ReadonlySet<AgentEventPayload["kind"]> = new Set(["tool_result", "status", "artifact"]);

function buildScope(scope: Scope): StreamNode[] {
  const nodes: StreamNode[] = [];
  const grouped = new Set<string>();
  const stops = new Map<string, EventOf<"subagent">>();
  const starts = new Map<string, EventOf<"subagent">>();
  for (const event of scope.events) {
    if (!isKind(event, "subagent")) continue;
    (event.payload.state === "started" ? starts : stops).set(event.payload.toolUseId, event);
  }

  for (let index = 0; index < scope.events.length; index++) {
    const event = scope.events[index]!;

    if (isKind(event, "text") && !event.payload.final) {
      const next = nextLoud(scope.events, index);
      if (next && isKind(next, "text")) continue;
    }

    if (isKind(event, "tool_result")) {
      const paired = scope.events.some((other) => isKind(other, "tool_use") && other.payload.toolUseId === event.payload.toolUseId);
      if (paired || grouped.has(event.payload.toolUseId)) continue;
      nodes.push({ kind: "event", event });
      continue;
    }

    if (isKind(event, "subagent")) {
      const id = event.payload.toolUseId;
      if (event.payload.state === "stopped" && (starts.has(id) || grouped.has(id))) continue;
      if (grouped.has(id)) continue;
      grouped.add(id);
      const task = scope.events.find((other): other is EventOf<"tool_use"> => isKind(other, "tool_use") && other.payload.toolUseId === id) ?? null;
      nodes.push(group(scope, id, event, stops.get(id) ?? null, task));
      continue;
    }

    if (isKind(event, "tool_use")) {
      const id = event.payload.toolUseId;
      if (grouped.has(id)) continue;
      /* A Task the worker never marked as a subagent, with events under it
         all the same: the call itself heads the group. */
      if (starts.has(id)) continue;
      if (event.payload.name === "Task" && scope.children.has(id)) {
        grouped.add(id);
        nodes.push(group(scope, id, null, stops.get(id) ?? null, event));
        continue;
      }
      nodes.push({ kind: "tool", event, result: scope.results.get(id) ?? null });
      continue;
    }

    nodes.push({ kind: "event", event });
  }
  return nodes;
}

/** The next event of the scope that is not a result, a status line or an
    artifact — the ones that may land between two pieces of one text block. */
function nextLoud(events: readonly AgentEventRecord[], from: number): AgentEventRecord | null {
  for (let k = from + 1; k < events.length; k++) {
    if (!QUIET.has(events[k]!.payload.kind)) return events[k]!;
  }
  return null;
}

function group(
  scope: Scope,
  toolUseId: string,
  start: EventOf<"subagent"> | null,
  stop: EventOf<"subagent"> | null,
  task: EventOf<"tool_use"> | null,
): GroupNode {
  const head = start ?? task!;
  const input = task?.payload.input ?? {};
  const name = start?.payload.name || stringOf(input.subagent_type) || task?.payload.summary || "Subagent";
  const description = start?.payload.description || stringOf(input.description) || "";
  const children = buildScope({ events: scope.children.get(toolUseId) ?? [], children: scope.children, results: scope.results });
  const result = scope.results.get(toolUseId) ?? null;
  return {
    kind: "group",
    toolUseId,
    name,
    description,
    state: stop || result ? "stopped" : "started",
    seq: head.seq,
    at: head.at,
    task,
    result,
    children,
  };
}

function stringOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/* ---------- words and figures ---------- */

/** Which mark a tool row wears, by the tool's name. */
export type ToolGlyph = "bash" | "file" | "task" | "web" | "studio" | "tool";

export function toolGlyph(name: string): ToolGlyph {
  if (name === "Bash") return "bash";
  if (/^(Read|Write|Edit|MultiEdit|NotebookEdit|Glob|Grep|LS)$/.test(name)) return "file";
  if (name === "Task") return "task";
  if (/^Web(Fetch|Search)$/.test(name)) return "web";
  if (name.startsWith("mcp__studio__")) return "studio";
  return "tool";
}

/** The dollars a run has cost so far. Under a dollar the figure keeps up to
    four places, trailing zeros dropped — the owner reads a $0.0123 turn as a
    number, not as a rounded cent. */
export function formatUsd(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return "$0";
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  const fixed = usd.toFixed(4);
  const kept = fixed.replace(/0+$/, "");
  return `$${kept.length < fixed.length - 2 ? fixed.slice(0, 4) : kept}`;
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function firstLine(text: string): string {
  const line = text.split("\n").find((entry) => entry.trim() !== "") ?? "";
  return line.trim();
}

/** The line the live region reads when a sync brings news: a question or an
    approval first, since those are what the person is needed for; then an
    error; otherwise the status the run moved to. Null when nothing a reader
    should hear changed. `fresh` is the events this sync added. */
export function announcementFor(
  previous: AgentRunRecord | null,
  next: AgentRunRecord,
  fresh: readonly AgentEventRecord[],
): string | null {
  for (const event of fresh) {
    if (isKind(event, "question") && event.payload.answers === null) {
      const first = event.payload.questions[0];
      const words = first ? first.header || first.question : "a question";
      return `${next.title} asks: ${words}`;
    }
  }
  for (const event of fresh) {
    if (isKind(event, "approval") && event.payload.decision === null) {
      return `${next.title} needs an approval: ${firstLine(event.payload.command)}`;
    }
  }
  for (const event of fresh) {
    if (isKind(event, "error")) return `${next.title} — error: ${firstLine(event.payload.message)}`;
  }
  if (previous && previous.status !== next.status) {
    const word = STATUS_WORDS[next.status];
    return next.status === "failed" && next.error ? `${next.title} — ${word}: ${next.error}` : `${next.title} — ${word}`;
  }
  return null;
}
