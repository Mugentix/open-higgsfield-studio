import * as core from "@/server/agents";
import type { AgentEventPayload, AgentRunRecord } from "@/server/agents-contract";
import type { TeamContext } from "@/server/team";

import type { ArtifactDraft, TerminalStatus, WorkerStore } from "./store";

/* The WorkerStore over the real core. This is the one worker file that
   imports src/server/agents.ts; everything else speaks the interface, so
   drift between the two shows up here and nowhere else — and the worker
   touches no table on its own.

   The core's team-scoped reads take the team a session resolved; the worker
   has no session, only the run's team id, and passes a scope that carries
   just that. */

function scopeOf(teamId: string): Pick<TeamContext, "teamId"> {
  return { teamId };
}

export function coreStore(): WorkerStore {
  return {
    async reclaimStale() {
      await core.reclaimStale();
    },
    claimRun: (workerId) => core.claimRun(workerId),
    renewLease: (runId, workerId) => core.renewLease(runId, workerId),
    getSkill: (teamId, skillId) => core.getSkill(scopeOf(teamId), skillId),
    runContext: (run) => core.runPlace(run),
    runAttachments: (runId) => core.runAttachments(runId),
    markStarted: (runId, workspace) => core.setRunWorkspace(runId, workspace),
    appendEvent: (runId, payload: AgentEventPayload, parentToolUseId, workerId) => core.appendEvent(runId, payload, parentToolUseId, workerId),
    takeInputs: (runId, workerId) => core.takeInputs(runId, workerId),
    async settleQuestion(runId, questionId, answers, by) {
      await core.settleQuestion(runId, questionId, answers, by);
    },
    async settleApproval(runId, approvalId, decision, by) {
      await core.settleApproval(runId, approvalId, decision, by);
    },
    recordArtifact: (run: AgentRunRecord, draft: ArtifactDraft, workerId) => core.recordArtifact(run.id, draft, workerId),
    async publishArtifact(run, artifactId) {
      const published = await core.publishArtifact(scopeOf(run.teamId), artifactId, { id: run.createdBy, name: run.createdByName });
      return { resultId: published.resultId, url: published.url };
    },
    addCredits: (runId, credits) => core.addCredits(runId, credits),
    async finishRun(runId, status: TerminalStatus, error, workerId) {
      await core.finishRun(runId, status, error, workerId);
    },
  };
}
