import { query, type Options, type PermissionResult, type SDKResultMessage, type Settings } from "@anthropic-ai/claude-agent-sdk";
import path from "node:path";

import { EventMapper, readQuestions, turnOutcome, type TurnOutcome } from "../events";
import { paidGate } from "../gates";
import type { TeamHome, Workspace } from "../home";
import type { AgentRuntime, MessageInput, RuntimeOutcome, RuntimeSession, StaleGates } from "../runtime";
import { createStudioServer } from "../studio-tools";

/* The real thing: Claude Code through the Agent SDK, one `query` per turn.
   Turn one is `/<slug> <brief>`; every later message from a person resumes
   the session by id. Permissions stay in "default" mode and every ask lands
   in `canUseTool`: a question goes to the team as a `question` event, a
   paid command as an `approval`, and the turn waits on the inbox for the
   answer. Bash is left out of allowedTools and pinned to `ask` in the
   policy tier (`managedSettings`), which user and project settings files
   cannot widen — so a settings.json the agent writes into its own HOME
   changes nothing, and every command reaches the gate. The file-writing
   tools come through `canUseTool` too, so a write under either .claude/
   (settings, hooks, agents, the installed skills) is refused; everything
   else is allowed up front or on sight. */

export const DEFAULT_MAX_TURNS = 400;

/** The tools that write files; they are allowed on sight except under .claude/. */
export const EDIT_TOOLS = ["Write", "Edit", "MultiEdit", "NotebookEdit"];

/** Tools that never prompt. Bash, AskUserQuestion and the EDIT_TOOLS are
    absent on purpose: canUseTool sees them. */
export const ALLOWED_TOOLS = [
  "Read",
  "Glob",
  "Grep",
  "LS",
  "WebFetch",
  "WebSearch",
  "TodoWrite",
  "Task",
  "Agent",
  "TaskOutput",
  "BashOutput",
  "KillShell",
  "mcp__studio__publish",
  "mcp__studio__note",
  "mcp__studio__report_credits",
];

export type ClaudeRuntimeOptions = {
  model?: string;
  fallbackModel?: string;
  maxTurns?: number;
  maxThinkingTokens?: number;
  pathToClaudeCodeExecutable?: string;
};

type TurnResult = { kind: "ended"; outcome: TurnOutcome } | { kind: "stopped" } | { kind: "released" } | { kind: "failed"; error: string };

export class ClaudeRuntime implements AgentRuntime {
  readonly name = "claude";

  constructor(private readonly options: ClaudeRuntimeOptions = {}) {}

  async start(session: RuntimeSession): Promise<RuntimeOutcome> {
    const missing = missingAuth(session.env);
    if (missing) {
      await session.emit({ kind: "error", message: missing });
      return { status: "failed", error: missing };
    }
    const mapper = new EventMapper(session.mask, { chargedUsd: session.run.costUsd });
    const studio = createStudioServer(session.studio);
    let sessionId = session.run.sessionId;
    let prompt: string | null = sessionId ? null : session.prompt;
    if (sessionId) {
      await session.emit({ kind: "status", status: "waiting", reason: "resumed after a worker restart; answer the open card or send a message to continue" });
    }

    for (;;) {
      if (prompt === null) {
        /* A message, or the answers to cards of the session that died before
           reading them; a message may carry such answers along with it. */
        const next = await session.inbox.nextMessage(session.signal);
        if (!next) return halted(session);
        const message = next.kind === "message" ? await promptFor(session, next) : null;
        const stale = next.kind === "gates" ? next : session.inbox.drainGates();
        prompt = [message, staleGatesPrompt(stale)].filter((part): part is string => part !== null).join("\n\n");
        await session.emit({ kind: "status", status: "running", reason: null });
      }
      const turn = await this.turn(session, mapper, studio, prompt, sessionId);
      sessionId = mapper.sessionId ?? sessionId;
      if (turn.kind === "released") return { status: "released" };
      if (turn.kind === "stopped") return { status: "stopped", error: null };
      if (turn.kind === "failed") return { status: "failed", error: turn.error };
      await session.afterTurn();
      if (turn.outcome.status === "done") return { status: "done", error: null };
      if (turn.outcome.status === "failed") return { status: "failed", error: turn.outcome.reason };
      await session.emit({ kind: "status", status: "waiting", reason: turn.outcome.reason });
      prompt = null;
    }
  }

