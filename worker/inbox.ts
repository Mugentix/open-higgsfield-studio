import type { AgentInputRecord } from "@/server/agents-contract";

import type { AnswerInput, ApprovalInput, Inbox, MessageInput, StaleGates } from "./runtime";

/* People reach a run only through agent_inputs rows; the worker polls them.
   One poller per held run, running the whole time the run is held — a stop
   must land while the agent is mid-turn and nobody is waiting on anything.
   Answers and decisions are buffered by id, so one that arrives before the
   runtime asks for it (the row was written the moment the card appeared) is
   not lost. One that nobody ever asks for — the card belonged to a session
   that died — is handed out by nextMessage instead, as stale gates. A stop
   wins over anything buffered: a wait that races a stop answers null. */

export const INBOX_POLL_MS = 1_500;

export class PollingInbox implements Inbox {
  stopped = false;
  private closed = false;
  private readonly messages: MessageInput[] = [];
  private readonly answers = new Map<string, AnswerInput>();
  private readonly approvals = new Map<string, ApprovalInput>();
  private readonly waiters = new Set<() => void>();
  private readonly stopListeners = new Set<() => void>();
  private readonly take: () => Promise<AgentInputRecord[]>;
  private readonly intervalMs: number;
  private readonly onError: (error: unknown) => void;
  private sleeper: (() => void) | null = null;

  constructor(options: { take: () => Promise<AgentInputRecord[]>; intervalMs?: number; onError?: (error: unknown) => void }) {
    this.take = options.take;
    this.intervalMs = options.intervalMs ?? INBOX_POLL_MS;
    this.onError = options.onError ?? (() => undefined);
  }

  start(): this {
    void this.loop();
    return this;
  }

  close(): void {
    this.closed = true;
    this.sleeper?.();
    this.wake();
  }

  onStop(listener: () => void): () => void {
    if (this.stopped) listener();
    else this.stopListeners.add(listener);
    return () => void this.stopListeners.delete(listener);
  }

  async nextMessage(signal: AbortSignal): Promise<MessageInput | StaleGates | null> {
    for (;;) {
      if (this.stopped || this.closed || signal.aborted) return null;
      const next = this.messages.shift();
      if (next) return next;
      if (this.answers.size > 0 || this.approvals.size > 0) return this.drainGates();
      await this.changed(signal);
    }
  }

  drainGates(): StaleGates {
    const answers = [...this.answers].map(([questionId, answer]) => ({ questionId, ...answer }));
    const approvals = [...this.approvals].map(([approvalId, approval]) => ({ approvalId, ...approval }));
    this.answers.clear();
    this.approvals.clear();
    return { kind: "gates", answers, approvals };
  }

  async waitForAnswer(questionId: string, signal: AbortSignal): Promise<AnswerInput | null> {
    for (;;) {
      if (this.stopped || this.closed || signal.aborted) return null;
      const answer = this.answers.get(questionId);
      if (answer) {
        this.answers.delete(questionId);
        return answer;
      }
      await this.changed(signal);
    }
  }

  async waitForApproval(approvalId: string, signal: AbortSignal): Promise<ApprovalInput | null> {
    for (;;) {
      if (this.stopped || this.closed || signal.aborted) return null;
      const approval = this.approvals.get(approvalId);
      if (approval) {
        this.approvals.delete(approvalId);
        return approval;
      }
      await this.changed(signal);
    }
  }

  /** Feeds records straight in; the poller uses it, and so can a test. */
  accept(records: AgentInputRecord[]): void {
    for (const record of records) {
      const by = record.createdByName ?? null;
      switch (record.payload.kind) {
        case "message":
          this.messages.push({ ...record.payload, record });
          break;
        case "answer":
          this.answers.set(record.payload.questionId, { answers: record.payload.answers, by });
          break;
        case "approval":
          this.approvals.set(record.payload.approvalId, { decision: record.payload.decision, by });
          break;
        case "stop":
          if (!this.stopped) {
            this.stopped = true;
            for (const listener of this.stopListeners) listener();
            this.stopListeners.clear();
          }
          break;
      }
    }
    if (records.length > 0) this.wake();
  }

  /** One poll now, outside the loop's rhythm. */
  async poll(): Promise<void> {
    try {
      this.accept(await this.take());
    } catch (caught) {
      this.onError(caught);
    }
  }

  private async loop(): Promise<void> {
    while (!this.closed) {
      await this.poll();
      if (this.closed) break;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          this.sleeper = null;
          resolve();
        }, this.intervalMs);
        this.sleeper = () => {
          clearTimeout(timer);
          this.sleeper = null;
          resolve();
        };
      });
    }
  }

  private wake(): void {
    for (const waiter of this.waiters) waiter();
    this.waiters.clear();
  }

  private changed(signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        this.waiters.delete(done);
        signal.removeEventListener("abort", done);
        resolve();
      };
      this.waiters.add(done);
      signal.addEventListener("abort", done, { once: true });
    });
  }
}
