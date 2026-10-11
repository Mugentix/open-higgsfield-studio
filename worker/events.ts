import type { SDKMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";

import { EVENT_TEXT_MAX_CHARS, TOOL_OUTPUT_MAX_CHARS, type AgentEventPayload, type AgentRunStatus, type Question } from "@/server/agents-contract";

import { commandHeadline } from "./gates";
import type { Masker } from "./mask";

/* Turns the Agent SDK's message stream into the studio's event vocabulary.
   Pure: no IO, no clock of its own (the throttle takes `now`), so the whole
   mapping is pinned by tests with synthetic messages. One mapper per run
   session; it remembers the text blocks still streaming, the subagents still
   open and the cost total it has already charged. */

export type MappedEvent = { payload: AgentEventPayload; parentToolUseId: string | null };

/** How often a streaming text block is written as a `final: false` event. */
export const PARTIAL_INTERVAL_MS = 400;
/** Strings inside a tool's input longer than this are cut in the event. */
const INPUT_STRING_MAX = 4_000;

type AssistantMessage = Extract<SDKMessage, { type: "assistant" }>;
type ContentBlock = AssistantMessage["message"]["content"][number];
type UserMessage = Extract<SDKMessage, { type: "user" }>;
type StreamEvent = Extract<SDKMessage, { type: "stream_event" }>["event"];

export class EventMapper {
  /** Text blocks mid-stream, keyed by parent id + block index. */
  private readonly streaming = new Map<string, { text: string; lastEmit: number }>();
  /** Subagents whose stop has not been seen; true when run in the background. */
  private readonly subagents = new Map<string, boolean>();
  private readonly seen = new Set<string>();
  /** Cumulative cost the session has already charged, so a resumed session's
      running total is charged only for what it adds. */
  private chargedUsd: number;
  sessionId: string | null = null;
  /** The last top-level assistant text of the turn; the gate heuristic reads it. */
  lastText = "";

  constructor(
    private readonly mask: Masker,
    options: { chargedUsd?: number; now?: () => number } = {},
  ) {
    this.chargedUsd = options.chargedUsd ?? 0;
    this.now = options.now ?? Date.now;
  }

  private readonly now: () => number;

  /** A new turn starts: the text the gate heuristic reads is this turn's. */
  beginTurn(): void {
    this.lastText = "";
    this.streaming.clear();
  }

  map(message: SDKMessage): MappedEvent[] {
    switch (message.type) {
      case "system":
        return this.system(message);
      case "stream_event":
        return this.stream(message.event, message.parent_tool_use_id);
      case "assistant":
        return this.assistant(message);
      case "user":
        return this.user(message);
      case "result":
        return this.result(message);
      default:
        return [];
    }
  }

  private system(message: Extract<SDKMessage, { type: "system" }>): MappedEvent[] {
    if (message.subtype === "init") {
      this.sessionId = message.session_id;
      return [];
    }
    if (message.subtype === "task_started" && message.tool_use_id && !this.subagents.has(message.tool_use_id)) {
      this.subagents.set(message.tool_use_id, true);
      return [
        event(
          {
            kind: "subagent",
            toolUseId: message.tool_use_id,
            name: message.subagent_type ?? "agent",
            description: message.description,
            state: "started",
          },
          null,
        ),
      ];
    }
    if (message.subtype === "task_notification" && message.tool_use_id && this.subagents.has(message.tool_use_id)) {
      this.subagents.delete(message.tool_use_id);
      return [
        event(
          { kind: "subagent", toolUseId: message.tool_use_id, name: "agent", description: message.summary.slice(0, 300), state: "stopped" },
          null,
        ),
      ];
    }
    return [];
  }

  private stream(streamEvent: StreamEvent, parent: string | null): MappedEvent[] {
    const key = `${parent ?? ""}:${"index" in streamEvent ? streamEvent.index : ""}`;
    if (streamEvent.type === "content_block_start" && streamEvent.content_block.type === "text") {
      this.streaming.set(key, { text: streamEvent.content_block.text ?? "", lastEmit: this.now() });
      return [];
    }
    if (streamEvent.type === "content_block_delta" && streamEvent.delta.type === "text_delta") {
      const block = this.streaming.get(key);
      if (!block) return [];
      block.text += streamEvent.delta.text;
      const now = this.now();
      if (now - block.lastEmit < PARTIAL_INTERVAL_MS) return [];
      block.lastEmit = now;
      return [event({ kind: "text", text: this.cutText(block.text), final: false }, parent)];
    }
    if (streamEvent.type === "content_block_stop") this.streaming.delete(key);
    return [];
  }

  private assistant(message: AssistantMessage): MappedEvent[] {
    if (!this.once(message.uuid)) return [];
    const parent = message.parent_tool_use_id;
    const events: MappedEvent[] = [];
    for (const block of message.message.content) events.push(...this.block(block, parent));
    if (message.error) events.push(event({ kind: "error", message: describeError(message.error) }, parent));
    return events;
  }

  private block(block: ContentBlock, parent: string | null): MappedEvent[] {
    switch (block.type) {
      case "text": {
        const text = this.cutText(block.text);
        if (!text.trim()) return [];
        if (parent === null) this.lastText = text;
        return [event({ kind: "text", text, final: true }, parent)];
      }
      case "thinking":
        return block.thinking.trim() ? [event({ kind: "thinking", text: this.cutText(block.thinking) }, parent)] : [];
      case "tool_use": {
        const input = isRecord(block.input) ? block.input : {};
        const events: MappedEvent[] = [
          event({ kind: "tool_use", toolUseId: block.id, name: block.name, summary: this.mask.text(toolSummary(block.name, input)), input: this.sanitizeInput(input) }, parent),
        ];
        if (isSubagentTool(block.name)) {
          this.subagents.set(block.id, input.run_in_background === true);
          events.push(
            event(
              {
                kind: "subagent",
                toolUseId: block.id,
                name: str(input.subagent_type) || str(input.name) || "agent",
                description: this.mask.text(str(input.description) || str(input.prompt).slice(0, 200)),
                state: "started",
              },
              parent,
            ),
          );
        }
        return events;
      }
      default:
        return [];
    }
  }

  private user(message: UserMessage): MappedEvent[] {
    if ("isReplay" in message && message.isReplay) return [];
    if (message.uuid && !this.once(message.uuid)) return [];
    const content = message.message.content;
    if (typeof content === "string") return [];
    const parent = message.parent_tool_use_id;
    const events: MappedEvent[] = [];
    for (const block of content) {
      if (block.type !== "tool_result") continue;
      const raw = toolResultText(block.content);
      const masked = this.mask.text(raw);
      const truncated = masked.length > TOOL_OUTPUT_MAX_CHARS;
      events.push(
        event(
          {
            kind: "tool_result",
            toolUseId: block.tool_use_id,
            output: truncated ? masked.slice(0, TOOL_OUTPUT_MAX_CHARS) : masked,
            isError: block.is_error === true,
            truncated,
          },
          parent,
        ),
      );
      /* A foreground subagent is done with its result; a background one
         reports later through task_notification. */
      if (this.subagents.get(block.tool_use_id) === false) {
        this.subagents.delete(block.tool_use_id);
        events.push(event({ kind: "subagent", toolUseId: block.tool_use_id, name: "agent", description: "", state: "stopped" }, parent));
      }
    }
    return events;
  }

  private result(message: SDKResultMessage): MappedEvent[] {
    this.sessionId = message.session_id;
    const total = Number.isFinite(message.total_cost_usd) ? message.total_cost_usd : 0;
    /* A resumed session's result carries the transcript's running total;
       a fresh count (a smaller number) is a new query's own cost. */
    const costUsd = total >= this.chargedUsd ? total - this.chargedUsd : total;
    this.chargedUsd = total >= this.chargedUsd ? total : this.chargedUsd + total;
    const events: MappedEvent[] = [
      event(
        {
          kind: "result",
          subtype: message.subtype,
          costUsd: round4(costUsd),
          turns: message.num_turns,
          durationMs: message.duration_ms,
          sessionId: message.session_id,
        },
        null,
      ),
    ];
    const failure = resultError(message);
    if (failure) events.push(event({ kind: "error", message: this.mask.text(failure) }, null));
    return events;
  }

  private once(uuid: string): boolean {
    if (this.seen.has(uuid)) return false;
    this.seen.add(uuid);
    if (this.seen.size > 5_000) this.seen.delete(this.seen.values().next().value as string);
    return true;
  }

  private cutText(text: string): string {
    const masked = this.mask.text(text);
    return masked.length > EVENT_TEXT_MAX_CHARS ? `${masked.slice(0, EVENT_TEXT_MAX_CHARS)}\n\n…[cut]` : masked;
  }

  private sanitizeInput(input: Record<string, unknown>): Record<string, unknown> {
    return this.mask.value(cutStrings(input)) as Record<string, unknown>;
  }
}

/* ---------- turn outcome ---------- */

export type TurnOutcome = { status: Extract<AgentRunStatus, "waiting" | "done" | "failed">; reason: string | null };

/** What a finished turn means for the run. The skills end a turn at every
    gate ("present the work, wait for the verdict"), so a turn that ends
    asking leaves the run waiting on a person; a turn that ends stating
    closes it. Turn or budget limits are not failures: a reply continues. */
export function turnOutcome(result: SDKResultMessage, lastText: string): TurnOutcome {
  if (result.subtype === "success") {
    if (result.is_error) return { status: "failed", reason: result.result || "The model answered with an error" };
    return isAsking(lastText) ? { status: "waiting", reason: null } : { status: "done", reason: null };
  }
  if (result.subtype === "error_max_turns") return { status: "waiting", reason: "turn limit reached; reply to continue" };
  if (result.subtype === "error_max_budget_usd") return { status: "waiting", reason: "budget reached; reply to continue" };
  return { status: "failed", reason: resultError(result) ?? result.subtype };
}

const ASKING = /\b(approve|approval|confirm|verdict|let me know|tell me|your (call|decision|choice|verdict|pick)|should i|shall i|which (one|option|do you)|do you want|would you like|ready to proceed|waiting for|go ahead|say the word|give me the go|pick one|choose)\b/i;

/** The last paragraph decides: a question mark, a trailing colon (options
    follow) or one of the phrases the gates are written in. */
export function isAsking(text: string): boolean {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter(Boolean);
  const last = paragraphs[paragraphs.length - 1] ?? "";
  if (!last) return false;
  if (last.includes("?")) return true;
  if (/[:：]\s*$/.test(last)) return true;
  return ASKING.test(last);
}

/* ---------- helpers ---------- */

function event(payload: AgentEventPayload, parentToolUseId: string | null): MappedEvent {
  return { payload, parentToolUseId };
}

function isSubagentTool(name: string): boolean {
  return name === "Task" || name === "Agent";
}

/** One line for a collapsed tool row. */
export function toolSummary(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case "Bash":
      return commandHeadline(str(input.command)) || "Bash";
    case "Read":
    case "Write":
    case "Edit":
    case "MultiEdit":
      return str(input.file_path) || name;
    case "NotebookEdit":
      return str(input.notebook_path) || name;
    case "Task":
    case "Agent":
      return str(input.subagent_type) || str(input.name) || str(input.description) || name;
    case "Glob":
    case "Grep":
      return str(input.pattern) || name;
    case "WebFetch":
      return str(input.url) || name;
    case "WebSearch":
      return str(input.query) || name;
    case "Skill":
      return str(input.skill) || str(input.command) || name;
    case "AskUserQuestion": {
      const questions = Array.isArray(input.questions) ? (input.questions as Array<Record<string, unknown>>) : [];
      return str(questions[0]?.question) || name;
    }
    default:
      if (name.startsWith("mcp__studio__")) return `${name.slice("mcp__studio__".length)} ${str(input.path) || str(input.title) || ""}`.trim();
      return name;
  }
}