  private async turn(
    session: RuntimeSession,
    mapper: EventMapper,
    studio: ReturnType<typeof createStudioServer>,
    prompt: string,
    resume: string | null,
  ): Promise<TurnResult> {
    mapper.beginTurn();
    const abort = new AbortController();
    const options: Options = {
      cwd: session.workspace.dir,
      env: session.env,
      settingSources: ["user", "project"],
      managedSettings: managedSettingsFor(session.home, session.workspace),
      skills: [session.skill.slug],
      allowedTools: ALLOWED_TOOLS,
      permissionMode: "default",
      canUseTool: (toolName, input, context) => this.permission(session, toolName, input, context.toolUseID, context.signal),
      includePartialMessages: true,
      forwardSubagentText: true,
      systemPrompt: { type: "preset", preset: "claude_code", append: session.systemAppend, snapshot: true },
      mcpServers: { studio },
      maxTurns: this.options.maxTurns ?? DEFAULT_MAX_TURNS,
      abortController: abort,
      stderr: (data) => session.log.debug("claude stderr", { data: data.slice(0, 500) }),
      ...(this.options.model ? { model: this.options.model } : {}),
      ...(this.options.fallbackModel ? { fallbackModel: this.options.fallbackModel } : {}),
      ...(this.options.maxThinkingTokens ? { maxThinkingTokens: this.options.maxThinkingTokens } : {}),
      ...(this.options.pathToClaudeCodeExecutable ? { pathToClaudeCodeExecutable: this.options.pathToClaudeCodeExecutable } : {}),
      ...(resume ? { resume } : {}),
    };

    const q = query({ prompt, options });
    const interrupt = () => {
      q.interrupt().catch((caught: unknown) => {
        session.log.warn("interrupt failed; aborting the session", { error: caught });
        abort.abort();
      });
    };
    const unsubscribeStop = session.inbox.onStop(interrupt);
    const onShutdown = () => interrupt();
    session.signal.addEventListener("abort", onShutdown, { once: true });

    let result: SDKResultMessage | null = null;
    try {
      for await (const message of q) {
        for (const mapped of mapper.map(message)) await session.emit(mapped.payload, mapped.parentToolUseId);
        if (message.type === "result") result = message;
      }
    } catch (caught) {
      if (session.inbox.stopped) return { kind: "stopped" };
      if (session.signal.aborted) return { kind: "released" };
      const error = session.mask.text(caught instanceof Error ? caught.message : String(caught));
      await session.emit({ kind: "error", message: error });
      return { kind: "failed", error };
    } finally {
      unsubscribeStop();
      session.signal.removeEventListener("abort", onShutdown);
    }
    if (session.inbox.stopped) return { kind: "stopped" };
    if (session.signal.aborted) return { kind: "released" };
    if (!result) {
      const error = "The session ended without a result";
      await session.emit({ kind: "error", message: error });
      return { kind: "failed", error };
    }
    return { kind: "ended", outcome: turnOutcome(result, mapper.lastText) };
  }

  /** Every ask Claude Code would put to a person. */
  private async permission(
    session: RuntimeSession,
    toolName: string,
    input: Record<string, unknown>,
    toolUseId: string,
    toolSignal: AbortSignal,
  ): Promise<PermissionResult> {
    const signal = AbortSignal.any([toolSignal, session.signal]);
    const refused = refusedWrite(session.home, session.workspace, toolName, input);
    if (refused) return { behavior: "deny", message: refused };
    if (toolName === "AskUserQuestion") {
      const questionId = toolUseId;
      await session.emit({ kind: "question", questionId, questions: readQuestions(input), answers: null, answeredBy: null });
      await session.emit({ kind: "status", status: "waiting", reason: null });
      const answer = await session.inbox.waitForAnswer(questionId, signal);
      if (!answer) return { behavior: "deny", message: "The run was stopped", interrupt: true };
      await session.studio.settleQuestion(questionId, answer.answers, answer.by);
      await session.emit({ kind: "status", status: "running", reason: null });
      return { behavior: "allow", updatedInput: { ...input, questions: input.questions, answers: answer.answers } };
    }
    if (toolName === "Bash") {
      const command = typeof input.command === "string" ? input.command : "";
      const gate = paidGate(command);
      if (gate) {
        const approvalId = toolUseId;
        await session.emit({
          kind: "approval",
          approvalId,
          toolName,
          command: session.mask.text(command),
          reason: gate.reason,
          decision: null,
          decidedBy: null,
        });
        await session.emit({ kind: "status", status: "waiting", reason: null });
        const approval = await session.inbox.waitForApproval(approvalId, signal);
        if (!approval) return { behavior: "deny", message: "The run was stopped", interrupt: true };
        await session.studio.settleApproval(approvalId, approval.decision, approval.by);
        await session.emit({ kind: "status", status: "running", reason: null });
        return approval.decision === "approved"
          ? { behavior: "allow", updatedInput: input }
          : { behavior: "deny", message: "Declined in the studio" };
      }
    }
    return { behavior: "allow", updatedInput: input };
  }
}

