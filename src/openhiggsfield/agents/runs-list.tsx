"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { listAgentRuns } from "@/server/agent-actions";
import type { AgentRunRecord } from "@/server/agents-contract";
import type { Workspace } from "@/server/project-actions";

import { AgentIcon } from "../icons";
import { bounceIfSignedOut, projectLabel, whenLabel } from "./client";
import { formatUsd, isLive } from "./events";
import { StatusPill } from "./status-pill";

/* Every run of the team, newest first, kept fresh on the wall's own cadence.
   The project filter starts on the sidebar's project — the one the visitor
   is working — and follows it; "All projects" is one pick away. */

export const RUNS_POLL_MS = 4000;

type Filter = string | "all";

export function RunsList({
  workspace,
  projectId,
  onBusy,
  onNew,
}: {
  workspace: Workspace | null;
  projectId: string | null;
  onBusy: (busy: boolean) => void;
  /** The empty state's one press, when the team has a skill to run. */
  onNew: (() => void) | null;
}) {
  const [filter, setFilter] = useState<Filter>(projectId ?? "all");
  const [runs, setRuns] = useState<AgentRunRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (projectId) setFilter(projectId);
  }, [projectId]);

  /* The first read happens whatever the tab's visibility — a background
     tab still deserves its list — and only the polling waits for a visible
     page. */
  const unread = useRef(true);
  useEffect(() => {
    unread.current = true;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      if (!live) return;
      if (unread.current || document.visibilityState === "visible") {
        unread.current = false;
        const result = await listAgentRuns(filter === "all" ? {} : { projectId: filter });
        if (!live) return;
        if (result.ok) {
          setRuns(result.data);
          setError(null);
        } else {
          bounceIfSignedOut(result.code);
          setError(result.error);
        }
      }
      if (live) timer = setTimeout(() => void tick(), RUNS_POLL_MS);
    };
    void tick();
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [filter]);

  const busy = runs?.some((run) => isLive(run.status)) ?? false;
  useEffect(() => {
    onBusy(busy);
    return () => onBusy(false);
  }, [busy, onBusy]);

  return (
    <div className="ohf-runs-panel">
      <div className="ohf-runs-bar">
        <label className="ohf-agents-filter">
          <span className="ohf-field-label">Project</span>
          <select className="ohf-tpl-select ohf-agents-select" value={filter} onChange={(event) => setFilter(event.target.value)}>
            <option value="all">All projects</option>
            {workspace?.products.map((product) => (
              <optgroup key={product.id} label={product.name}>
                {product.projects
                  .filter((project) => project.status === "active")
                  .map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))}
              </optgroup>
            ))}
          </select>
        </label>
        <span className="ohf-runs-count" role="status">
          {runs === null ? "" : `${runs.length} ${runs.length === 1 ? "run" : "runs"}`}
        </span>
      </div>

      {error && (
        <div className="ohf-alert" role="alert">
          <span className="ohf-alert-text">{error}</span>
        </div>
      )}

      {runs === null && !error && <p className="ohf-ev-dim">Loading…</p>}

      {runs?.length === 0 && (
        <div className="ohf-agents-empty">
          <span className="ohf-picker-empty-ic">
            <AgentIcon size={15} />
          </span>
          <span className="ohf-picker-empty-title">{filter === "all" ? "No runs yet" : "No runs in this project yet"}</span>
          <span className="ohf-picker-empty-hint">
            A run hands a brief to one of the team&apos;s skills and lets it work — asking before it spends, publishing what it makes.
          </span>
          {onNew ? (
            <button type="button" className="ohf-btn-accent" onClick={onNew}>
              New run
            </button>
          ) : (
            <span className="ohf-picker-empty-hint">Upload a skill first, under Skills.</span>
          )}
        </div>
      )}

      {runs && runs.length > 0 && (
        <ul className="ohf-runs" aria-label="Runs">
          {runs.map((run) => (
            <li key={run.id} className="ohf-run-row" data-live={isLive(run.status)}>
              <Link href={`/agents/${run.id}`} className="ohf-run-main">
                <span className="ohf-run-title">{run.title}</span>
                <span className="ohf-run-sub">
                  {run.skillName} · {projectLabel(workspace, run.projectId)}
                </span>
              </Link>
              <StatusPill status={run.status} />
              <span className="ohf-run-cost" title="What the model loop has cost">
                {formatUsd(run.costUsd)}
              </span>
              <span className="ohf-run-when">{whenLabel(run.startedAt ?? run.createdAt)}</span>
              <span className="ohf-run-who" title={run.createdByName ?? undefined}>
                {run.createdByName ?? "—"}
              </span>
              <Link href={`/agents/${run.id}`} className="ohf-btn-quiet ohf-run-open" aria-label={`${run.status === "waiting" ? "Resume" : "Open"} ${run.title}`}>
                {run.status === "waiting" ? "Resume" : "Open"}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
