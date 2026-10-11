import { describe, expect, it } from "vitest";

import {
  STATUS_WORDS,
  announcementFor,
  buildStream,
  formatBytes,
  formatDuration,
  formatUsd,
  isLive,
  isOpen,
  mergeEvents,
  pollInterval,
  receivePage,
  toolGlyph,
  type GroupNode,
  type ToolNode,
} from "@/openhiggsfield/agents/events";
import { escapeHtml, renderMarkdown, safeUrl } from "@/openhiggsfield/agents/markdown";
import type { AgentEventPayload, AgentEventRecord, AgentRunRecord, AgentRunStatus } from "@/server/agents-contract";

/* The run view draws the worker's log through two pure modules: the Markdown
   renderer that shows the agent's words without trusting them, and the
   grouping that folds a flat, numbered log into a stream. Both are pinned
   here, with the words the status pills and the live region use. */

describe("renderMarkdown", () => {
  it("escapes every character of text, so markup in the agent's words is shown, not run", () => {
    expect(renderMarkdown("<script>alert(1)</script> & <img src=x onerror=alert(1)>")).toBe(
      "<p>&lt;script&gt;alert(1)&lt;/script&gt; &amp; &lt;img src=x onerror=alert(1)&gt;</p>",
    );
    expect(escapeHtml(`"quoted" & 'single'`)).toBe("&quot;quoted&quot; &amp; &#39;single&#39;");
  });

  it("renders paragraphs with soft breaks and a blank line between them", () => {
    expect(renderMarkdown("one\ntwo\n\nthree")).toBe("<p>one<br>two</p><p>three</p>");
  });

  it("steps headings down two levels under the run's own heading", () => {
    expect(renderMarkdown("# Plan\n## Takes\n#### Deep\n###### Deepest")).toBe("<h3>Plan</h3><h4>Takes</h4><h6>Deep</h6><h6>Deepest</h6>");
    expect(renderMarkdown("#hashtag is a paragraph")).toBe("<p>#hashtag is a paragraph</p>");
  });

  it("keeps a fenced block verbatim and escaped, with the language as a class", () => {
    expect(renderMarkdown("```bash\npython3 scripts/kie.py watch <id> && echo \"done\"\n```")).toBe(
      '<pre><code class="language-bash">python3 scripts/kie.py watch &lt;id&gt; &amp;&amp; echo &quot;done&quot;</code></pre>',
    );
    /* A fence that never closes runs to the end rather than swallowing the stream. */
    expect(renderMarkdown("```\n**not bold**")).toBe("<pre><code>**not bold**</code></pre>");
    /* A language that is not a word cannot become an attribute. */
    expect(renderMarkdown('```x"onload=alert(1)\ncode\n```')).toBe("<pre><code>code</code></pre>");
  });

  it("renders bullet and numbered lists, nested by indent, tight and loose", () => {
    expect(renderMarkdown("- a\n- b\n  - b1\n  - b2\n- c")).toBe("<ul><li>a</li><li>b<ul><li>b1</li><li>b2</li></ul></li><li>c</li></ul>");
    expect(renderMarkdown("3. three\n4. four")).toBe('<ol start="3"><li>three</li><li>four</li></ol>');
    expect(renderMarkdown("1. one\n\n   more about one\n2. two")).toBe("<ol><li><p>one</p><p>more about one</p></li><li>two</li></ol>");
    /* A line under an item without the indent continues its sentence. */
    expect(renderMarkdown("- a long\nitem\n- b")).toBe("<ul><li>a long<br>item</li><li>b</li></ul>");
    /* A different marker is a different list. */
    expect(renderMarkdown("- a\n* b")).toBe("<ul><li>a</li></ul><ul><li>b</li></ul>");
  });

  it("does not let a year or a stray dash in a paragraph open a list", () => {
    expect(renderMarkdown("Shot in\n2024. A good year")).toBe("<p>Shot in<br>2024. A good year</p>");
    expect(renderMarkdown("Shot in\n1. A good year")).toBe("<p>Shot in</p><ol><li>A good year</li></ol>");
  });

  it("renders quotes, rules and the inline marks", () => {
    expect(renderMarkdown("> quoted\n> words")).toBe("<blockquote><p>quoted<br>words</p></blockquote>");
    expect(renderMarkdown("above\n\n---\n\nbelow")).toBe("<p>above</p><hr><p>below</p>");
    expect(renderMarkdown("**bold** and *em* and ~~gone~~ and `code <b>`")).toBe(
      "<p><strong>bold</strong> and <em>em</em> and <del>gone</del> and <code>code &lt;b&gt;</code></p>",
    );
    expect(renderMarkdown("__bold__ with _em_ inside snake_case_name")).toBe("<p><strong>bold</strong> with <em>em</em> inside snake_case_name</p>");
    expect(renderMarkdown("a * b * c and 2 * 3")).toBe("<p>a * b * c and 2 * 3</p>");
    expect(renderMarkdown("``a ` b``")).toBe("<p><code>a ` b</code></p>");
    expect(renderMarkdown("\\*not em\\* and \\# not a heading")).toBe("<p>*not em* and # not a heading</p>");
  });

  it("lets a link through on http, https and mailto only, and never as markup", () => {
    expect(renderMarkdown("[kie](https://kie.ai/api-key)")).toBe(
      '<p><a href="https://kie.ai/api-key" target="_blank" rel="noopener noreferrer">kie</a></p>',
    );
    expect(renderMarkdown('[t](https://x.y "a \\"title")')).toBe(
      '<p><a href="https://x.y" target="_blank" rel="noopener noreferrer" title="a &quot;title">t</a></p>',
    );
    expect(renderMarkdown("[run](javascript:alert(1))")).toBe("<p>run (javascript:alert(1))</p>");
    expect(renderMarkdown("[board](outputs/board.md)")).toBe("<p>board (outputs/board.md)</p>");
    expect(renderMarkdown('[x](https://a.b/"onmouseover="alert(1))')).toBe(
      '<p><a href="https://a.b/&quot;onmouseover=&quot;alert(1)" target="_blank" rel="noopener noreferrer">x</a></p>',
    );
    expect(renderMarkdown("![alt](https://img.test/a.png)")).toBe(
      '<p><a href="https://img.test/a.png" target="_blank" rel="noopener noreferrer">alt</a></p>',
    );
    expect(renderMarkdown("<https://a.b/c>")).toBe('<p><a href="https://a.b/c" target="_blank" rel="noopener noreferrer">https://a.b/c</a></p>');
    expect(renderMarkdown("see https://a.b/c, then.")).toBe(
      '<p>see <a href="https://a.b/c" target="_blank" rel="noopener noreferrer">https://a.b/c</a>, then.</p>',
    );
    expect(renderMarkdown("(https://a.b/c(d))")).toBe('<p>(<a href="https://a.b/c(d)" target="_blank" rel="noopener noreferrer">https://a.b/c(d)</a>)</p>');
    expect(safeUrl(" HTTPS://x.y ")).toBe("HTTPS://x.y");
    expect(safeUrl("data:text/html,hi")).toBeNull();
    expect(safeUrl("//evil.test")).toBeNull();
    expect(safeUrl("https://a.b/with space")).toBeNull();
  });

  it("renders a pipe table with its alignment", () => {
    expect(renderMarkdown("| take | grade |\n|:--|--:|\n| 1 | ok |\n| 2 | **redo** |")).toBe(
      '<table><thead><tr><th data-align="left">take</th><th data-align="right">grade</th></tr></thead>' +
        '<tbody><tr><td data-align="left">1</td><td data-align="right">ok</td></tr>' +
        '<tr><td data-align="left">2</td><td data-align="right"><strong>redo</strong></td></tr></tbody></table>',
    );
    /* A pipe in a sentence is not a table. */
    expect(renderMarkdown("a | b\nc | d")).toBe("<p>a | b<br>c | d</p>");
  });

  it("renders nothing for nothing", () => {
    expect(renderMarkdown("")).toBe("");
    expect(renderMarkdown("\n\n  \n")).toBe("");
  });
});