/** The questions as the contract spells them, whatever extra fields the
    tool's input carries (previews, future options). */
export function readQuestions(input: Record<string, unknown>): Question[] {
  const raw = Array.isArray(input.questions) ? (input.questions as unknown[]) : [];
  return raw.filter(isRecord).map((entry) => ({
    question: str(entry.question),
    header: str(entry.header),
    multiSelect: entry.multiSelect === true,
    options: (Array.isArray(entry.options) ? (entry.options as unknown[]) : [])
      .filter(isRecord)
      .map((option) => ({ label: str(option.label), description: str(option.description) })),
  }));
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (!isRecord(block)) return "";
      if (block.type === "text") return str(block.text);
      if (block.type === "image") return "[image]";
      if (block.type === "document") return "[document]";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function resultError(result: SDKResultMessage): string | null {
  if (result.subtype === "success") return result.is_error ? result.result || "The model answered with an error" : null;
  const errors = result.errors.filter(Boolean);
  if (errors.length > 0) return errors.join("\n").slice(0, 2_000);
  switch (result.subtype) {
    case "error_max_turns":
      return null;
    case "error_max_budget_usd":
      return null;
    default:
      return `The session ended early (${result.subtype})`;
  }
}

function describeError(error: AssistantMessage["error"]): string {
  switch (error) {
    case "authentication_failed":
      return "Anthropic refused the worker's API key";
    case "billing_error":
      return "Anthropic billing error on the worker's account";
    case "rate_limit":
      return "Anthropic rate limit; the session retries";
    case "overloaded":
      return "Anthropic is overloaded; the session retries";
    case "max_output_tokens":
      return "The answer hit the output limit";
    default:
      return `Model error: ${String(error)}`;
  }
}

function cutStrings(value: unknown): unknown {
  if (typeof value === "string") return value.length > INPUT_STRING_MAX ? `${value.slice(0, INPUT_STRING_MAX)}…[cut]` : value;
  if (Array.isArray(value)) return value.map(cutStrings);
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, cutStrings(entry)]));
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
