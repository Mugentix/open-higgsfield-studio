import type { SDKMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";

import { EVENT_TEXT_MAX_CHARS, TOOL_OUTPUT_MAX_CHARS } from "@/server/agents-contract";

import { EventMapper, PARTIAL_INTERVAL_MS, isAsking, readQuestions, toolSummary, turnOutcome } from "../../worker/events";
import { MASK, Masker } from "../../worker/mask";

/* Synthetic SDK messages, shaped like the ones the CLI emits; only the fields
   the mapper reads are filled, hence the casts. */

let uuids = 0;
const uuid = () => `u-${++uuids}`;

function assistant(content: unknown[], over: Record<string, unknown> = {}): SDKMessage {
  return {
    type: "assistant",
    uuid: uuid(),
    session_id: "s1",
    parent_tool_use_id: null,
    message: { id: "m1", role: "assistant", model: "claude", content, stop_reason: null, usage: {} },
    ...over,
  } as unknown as SDKMessage;
}

function user(content: unknown[], over: Record<string, unknown> = {}): SDKMessage {
  return { type: "user", uuid: uuid(), session_id: "s1", parent_tool_use_id: null, message: { role: "user", content }, ...over } as unknown as SDKMessage;
}

function stream(event: Record<string, unknown>, parent: string | null = null): SDKMessage {
  return { type: "stream_event", uuid: uuid(), session_id: "s1", parent_tool_use_id: parent, event } as unknown as SDKMessage;
}

function result(over: Record<string, unknown> = {}): SDKResultMessage {
  return {
    type: "result",
    subtype: "success",
    uuid: uuid(),
    session_id: "s1",
    duration_ms: 1500,
    duration_api_ms: 1200,
    is_error: false,
    num_turns: 3,
    result: "done",
    stop_reason: "end_turn",
    total_cost_usd: 0.05,
    usage: {},
    modelUsage: {},
    permission_denials: [],
    ...over,
  } as unknown as SDKResultMessage;
}

function mapper(options: { chargedUsd?: number; now?: () => number } = {}) {
  return new EventMapper(new Masker({ KIE_API_KEY: "kie-0123456789abcdef" }), options);
}

describe("EventMapper", () => {
  it("takes the session id from init and emits nothing for it", () => {
    const m = mapper();
    expect(m.map({ type: "system", subtype: "init", session_id: "sess-1", uuid: uuid() } as unknown as SDKMessage)).toEqual([]);
    expect(m.sessionId).toBe("sess-1");
  });

  it("streams a text block as throttled partials, then the final block from the assistant message", () => {
    let clock = 1_000;
    const m = mapper({ now: () => clock });
    expect(m.map(stream({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }))).toEqual([]);
    expect(m.map(stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } }))).toEqual([]);
    clock += PARTIAL_INTERVAL_MS;
    expect(m.map(stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo " } }))).toEqual([
      { payload: { kind: "text", text: "Hello ", final: false }, parentToolUseId: null },
    ]);
    clock += 100;
    expect(m.map(stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "wor" } }))).toEqual([]);
    expect(m.map(stream({ type: "content_block_stop", index: 0 }))).toEqual([]);
    expect(m.map(assistant([{ type: "text", text: "Hello world?" }]))).toEqual([{ payload: { kind: "text", text: "Hello world?", final: true }, parentToolUseId: null }]);
    expect(m.lastText).toBe("Hello world?");
  });

  it("keeps a subagent's partials under its parent tool use", () => {
    let clock = 0;
    const m = mapper({ now: () => clock });
    m.map(stream({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, "task-1"));
    clock += PARTIAL_INTERVAL_MS;
    expect(m.map(stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "sub" } }, "task-1"))).toEqual([
      { payload: { kind: "text", text: "sub", final: false }, parentToolUseId: "task-1" },
    ]);
    m.map(assistant([{ type: "text", text: "subagent says" }], { parent_tool_use_id: "task-1" }));
    expect(m.lastText).toBe("");
  });

  it("maps thinking, tool uses and subagent starts, masking and cutting inputs", () => {
    const m = mapper();
    const long = "x".repeat(5_000);
    const events = m.map(
      assistant([
        { type: "thinking", thinking: "let me think", signature: "sig" },
        { type: "redacted_thinking", data: "..." },
        { type: "tool_use", id: "t1", name: "Bash", input: { command: "export KEY=kie-0123456789abcdef\npython3 run.py", description: long } },
        { type: "tool_use", id: "t2", name: "Read", input: { file_path: "/home/x/SKILL.md" } },
        { type: "tool_use", id: "t3", name: "Task", input: { subagent_type: "sd2-qc", description: "QC the takes", prompt: "..." } },
      ]),
    );
    expect(events.map((event) => event.payload.kind)).toEqual(["thinking", "tool_use", "tool_use", "tool_use", "subagent"]);
    expect(events[0]!.payload).toEqual({ kind: "thinking", text: "let me think" });
    const bash = events[1]!.payload as Extract<(typeof events)[number]["payload"], { kind: "tool_use" }>;
    expect(bash.summary).toBe(`export KEY=${MASK}`);
    expect(bash.input.command).toBe(`export KEY=${MASK}\npython3 run.py`);
    expect((bash.input.description as string).length).toBeLessThan(4_100);
    expect((bash.input.description as string).endsWith("…[cut]")).toBe(true);
    expect(events[2]!.payload).toMatchObject({ kind: "tool_use", toolUseId: "t2", name: "Read", summary: "/home/x/SKILL.md" });
    expect(events[4]!.payload).toEqual({ kind: "subagent", toolUseId: "t3", name: "sd2-qc", description: "QC the takes", state: "started" });
  });

  it("maps tool results, cutting long output, and closes a foreground subagent on its result", () => {
    const m = mapper();
    m.map(assistant([{ type: "tool_use", id: "t3", name: "Task", input: { subagent_type: "sd2-qc", description: "QC" } }]));
    const big = "y".repeat(TOOL_OUTPUT_MAX_CHARS + 50);
    const events = m.map(
      user([
        { type: "tool_result", tool_use_id: "t1", content: big, is_error: false },
        { type: "tool_result", tool_use_id: "t2", content: [{ type: "text", text: "line" }, { type: "image", source: {} }], is_error: true },
        { type: "tool_result", tool_use_id: "t3", content: "report" },
      ]),
    );
    expect(events[0]!.payload).toMatchObject({ kind: "tool_result", toolUseId: "t1", isError: false, truncated: true });
    expect((events[0]!.payload as { output: string }).output).toHaveLength(TOOL_OUTPUT_MAX_CHARS);
    expect(events[1]!.payload).toEqual({ kind: "tool_result", toolUseId: "t2", output: "line\n[image]", isError: true, truncated: false });
    expect(events[2]!.payload).toMatchObject({ kind: "tool_result", toolUseId: "t3" });
    expect(events[3]!.payload).toMatchObject({ kind: "subagent", toolUseId: "t3", state: "stopped" });
  });

  it("waits for the task notification before closing a background subagent", () => {
    const m = mapper();
    m.map(assistant([{ type: "tool_use", id: "t9", name: "Agent", input: { description: "render", run_in_background: true } }]));
    const onResult = m.map(user([{ type: "tool_result", tool_use_id: "t9", content: "started in the background" }]));
    expect(onResult.map((event) => event.payload.kind)).toEqual(["tool_result"]);
    const onDone = m.map({ type: "system", subtype: "task_notification", tool_use_id: "t9", task_id: "k", status: "completed", summary: "rendered", output_file: "", uuid: uuid(), session_id: "s1" } as unknown as SDKMessage);
    expect(onDone).toEqual([{ payload: { kind: "subagent", toolUseId: "t9", name: "agent", description: "rendered", state: "stopped" }, parentToolUseId: null }]);
    expect(m.map({ type: "system", subtype: "task_notification", tool_use_id: "t9", task_id: "k", status: "completed", summary: "again", output_file: "", uuid: uuid(), session_id: "s1" } as unknown as SDKMessage)).toEqual([]);
  });

  it("ignores replays, repeats and plain user prompts", () => {
    const m = mapper();
    const message = assistant([{ type: "text", text: "once" }]);
    expect(m.map(message)).toHaveLength(1);
    expect(m.map(message)).toEqual([]);
    expect(m.map(user([{ type: "tool_result", tool_use_id: "t", content: "x" }], { isReplay: true }))).toEqual([]);
    expect(m.map(user([{ type: "text", text: "hello" }]))).toEqual([]);
  });

  it("charges only what a result adds to the total already charged", () => {
    const m = mapper({ chargedUsd: 0.02 });
    expect(m.map(result({ total_cost_usd: 0.05 }))[0]!.payload).toMatchObject({ kind: "result", costUsd: 0.03, turns: 3, durationMs: 1500, sessionId: "s1", subtype: "success" });
    expect(m.map(result({ total_cost_usd: 0.08 }))[0]!.payload).toMatchObject({ costUsd: 0.03 });
    /* A smaller total is a fresh count, not a refund. */
    expect(m.map(result({ total_cost_usd: 0.01 }))[0]!.payload).toMatchObject({ costUsd: 0.01 });
    expect(m.sessionId).toBe("s1");
  });

  it("adds an error event to a failed result and to an assistant error", () => {
    const m = mapper();
    const failed = m.map(result({ subtype: "error_during_execution", is_error: true, errors: ["boom with kie-0123456789abcdef"] }));
    expect(failed.map((event) => event.payload.kind)).toEqual(["result", "error"]);
    expect(failed[1]!.payload).toEqual({ kind: "error", message: `boom with ${MASK}` });
    const auth = m.map(assistant([], { error: "authentication_failed" }));
    expect(auth).toEqual([{ payload: { kind: "error", message: "Anthropic refused the worker's API key" }, parentToolUseId: null }]);
  });

  it("cuts a text block at the event limit", () => {
    const m = mapper();
    const [event] = m.map(assistant([{ type: "text", text: "z".repeat(EVENT_TEXT_MAX_CHARS + 10) }]));
    expect((event!.payload as { text: string }).text.length).toBeLessThanOrEqual(EVENT_TEXT_MAX_CHARS + 10);
    expect((event!.payload as { text: string }).text.endsWith("…[cut]")).toBe(true);
  });
});