/* ---------- the event log ---------- */

let seq = 0;

function event(payload: AgentEventPayload, parentToolUseId: string | null = null): AgentEventRecord {
  seq += 1;
  return { id: `e${seq}`, runId: "run-1", seq, at: 1_000 + seq, parentToolUseId, payload };
}

function run(status: AgentRunStatus, patch: Partial<AgentRunRecord> = {}): AgentRunRecord {
  return {
    id: "run-1",
    teamId: "t1",
    projectId: "p1",
    productId: "pr1",
    skillId: "s1",
    skillName: "Drama Ad Machine",
    skillSlug: "drama-ad-machine",
    title: "Spring hooks",
    brief: "Make three hooks",
    status,
    sessionId: null,
    workspace: null,
    costUsd: 0,
    credits: 0,
    lastSeq: seq,
    error: null,
    createdBy: "u1",
    createdByName: "Besir",
    createdAt: 1,
    updatedAt: 1,
    startedAt: null,
    endedAt: null,
    ...patch,
  };
}

const text = (body: string, final = true): AgentEventPayload => ({ kind: "text", text: body, final });
const toolUse = (toolUseId: string, name: string, summary = name): AgentEventPayload => ({ kind: "tool_use", toolUseId, name, summary, input: {} });
const toolResult = (toolUseId: string, output = "ok"): AgentEventPayload => ({ kind: "tool_result", toolUseId, output, isError: false, truncated: false });
const question = (questionId: string): AgentEventPayload => ({
  kind: "question",
  questionId,
  questions: [{ question: "Which hook?", header: "Hook", options: [{ label: "A", description: "" }], multiSelect: false }],
  answers: null,
  answeredBy: null,
});
const approval = (approvalId: string, command = "python3 kie.py watch --confirm-paid"): AgentEventPayload => ({
  kind: "approval",
  approvalId,
  toolName: "Bash",
  command,
  reason: "paid",
  decision: null,
  decidedBy: null,
});

