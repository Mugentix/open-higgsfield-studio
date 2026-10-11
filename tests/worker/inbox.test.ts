import { describe, expect, it } from "vitest";

import type { AgentInputPayload, AgentInputRecord } from "@/server/agents-contract";

import { PollingInbox } from "../../worker/inbox";

function record(payload: AgentInputPayload, by = "Ada"): AgentInputRecord {
  return { id: Math.random().toString(36).slice(2), runId: "run-1", createdBy: "u", createdByName: by, createdAt: Date.now(), consumedAt: null, payload };
}

describe("PollingInbox", () => {
  it("routes answers and approvals by id, even when they arrive before anyone waits", async () => {
    const inbox = new PollingInbox({ take: async () => [], intervalMs: 50 });
    inbox.accept([record({ kind: "answer", questionId: "q1", answers: { Which: "Pain" } }, "Bob"), record({ kind: "approval", approvalId: "a1", decision: "denied" })]);
    expect(await inbox.waitForAnswer("q1", new AbortController().signal)).toEqual({ answers: { Which: "Pain" }, by: "Bob" });
    expect(await inbox.waitForApproval("a1", new AbortController().signal)).toEqual({ decision: "denied", by: "Ada" });
    inbox.close();
  });

  it("hands unclaimed answers and decisions to nextMessage as stale gates, after any message", async () => {
    const inbox = new PollingInbox({ take: async () => [], intervalMs: 50 });
    const signal = new AbortController().signal;
    const waiting = inbox.nextMessage(signal);
    inbox.accept([record({ kind: "answer", questionId: "q1", answers: { Which: "Pain" } }, "Bob")]);
    expect(await waiting).toEqual({ kind: "gates", answers: [{ questionId: "q1", answers: { Which: "Pain" }, by: "Bob" }], approvals: [] });
    expect(inbox.drainGates()).toEqual({ kind: "gates", answers: [], approvals: [] });

    inbox.accept([record({ kind: "approval", approvalId: "a1", decision: "approved" }), record({ kind: "message", text: "hi", attachments: [] })]);
    expect(await inbox.nextMessage(signal)).toMatchObject({ kind: "message", text: "hi" });
    expect(inbox.drainGates()).toEqual({ kind: "gates", answers: [], approvals: [{ approvalId: "a1", decision: "approved", by: "Ada" }] });
    inbox.close();
  });

  it("a stop wins over a buffered answer that landed in the same poll", async () => {
    const inbox = new PollingInbox({ take: async () => [], intervalMs: 50 });
    inbox.accept([record({ kind: "answer", questionId: "q1", answers: { Which: "Pain" } }), record({ kind: "stop" })]);
    expect(await inbox.waitForAnswer("q1", new AbortController().signal)).toBeNull();
    expect(await inbox.waitForApproval("a1", new AbortController().signal)).toBeNull();
    inbox.close();
  });

  it("polls the store and wakes a waiter when a message lands", async () => {
    const queue: AgentInputRecord[][] = [[], [record({ kind: "message", text: "hi", attachments: [] })]];
    const inbox = new PollingInbox({ take: async () => queue.shift() ?? [], intervalMs: 10 }).start();
    const next = await inbox.nextMessage(new AbortController().signal);
    expect(next).toMatchObject({ kind: "message", text: "hi" });
    inbox.close();
  });

  it("a stop fires the listeners and resolves every wait with null", async () => {
    const inbox = new PollingInbox({ take: async () => [], intervalMs: 50 });
    let stopped = 0;
    inbox.onStop(() => stopped++);
    const waiting = inbox.waitForAnswer("q9", new AbortController().signal);
    inbox.accept([record({ kind: "stop" })]);
    expect(await waiting).toBeNull();
    expect(inbox.stopped).toBe(true);
    expect(stopped).toBe(1);
    inbox.onStop(() => stopped++);
    expect(stopped).toBe(2);
    expect(await inbox.nextMessage(new AbortController().signal)).toBeNull();
    inbox.close();
  });

  it("an aborted signal ends a wait with null", async () => {
    const inbox = new PollingInbox({ take: async () => [], intervalMs: 50 });
    const abort = new AbortController();
    const waiting = inbox.nextMessage(abort.signal);
    abort.abort();
    expect(await waiting).toBeNull();
    inbox.close();
  });

  it("reports a failing take through onError and keeps going", async () => {
    const errors: unknown[] = [];
    let calls = 0;
    const inbox = new PollingInbox({
      take: async () => {
        calls++;
        if (calls === 1) throw new Error("db away");
        return [record({ kind: "message", text: "back", attachments: [] })];
      },
      intervalMs: 5,
      onError: (error) => errors.push(error),
    }).start();
    expect(await inbox.nextMessage(new AbortController().signal)).toMatchObject({ text: "back" });
    expect(errors).toHaveLength(1);
    inbox.close();
  });
});