describe("turnOutcome", () => {
  it("leaves the run waiting when the turn ended asking, done when it ended stating", () => {
    expect(turnOutcome(result(), "Here is the plan.\n\nWhich angle should I take?")).toEqual({ status: "waiting", reason: null });
    expect(turnOutcome(result(), "All three hooks are under outputs/ and on the wall.")).toEqual({ status: "done", reason: null });
    expect(turnOutcome(result(), "GATE: review the board above and give me your verdict before I spend.")).toEqual({ status: "waiting", reason: null });
    expect(turnOutcome(result(), "Options:\n\n1. Pain\n2. Dream\n\nPick one:")).toEqual({ status: "waiting", reason: null });
  });

  it("treats limits as pauses and execution errors as failures", () => {
    expect(turnOutcome(result({ subtype: "error_max_turns", is_error: true, errors: [] }), "")).toEqual({ status: "waiting", reason: "turn limit reached; reply to continue" });
    expect(turnOutcome(result({ subtype: "error_max_budget_usd", is_error: true, errors: [] }), "")).toEqual({ status: "waiting", reason: "budget reached; reply to continue" });
    expect(turnOutcome(result({ subtype: "error_during_execution", is_error: true, errors: ["spawn failed"] }), "")).toEqual({ status: "failed", reason: "spawn failed" });
    expect(turnOutcome(result({ is_error: true, result: "API error 529" }), "")).toEqual({ status: "failed", reason: "API error 529" });
  });
});

