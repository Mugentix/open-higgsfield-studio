import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { crc32, deflateSync } from "node:zlib";

import { commandHeadline, paidGate } from "../gates";
import type { AgentRuntime, RuntimeOutcome, RuntimeSession } from "../runtime";

/* A scripted agent. It walks the same path a real session walks — prose,
   a tool call that writes a file, a question, an approval for a paid
   command, deliverables, a result — without a model or a key, so the loop,
   the inbox, the artifact scan and the studio's run view can be exercised
   end to end (AGENT_RUNTIME=fake) and pinned by tests. Deterministic: the
   same inputs give the same events and the same files. */

export const FAKE_QUESTION_ID = "fake-q1";
export const FAKE_APPROVAL_ID = "fake-a1";
export const FAKE_PAID_COMMAND = "python3 scripts/kie.py watch --confirm-paid --max-new-jobs 2";
export const FAKE_COST_USD = 0.0123;
export const FAKE_CREDITS = 12;

export class FakeRuntime implements AgentRuntime {
  readonly name = "fake";

  async start(session: RuntimeSession): Promise<RuntimeOutcome> {
    const { run, emit, inbox, signal } = session;
    const sessionId = run.sessionId ?? `fake-${run.id}`;

    if (run.sessionId) return this.resumed(session, sessionId);

    await emit({ kind: "text", text: `Reading the brief for **${run.title}**`, final: false });
    await emit({
      kind: "text",
      text: `I read the brief for **${run.title}**. Plan:\n\n1. Write the plan to \`outputs/plan.md\`\n2. Ask which direction the first batch takes\n3. Submit the batch (needs an approval, it spends credits)\n4. Put the board together`,
      final: true,
    });

    const planCommand = `cat > outputs/plan.md <<'EOF'\n# Plan for ${run.title}\n\n${run.brief.split("\n")[0] ?? ""}\nEOF`;
    await emit({ kind: "tool_use", toolUseId: "fake-t1", name: "Bash", summary: commandHeadline(planCommand), input: { command: planCommand } });
    await mkdir(session.workspace.outputsDir, { recursive: true });
    await writeFile(path.join(session.workspace.outputsDir, "plan.md"), `# Plan for ${run.title}\n\n${run.brief}\n`);
    await emit({ kind: "tool_result", toolUseId: "fake-t1", output: "", isError: false, truncated: false });

    await emit({
      kind: "question",
      questionId: FAKE_QUESTION_ID,
      questions: [
        {
          question: "Which direction should the first batch take?",
          header: "Direction",
          options: [
            { label: "Go wide", description: "Three angles, one take each" },
            { label: "Go deep", description: "One angle, three takes" },
          ],
          multiSelect: false,
        },
      ],
      answers: null,
      answeredBy: null,
    });
    await emit({ kind: "status", status: "waiting", reason: null });
    const answer = await inbox.waitForAnswer(FAKE_QUESTION_ID, signal);
    if (!answer) return halted(session);
    await session.studio.settleQuestion(FAKE_QUESTION_ID, answer.answers, answer.by);
    await emit({ kind: "status", status: "running", reason: null });
    const direction = String(Object.values(answer.answers)[0] ?? "Go wide");
    await emit({ kind: "text", text: `Going with **${direction}**. The next step submits KIE jobs, so I need an approval.`, final: true });

    const gate = paidGate(FAKE_PAID_COMMAND);
    await emit({ kind: "tool_use", toolUseId: "fake-t2", name: "Bash", summary: commandHeadline(FAKE_PAID_COMMAND), input: { command: FAKE_PAID_COMMAND } });
    await emit({
      kind: "approval",
      approvalId: FAKE_APPROVAL_ID,
      toolName: "Bash",
      command: FAKE_PAID_COMMAND,
      reason: gate?.reason ?? "paid",
      decision: null,
      decidedBy: null,
    });
    await emit({ kind: "status", status: "waiting", reason: null });
    const approval = await inbox.waitForApproval(FAKE_APPROVAL_ID, signal);
    if (!approval) return halted(session);
    await session.studio.settleApproval(FAKE_APPROVAL_ID, approval.decision, approval.by);
    await emit({ kind: "status", status: "running", reason: null });

    if (approval.decision === "approved") {
      await emit({ kind: "tool_result", toolUseId: "fake-t2", output: "submitted 2 jobs\nboth succeeded (12 credits)", isError: false, truncated: false });
      await writeFile(path.join(session.workspace.outputsDir, "board.png"), png1x1());
      await writeFile(path.join(session.workspace.outputsDir, "board.md"), `# Board\n\nDirection: ${direction}\n\n- take 1: board.png\n`);
      await session.studio.reportCredits(FAKE_CREDITS);
      await session.studio.publish("outputs/board.png", "Board");
      await emit({ kind: "text", text: "Batch done. The board is on the wall and under `outputs/`.", final: true });
    } else {
      await emit({ kind: "tool_result", toolUseId: "fake-t2", output: "Declined in the studio", isError: true, truncated: false });
      await emit({ kind: "text", text: "Understood; nothing was spent. The plan stays in `outputs/plan.md`.", final: true });
    }

    await session.afterTurn();
    await emit({ kind: "result", subtype: "success", costUsd: FAKE_COST_USD, turns: 6, durationMs: 1234, sessionId });
    return { status: "done", error: null };
  }

  /** A run handed over after a worker restart: wait for a word — or for the
      team's reply to a card the dead session left open — and answer it. */
  private async resumed(session: RuntimeSession, sessionId: string): Promise<RuntimeOutcome> {
    await session.emit({ kind: "status", status: "waiting", reason: "resumed after a worker restart; answer the open card or send a message to continue" });
    const next = await session.inbox.nextMessage(session.signal);
    if (!next) return halted(session);
    await session.emit({ kind: "status", status: "running", reason: null });
    const heard =
      next.kind === "message"
        ? `You said: ${next.text.slice(0, 200)}`
        : `While I was away the team settled: ${[
            ...next.answers.map((answer) => Object.values(answer.answers).flat().join(", ")),
            ...next.approvals.map((approval) => approval.decision),
          ].join("; ")}`;
    await session.emit({ kind: "text", text: `Picking up where we were. ${heard}`, final: true });
    await session.afterTurn();
    await session.emit({ kind: "result", subtype: "success", costUsd: 0.001, turns: 1, durationMs: 100, sessionId });
    return { status: "done", error: null };
  }
}

function halted(session: RuntimeSession): RuntimeOutcome {
  return session.signal.aborted && !session.inbox.stopped ? { status: "released" } : { status: "stopped", error: null };
}

/** A valid 1×1 PNG, one lime pixel: the smallest image a gallery renders. */
export function png1x1(): Uint8Array {
  const chunk = (type: string, data: Uint8Array) => {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(data.byteLength);
    const typed = Buffer.concat([Buffer.from(type, "ascii"), Buffer.from(data)]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typed) >>> 0);
    return Buffer.concat([head, typed, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const idat = deflateSync(Buffer.from([0, 0xd1, 0xfe, 0x17]));
  return new Uint8Array(
    Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", new Uint8Array())]),
  );
}
