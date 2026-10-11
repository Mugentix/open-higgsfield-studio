"use client";

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";

import { createAgentRun } from "@/server/agent-actions";
import { BRIEF_MAX_CHARS, type AgentRunRecord, type SkillRecord } from "@/server/agents-contract";
import type { Workspace } from "@/server/project-actions";

import { CheckIcon } from "../icons";
import { AttachmentField } from "./attachments";
import { bounceIfSignedOut } from "./client";

const DAY = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });

/* Starting a run: which skill, which project it lands in, a title, the brief
   the skill reads as its first message, and files from the library for its
   inputs/ folder. Cmd/Ctrl+Enter in the brief starts it, as the composer
   generates. */
export function NewRun({
  skills,
  workspace,
  projectId,
  onStarted,
  onCancel,
}: {
  /** The skills that can run — the invalid ones never reach this form. */
  skills: SkillRecord[];
  workspace: Workspace | null;
  /** The sidebar's project: where the run lands unless another is picked. */
  projectId: string | null;
  onStarted: (run: AgentRunRecord) => void;
  onCancel: () => void;
}) {
  const [skillId, setSkillId] = useState<string | null>(skills.length === 1 ? skills[0]!.id : null);
  const [project, setProject] = useState<string>(projectId ?? "");
  const [title, setTitle] = useState("");
  const [brief, setBrief] = useState("");
  const [attachments, setAttachments] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const groupRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!project && projectId) setProject(projectId);
  }, [projectId, project]);

  const skill = skills.find((entry) => entry.id === skillId) ?? null;
  const ready = skill !== null && project !== "" && brief.trim().length > 0 && brief.length <= BRIEF_MAX_CHARS && !busy;

  /* The skill cards are one radio group: the arrows walk them, Space and
     Enter pick, as the APG radio pattern has it. */
  const onCardsKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = skills.findIndex((entry) => entry.id === (event.target as HTMLElement).dataset.skill);
    if (index < 0) return;
    const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const next = skills[(index + step + skills.length) % skills.length]!;
    setSkillId(next.id);
    groupRef.current?.querySelector<HTMLElement>(`[data-skill="${next.id}"]`)?.focus();
  };

  async function start(event?: FormEvent) {
    event?.preventDefault();
    if (!ready || !skill) return;
    setBusy(true);
    setError(null);
    const result = await createAgentRun({
      skillId: skill.id,
      projectId: project,
      title: title.trim() || `${skill.name} · ${DAY.format(new Date())}`,
      brief: brief.trim(),
      attachmentAssetIds: attachments,
    });
    setBusy(false);
    if (!result.ok) {
      bounceIfSignedOut(result.code);
      setError(result.error);
      return;
    }
    onStarted(result.data);
  }

  const onBriefKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void start();
    }
  };

  return (
    <form className="ohf-newrun" onSubmit={(event) => void start(event)}>
      <div className="ohf-newrun-field">
        <span className="ohf-field-label" id="ohf-newrun-skill">
          Skill
        </span>
        {skills.length === 0 ? (
          <p className="ohf-ev-dim">No skill is ready to run. An admin can upload one under Skills.</p>
        ) : (
          <div ref={groupRef} className="ohf-skill-picks" role="radiogroup" aria-labelledby="ohf-newrun-skill" onKeyDown={onCardsKeyDown}>
            {skills.map((entry, index) => {
              const on = entry.id === skillId;
              const focusable = skillId ? on : index === 0;
              return (
                <button
                  key={entry.id}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  data-on={on}
                  data-skill={entry.id}
                  tabIndex={focusable ? 0 : -1}
                  className="ohf-skill-pick"
                  onClick={() => setSkillId(entry.id)}
                >
                  <span className="ohf-skill-pick-head">
                    <span className="ohf-skill-name">{entry.name}</span>
                    {entry.version && <span className="ohf-skill-version">v{entry.version}</span>}
                    <span className="ohf-skill-pick-mark" aria-hidden>
                      {on && <CheckIcon size={11} />}
                    </span>
                  </span>
                  {entry.description && <span className="ohf-skill-pick-desc">{entry.description}</span>}
                  {entry.agents.length > 0 && (
                    <span className="ohf-ev-dim">
                      {entry.agents.length} {entry.agents.length === 1 ? "subagent" : "subagents"}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="ohf-newrun-row">
        <label className="ohf-newrun-field">
          <span className="ohf-field-label">Project</span>
          <select className="ohf-tpl-select" value={project} onChange={(event) => setProject(event.target.value)} required>
            <option value="" disabled>
              Pick a project
            </option>
            {workspace?.products.map((product) => (
              <optgroup key={product.id} label={product.name}>
                {product.projects
                  .filter((entry) => entry.status === "active")
                  .map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.name}
                    </option>
                  ))}
              </optgroup>
            ))}
          </select>
        </label>
        <label className="ohf-newrun-field">
          <span className="ohf-field-label">Title</span>
          <input
            className="ohf-input"
            placeholder={skill ? `${skill.name} · ${DAY.format(new Date())}` : "What this run is for"}
            value={title}
            maxLength={120}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
      </div>

      <label className="ohf-newrun-field">
        <span className="ohf-field-label">Brief</span>
        <textarea
          className="ohf-input ohf-input--area ohf-newrun-brief"
          placeholder="What should the skill make, for whom, with what? Markdown is fine — this is its first message."
          value={brief}
          maxLength={BRIEF_MAX_CHARS}
          rows={8}
          onChange={(event) => setBrief(event.target.value)}
          onKeyDown={onBriefKeyDown}
        />
        {brief.length > BRIEF_MAX_CHARS * 0.9 && (
          <span className="ohf-newrun-count" aria-live="polite">
            {brief.length.toLocaleString()} / {BRIEF_MAX_CHARS.toLocaleString()}
          </span>
        )}
      </label>

      <div className="ohf-newrun-field">
        <span className="ohf-field-label">Inputs</span>
        <AttachmentField selected={attachments} onChange={setAttachments} disabled={busy} />
        <span className="ohf-ev-dim">Picked files land in the run&apos;s inputs/ folder under their own names.</span>
      </div>

      {error && (
        <div className="ohf-alert" role="alert">
          <span className="ohf-alert-text">{error}</span>
        </div>
      )}

      <div className="ohf-newrun-actions">
        <button type="button" className="ohf-btn-quiet" onClick={onCancel}>
          Cancel
        </button>
        <span className="ohf-reply-hint" aria-hidden>
          ⌘/Ctrl+Enter starts
        </span>
        <button type="submit" className="ohf-btn-accent" disabled={!ready}>
          {busy ? "Starting…" : "Start"}
        </button>
      </div>
    </form>
  );
}