describe("mergeEvents", () => {
  it("appends by seq, replaces a seq already held, and keeps the log's order", () => {
    const a = event(text("a"));
    const b = event(question("q1"));
    const c = event(text("c"));
    const answered: AgentEventRecord = { ...b, payload: { ...(b.payload as Extract<AgentEventPayload, { kind: "question" }>), answers: { "Which hook?": "A" }, answeredBy: "Ana" } };
    const merged = mergeEvents([a, b], [c, answered]);
    expect(merged.map((entry) => entry.seq)).toEqual([a.seq, b.seq, c.seq]);
    expect((merged[1]!.payload as Extract<AgentEventPayload, { kind: "question" }>).answeredBy).toBe("Ana");
    expect(mergeEvents([a], [])).toEqual([a]);
  });
});

describe("receivePage", () => {
  it("moves the watermark over the events page only, and holds back a gate from past it until its page arrives", () => {
    const page1 = [event(text("1")), event(text("2")), event(text("3"))];
    const settledEarly = event(question("q0"));
    const late = event(text("5"));
    const gate = event(approval("a1"));
    /* Page one holds seqs 1–3; the run's gates come back as they stand: one from inside the page, one from past it. */
    const first = receivePage([], { events: page1, gates: [gate] }, 0);
    expect(first.lastSeq).toBe(page1[2]!.seq);
    expect(first.events.map((entry) => entry.seq)).toEqual(page1.map((entry) => entry.seq));

    /* Page two: the gate is inside it now, and a settled version of an earlier gate replaces what is held. */
    const second = receivePage(first.events, { events: [settledEarly, late, gate], gates: [gate] }, first.lastSeq);
    expect(second.lastSeq).toBe(gate.seq);
    expect(second.events.map((entry) => entry.seq)).toEqual([...page1, settledEarly, late, gate].map((entry) => entry.seq));

    /* An empty page moves nothing, and still takes a rewritten gate it has already passed. */
    const decided: AgentEventRecord = { ...gate, payload: { ...(gate.payload as Extract<AgentEventPayload, { kind: "approval" }>), decision: "approved", decidedBy: "Ana" } };
    const third = receivePage(second.events, { events: [], gates: [decided] }, second.lastSeq);
    expect(third.lastSeq).toBe(gate.seq);
    expect((third.events.at(-1)!.payload as Extract<AgentEventPayload, { kind: "approval" }>).decidedBy).toBe("Ana");
  });
});

