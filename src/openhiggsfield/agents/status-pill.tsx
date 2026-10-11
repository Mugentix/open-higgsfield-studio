"use client";

import type { AgentRunStatus } from "@/server/agents-contract";

import { STATUS_WORDS, isLive } from "./events";

/* One word for where a run stands. The accent marks liveness alone — the
   agent at work, or waiting on a person — and the dot pulses only while it
   is actually working; queued, stopping and the past read in grey. */
export function StatusPill({ status }: { status: AgentRunStatus }) {
  const live = isLive(status);
  return (
    <span className="ohf-agent-status" data-status={status} data-live={live}>
      {live && <span className="ohf-agent-status-dot" aria-hidden />}
      {STATUS_WORDS[status]}
    </span>
  );
}