/** The SDK takes an Anthropic key or one of the cloud switches; without any
    of them the first turn would die inside the subprocess with a message no
    person sees. Said here instead, as the run's error. */
export function missingAuth(env: Record<string, string | undefined>): string | null {
  if (env.ANTHROPIC_API_KEY?.trim()) return null;
  if (env.CLAUDE_CODE_USE_BEDROCK === "1" || env.CLAUDE_CODE_USE_VERTEX === "1" || env.CLAUDE_CODE_USE_FOUNDRY === "1") return null;
  if (env.ANTHROPIC_AUTH_TOKEN?.trim()) return null;
  return "The worker has no ANTHROPIC_API_KEY; set it in the worker's environment and start the run again";
}

/** The policy tier for every query. User and project settings files cannot
    widen it, so nothing the agent writes into its HOME's .claude/ changes
    what runs: Bash always asks (and so reaches the gate), the file tools may
    not write under either .claude/, and hooks come from managed settings
    alone — of which there are none. Rules name absolute paths (`//…`). */
export function managedSettingsFor(home: Pick<TeamHome, "claudeDir">, workspace: Pick<Workspace, "dir">): Settings {
  const guarded = [home.claudeDir, path.join(workspace.dir, ".claude")];
  return {
    permissions: {
      ask: ["Bash"],
      deny: guarded.flatMap((dir) => EDIT_TOOLS.map((tool) => `${tool}(/${dir}/**)`)),
    },
    allowManagedHooksOnly: true,
  };
}

/** Why a file tool's write is refused, or null. The agent may not touch its
    HOME's .claude/ (settings, hooks, agents, the installed skills) or the
    workspace's; both are the studio's. Paths resolve against the workspace,
    as the tools resolve them, and `~` is the team's HOME. */
export function refusedWrite(home: Pick<TeamHome, "dir" | "claudeDir">, workspace: Pick<Workspace, "dir">, toolName: string, input: Record<string, unknown>): string | null {
  if (!EDIT_TOOLS.includes(toolName)) return null;
  const named = input.file_path ?? input.notebook_path;
  if (typeof named !== "string" || !named) return null;
  const expanded = named === "~" || named.startsWith("~/") ? path.join(home.dir, named.slice(1)) : named;
  const target = path.resolve(workspace.dir, expanded);
  for (const dir of [home.claudeDir, path.join(workspace.dir, ".claude")]) {
    if (target === dir || target.startsWith(dir + path.sep)) {
      return `Writing under ${dir} is not allowed: Claude Code's settings, hooks, agents and the installed skills live there and belong to the studio`;
    }
  }
  return null;
}

/** A person's message as the next turn's prompt; attachments were fetched
    into inputs/ and are named by path so the agent can open them. */
export async function promptFor(session: RuntimeSession, message: MessageInput): Promise<string> {
  const files = message.attachments.length > 0 ? await session.fetchAttachments(message.attachments) : [];
  if (files.length === 0) return message.text;
  return `${message.text}\n\nAttached files (in the working directory):\n${files.map((file) => `- ./${file}`).join("\n")}`;
}

/** The team's replies to cards of a session that died before reading them,
    as words for the resumed session; null when there are none. The tool
    calls behind those cards are gone, so an approved command did not run. */
export function staleGatesPrompt(gates: StaleGates): string | null {
  const lines: string[] = [];
  for (const answer of gates.answers) {
    const given = Object.entries(answer.answers)
      .map(([question, value]) => `${question} → ${Array.isArray(value) ? value.join(", ") : value}`)
      .join("; ");
    lines.push(`- Answered${answer.by ? ` by ${answer.by}` : ""}: ${given}`);
  }
  for (const approval of gates.approvals) {
    const verdict = approval.decision === "approved" ? "Approved" : "Declined";
    lines.push(
      `- ${verdict}${approval.by ? ` by ${approval.by}` : ""} the command that was held for approval. It did not run: the session was restarted while it waited. If the step is still needed, run it again and the studio will hold it for approval once more.`,
    );
  }
  if (lines.length === 0) return null;
  return `The session was resumed after a worker restart. The team has since replied to what you asked before it:\n${lines.join("\n")}\n\nContinue from there.`;
}

function halted(session: RuntimeSession): RuntimeOutcome {
  return session.signal.aborted && !session.inbox.stopped ? { status: "released" } : { status: "stopped", error: null };
}