describe("buildStream", () => {
  it("folds a tool result onto its call and leaves an orphan result standing", () => {
    const call = event(toolUse("t1", "Bash", "ls"));
    const result = event(toolResult("t1"));
    const orphan = event(toolResult("t9", "late"));
    const nodes = buildStream([call, result, orphan]);
    expect(nodes.map((node) => node.kind)).toEqual(["tool", "event"]);
    expect((nodes[0] as ToolNode).result?.seq).toBe(result.seq);
    expect((nodes[1] as { event: AgentEventRecord }).event.seq).toBe(orphan.seq);
  });

  it("shows a streamed text block once, as its final piece, and keeps a piece the agent left hanging", () => {
    const p1 = event(text("Hel", false));
    const p2 = event(text("Hello wor", false));
    const status = event({ kind: "status", status: "running", reason: null });
    const final = event(text("Hello world", true));
    const dangling = event(text("Then I", false));
    const call = event(toolUse("t1", "Read", "SKILL.md"));
    const nodes = buildStream([p1, p2, status, final, dangling, call]);
    const shown = nodes.map((node) => (node.kind === "event" ? node.event.seq : node.kind === "tool" ? `tool:${node.event.seq}` : "group"));
    expect(shown).toEqual([status.seq, final.seq, dangling.seq, `tool:${call.seq}`]);
  });

  it("groups a subagent's events under its Task, with the start, stop and the call itself", () => {
    const call = event(toolUse("task-1", "Task", "sd2-inspector"));
    const started = event({ kind: "subagent", toolUseId: "task-1", name: "sd2-inspector", description: "Grade the takes", state: "started" });
    const inner = event(text("Grading…"), "task-1");
    const innerCall = event(toolUse("t2", "Bash", "ffprobe"), "task-1");
    const innerResult = event(toolResult("t2"), "task-1");
    const stopped = event({ kind: "subagent", toolUseId: "task-1", name: "sd2-inspector", description: "Grade the takes", state: "stopped" });
    const result = event(toolResult("task-1", "3 anomalies"));
    const after = event(text("Done."));
    const nodes = buildStream([call, started, inner, innerCall, innerResult, stopped, result, after]);
    expect(nodes.map((node) => node.kind)).toEqual(["group", "event"]);
    const group = nodes[0] as GroupNode;
    expect(group.name).toBe("sd2-inspector");
    expect(group.description).toBe("Grade the takes");
    expect(group.state).toBe("stopped");
    expect(group.task?.seq).toBe(call.seq);
    expect(group.result?.seq).toBe(result.seq);
    expect(group.children.map((node) => node.kind)).toEqual(["event", "tool"]);
    expect((group.children[1] as ToolNode).result?.seq).toBe(innerResult.seq);
  });

  it("still groups when the worker recorded only the Task call, and reads the name off its input", () => {
    const call: AgentEventRecord = event({ kind: "tool_use", toolUseId: "task-2", name: "Task", summary: "Task", input: { subagent_type: "sca-director", description: "Block the scene" } });
    const inner = event(text("Blocking"), "task-2");
    const nodes = buildStream([call, inner]);
    expect(nodes).toHaveLength(1);
    const group = nodes[0] as GroupNode;
    expect(group.kind).toBe("group");
    expect(group.name).toBe("sca-director");
    expect(group.description).toBe("Block the scene");
    expect(group.state).toBe("started");
    expect(group.children).toHaveLength(1);
  });
});

describe("status words and figures", () => {
  it("names every status, and marks only running and waiting as live", () => {
    const statuses: AgentRunStatus[] = ["queued", "running", "waiting", "stopping", "stopped", "done", "failed"];
    for (const status of statuses) expect(STATUS_WORDS[status]).toBeTruthy();
    expect(statuses.filter(isLive)).toEqual(["running", "waiting"]);
    expect(statuses.filter(isOpen)).toEqual(["queued", "running", "waiting", "stopping"]);
    expect(pollInterval("running")).toBe(1500);
    expect(pollInterval("queued")).toBe(1500);
    expect(pollInterval("waiting")).toBe(4000);
    expect(pollInterval("done")).toBeNull();
  });

  it("formats cost, time and size as the header shows them", () => {
    expect(formatUsd(0)).toBe("$0");
    expect(formatUsd(0.0123)).toBe("$0.0123");
    expect(formatUsd(0.05)).toBe("$0.05");
    expect(formatUsd(0.1)).toBe("$0.10");
    expect(formatUsd(1.5)).toBe("$1.50");
    expect(formatDuration(12_000)).toBe("12s");
    expect(formatDuration(80_000)).toBe("1m 20s");
    expect(formatDuration(3_900_000)).toBe("1h 05m");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2_048)).toBe("2.0 KB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MB");
  });

  it("knows a tool by its name", () => {
    expect(toolGlyph("Bash")).toBe("bash");
    expect(toolGlyph("Edit")).toBe("file");
    expect(toolGlyph("Task")).toBe("task");
    expect(toolGlyph("WebFetch")).toBe("web");
    expect(toolGlyph("mcp__studio__publish")).toBe("studio");
    expect(toolGlyph("AskUserQuestion")).toBe("tool");
  });
});

describe("announcementFor", () => {
  it("reads a question or an approval before a status, and a status change otherwise", () => {
    const q = event(question("q1"));
    expect(announcementFor(run("running"), run("waiting"), [q])).toBe("Spring hooks asks: Hook");
    const a = event(approval("a1", "python3 kie.py watch --confirm-paid --max-new-jobs 2\n# more"));
    expect(announcementFor(run("running"), run("waiting"), [a])).toBe("Spring hooks needs an approval: python3 kie.py watch --confirm-paid --max-new-jobs 2");
    expect(announcementFor(run("running"), run("running"), [event({ kind: "error", message: "ffmpeg not found\nat …" })])).toBe(
      "Spring hooks — error: ffmpeg not found",
    );
    expect(announcementFor(run("running"), run("done"), [])).toBe("Spring hooks — Done");
    expect(announcementFor(run("running"), run("failed", { error: "worker lost" }), [])).toBe("Spring hooks — Failed: worker lost");
    expect(announcementFor(run("running"), run("running"), [event(text("more"))])).toBeNull();
    expect(announcementFor(null, run("running"), [])).toBeNull();
  });
});
