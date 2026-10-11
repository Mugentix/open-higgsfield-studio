"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";

import type { SkillRecord } from "@/server/agents-contract";
import type { Workspace } from "@/server/project-actions";
import { listSkills } from "@/server/skill-actions";
import type { Role } from "@/server/team";

import { bounceIfSignedOut } from "./client";
import { NewRun } from "./new-run";
import { RunsList } from "./runs-list";
import { SkillsPanel } from "./skills-panel";

/* /agents: the team's runs, a new one, and the skills they run on, as three
   tabs under one heading. The list is where a visitor lands; the empty
   state and the tab both lead to a new run; a started run opens on its own
   page. */

type Tab = "runs" | "new" | "skills";

const TABS: readonly { id: Tab; label: string }[] = [
  { id: "runs", label: "Runs" },
  { id: "new", label: "New run" },
  { id: "skills", label: "Skills" },
];

export function AgentsIndex({
  role,
  workspace,
  projectId,
  announce,
  onBusy,
}: {
  role: Role;
  workspace: Workspace | null;
  projectId: string | null;
  announce: (line: string | null) => void;
  onBusy: (busy: boolean) => void;
}) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("runs");
  const [skills, setSkills] = useState<SkillRecord[] | null>(null);
  const [skillsError, setSkillsError] = useState<string | null>(null);
  const tabsRef = useRef<HTMLDivElement>(null);

  const loadSkills = useCallback(async () => {
    const result = await listSkills();
    if (!result.ok) {
      bounceIfSignedOut(result.code);
      setSkillsError(result.error);
      return;
    }
    setSkills(result.data);
    setSkillsError(null);
  }, []);
  useEffect(() => {
    void loadSkills();
  }, [loadSkills]);

  const ready = (skills ?? []).filter((skill) => skill.status === "ready");
  const canManage = role !== "member";

  const onTabKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const from = TABS.findIndex((entry) => entry.id === tab);
    const to = event.key === "ArrowRight" ? (from + 1) % TABS.length : event.key === "ArrowLeft" ? (from - 1 + TABS.length) % TABS.length : -1;
    if (to < 0) return;
    event.preventDefault();
    setTab(TABS[to]!.id);
    tabsRef.current?.querySelectorAll<HTMLElement>('[role="tab"]')[to]?.focus();
  };

  return (
    <>
      <header className="ohf-agents-top">
        <h1 className="ohf-agents-title">Agents</h1>
        <div ref={tabsRef} className="ohf-assets-tabs ohf-agents-tabs" role="tablist" aria-label="Agents" onKeyDown={onTabKeyDown}>
          {TABS.map((entry) => {
            const active = entry.id === tab;
            const count = entry.id === "skills" ? skills?.length : undefined;
            return (
              <button
                key={entry.id}
                id={`ohf-agents-tab-${entry.id}`}
                type="button"
                role="tab"
                aria-selected={active}
                aria-controls="ohf-agents-panel"
                tabIndex={active ? 0 : -1}
                className="ohf-assets-tab"
                onClick={() => setTab(entry.id)}
              >
                {entry.label}
                {count !== undefined && <span className="ohf-assets-tab-count">{count}</span>}
              </button>
            );
          })}
        </div>
      </header>
      <div id="ohf-agents-panel" className="ohf-agents-body ohf-scroll" role="tabpanel" aria-labelledby={`ohf-agents-tab-${tab}`}>
        {tab === "runs" && (
          <RunsList workspace={workspace} projectId={projectId} onBusy={onBusy} onNew={ready.length > 0 ? () => setTab("new") : null} />
        )}
        {tab === "new" && (
          <NewRun
            skills={ready}
            workspace={workspace}
            projectId={projectId}
            onStarted={(run) => {
              announce(`${run.title} queued`);
              router.push(`/agents/${run.id}`);
            }}
            onCancel={() => setTab("runs")}
          />
        )}
        {tab === "skills" && (
          <SkillsPanel skills={skills} error={skillsError} canManage={canManage} onChanged={() => void loadSkills()} announce={announce} />
        )}
      </div>
    </>
  );
}