describe("isAsking", () => {
  it("reads the last paragraph only", () => {
    expect(isAsking("Should I continue?\n\nI went ahead and finished everything.")).toBe(false);
    expect(isAsking("I finished.\n\nShould I continue?")).toBe(true);
    expect(isAsking("")).toBe(false);
    expect(isAsking("Let me know which one you prefer.")).toBe(true);
  });
});

describe("toolSummary and readQuestions", () => {
  it("summarises by tool", () => {
    expect(toolSummary("Bash", { command: "ls\npwd" })).toBe("ls");
    expect(toolSummary("Write", { file_path: "outputs/plan.md" })).toBe("outputs/plan.md");
    expect(toolSummary("Grep", { pattern: "TODO" })).toBe("TODO");
    expect(toolSummary("WebFetch", { url: "https://x.y" })).toBe("https://x.y");
    expect(toolSummary("mcp__studio__publish", { path: "outputs/a.png" })).toBe("publish outputs/a.png");
    expect(toolSummary("AskUserQuestion", { questions: [{ question: "Which?" }] })).toBe("Which?");
    expect(toolSummary("Unknown", {})).toBe("Unknown");
  });

  it("normalises questions to the contract's shape", () => {
    expect(
      readQuestions({
        questions: [
          { question: "Which angle?", header: "Angle", multiSelect: false, options: [{ label: "Pain", description: "d", preview: "<p>" }, { label: "Dream" }] },
          "junk",
        ],
      }),
    ).toEqual([
      { question: "Which angle?", header: "Angle", multiSelect: false, options: [{ label: "Pain", description: "d" }, { label: "Dream", description: "" }] },
    ]);
  });
});
