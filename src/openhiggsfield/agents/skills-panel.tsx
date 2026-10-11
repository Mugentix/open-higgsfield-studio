"use client";

import { useRef, useState, type DragEvent } from "react";

import { deleteSkill } from "@/server/skill-actions";
import { SKILL_ZIP_MAX_BYTES, type SkillRecord } from "@/server/agents-contract";

import { droppedFiles, hasFiles } from "../asset-picker";
import { TrashIcon, UploadIcon } from "../icons";
import { bounceIfSignedOut } from "./client";
import { formatBytes } from "./events";

/* The team's skills: the Claude Code skill folders it uploaded as zips, each
   a card. Admins put new ones in through the drop zone — the route checks
   the bundle and keeps a bad one as "invalid" with its reasons, so the card
   says why — and take old ones out; members see the shelf. */

const ZIP_TYPES = new Set(["application/zip", "application/x-zip-compressed", "multipart/x-zip"]);

function isZip(file: File): boolean {
  return ZIP_TYPES.has(file.type) || /\.zip$/i.test(file.name);
}

/** POST the bundle to /api/skills as the upload route reads it — multipart,
    field `file` — through XHR, the one request API that reports progress. */
function uploadSkill(file: File, onProgress: (fraction: number) => void): Promise<SkillRecord> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/skills");
    xhr.responseType = "json";
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    };
    xhr.onload = () => {
      const body = (xhr.response ?? null) as (Partial<SkillRecord> & { error?: string }) | null;
      if (xhr.status >= 200 && xhr.status < 300 && body && typeof body.id === "string") {
        resolve(body as SkillRecord);
        return;
      }
      if (xhr.status === 401) window.location.assign("/login");
      reject(new Error(body?.error ?? `the server refused the bundle (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error("the upload did not reach the server"));
    const form = new FormData();
    form.append("file", file, file.name);
    xhr.send(form);
  });
}

export function SkillsPanel({
  skills,
  error,
  canManage,
  onChanged,
  announce,
}: {
  skills: SkillRecord[] | null;
  error: string | null;
  canManage: boolean;
  onChanged: () => void;
  announce: (line: string | null) => void;
}) {
  const [progress, setProgress] = useState<number | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const overDepth = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);

  async function send(files: File[]) {
    const file = files[0];
    if (!file) return;
    if (!isZip(file)) {
      setUploadError("A skill bundle is a .zip of the skill folder.");
      return;
    }
    if (file.size > SKILL_ZIP_MAX_BYTES) {
      setUploadError(`The bundle is larger than ${formatBytes(SKILL_ZIP_MAX_BYTES)}.`);
      return;
    }
    setUploadError(null);
    setProgress(0);
    try {
      const record = await uploadSkill(file, setProgress);
      announce(
        record.status === "ready"
          ? `${record.name} installed`
          : `${record.name || file.name} was refused: ${record.problems[0] ?? "see the card"}`,
      );
      onChanged();
    } catch (caught) {
      setUploadError(`Upload failed — ${caught instanceof Error ? caught.message : String(caught)}.`);
    } finally {
      setProgress(null);
    }
  }

  const dragProps = canManage
    ? {
        onDragEnter: (event: DragEvent<HTMLDivElement>) => {
          if (!hasFiles(event)) return;
          overDepth.current += 1;
          setOver(true);
        },
        onDragOver: (event: DragEvent<HTMLDivElement>) => {
          if (!hasFiles(event)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
        },
        onDragLeave: (event: DragEvent<HTMLDivElement>) => {
          if (!hasFiles(event)) return;
          overDepth.current = Math.max(0, overDepth.current - 1);
          if (overDepth.current === 0) setOver(false);
        },
        onDrop: (event: DragEvent<HTMLDivElement>) => {
          const files = droppedFiles(event);
          overDepth.current = 0;
          setOver(false);
          if (files.length === 0) return;
          event.preventDefault();
          void send(files);
        },
      }
    : {};

  const uploading = progress !== null;

  return (
    <div className="ohf-skills-panel">
      {canManage && (
        <div className={`ohf-skill-drop${over ? " ohf-drop--over" : ""}`} {...dragProps}>
          <input
            ref={inputRef}
            type="file"
            accept=".zip,application/zip,application/x-zip-compressed"
            className="ohf-sr"
            aria-label="Choose a skill bundle"
            tabIndex={-1}
            onChange={(event) => {
              const files = Array.from(event.target.files ?? []);
              event.target.value = "";
              void send(files);
            }}
          />
          <div className="ohf-skill-drop-copy">
            <span className="ohf-skill-drop-title">Add a skill</span>
            <span className="ohf-skill-drop-hint">
              Drop a .zip of a Claude Code skill folder — SKILL.md at its root, its scripts and references, agents/*.md for its
              subagents. Up to {formatBytes(SKILL_ZIP_MAX_BYTES)}. It runs as code on the worker, so only admins can add one.
            </span>
          </div>
          <button type="button" className="ohf-btn-solid" disabled={uploading} onClick={() => inputRef.current?.click()}>
            {uploading ? <span className="ohf-spinner" aria-hidden /> : <UploadIcon />}
            {uploading ? `Uploading ${Math.round((progress ?? 0) * 100)}%` : "Upload a bundle"}
          </button>
          {uploading && (
            <div
              className="ohf-skill-progress"
              role="progressbar"
              aria-label="Upload"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round((progress ?? 0) * 100)}
            >
              <span className="ohf-skill-progress-fill" style={{ width: `${Math.round((progress ?? 0) * 100)}%` }} />
            </div>
          )}
        </div>
      )}

      {(error || uploadError) && (
        <div className="ohf-alert" role="alert">
          <span className="ohf-alert-text">{uploadError ?? error}</span>
        </div>
      )}

      {skills === null && !error && <p className="ohf-ev-dim">Loading…</p>}

      {skills?.length === 0 && (
        <div className="ohf-agents-empty">
          <span className="ohf-picker-empty-ic">
            <UploadIcon size={15} />
          </span>
          <span className="ohf-picker-empty-title">No skills yet</span>
          <span className="ohf-picker-empty-hint">
            A skill is a Claude Code skill folder: a SKILL.md that says what it does and how, the scripts it runs (ffmpeg, Whisper,
            KIE calls), its references, and the subagents it delegates to. Zipped and uploaded here, it becomes something any member
            can brief and run from the studio.
          </span>
          {!canManage && <span className="ohf-picker-empty-hint">Ask an owner or admin to upload one.</span>}
        </div>
      )}

      {skills && skills.length > 0 && (
        <ul className="ohf-skill-grid" aria-label="Skills">
          {skills.map((skill) => (
            <SkillCard key={skill.id} skill={skill} canManage={canManage} onChanged={onChanged} announce={announce} />
          ))}
        </ul>
      )}
    </div>
  );
}

function SkillCard({
  skill,
  canManage,
  onChanged,
  announce,
}: {
  skill: SkillRecord;
  canManage: boolean;
  onChanged: () => void;
  announce: (line: string | null) => void;
}) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove() {
    setBusy(true);
    setError(null);
    const result = await deleteSkill(skill.id);
    setBusy(false);
    setArmed(false);
    if (!result.ok) {
      bounceIfSignedOut(result.code);
      setError(result.error);
      return;
    }
    announce(`${skill.name} removed`);
    onChanged();
  }

  const invalid = skill.status === "invalid";
  return (
    <li className="ohf-skill" data-status={skill.status}>
      <div className="ohf-skill-head">
        <span className="ohf-skill-name">{skill.name || skill.slug}</span>
        {skill.version && <span className="ohf-skill-version">v{skill.version}</span>}
        <span className="ohf-skill-state" data-status={skill.status}>
          {invalid ? "Invalid" : "Ready"}
        </span>
      </div>
      {skill.description && <p className="ohf-skill-desc">{skill.description}</p>}
      <dl className="ohf-skill-meta">
        <div>
          <dt>Files</dt>
          <dd>{skill.files}</dd>
        </div>
        <div>
          <dt>Size</dt>
          <dd>{formatBytes(skill.sizeBytes)}</dd>
        </div>
        {skill.compatibility && (
          <div>
            <dt>Needs</dt>
            <dd>{skill.compatibility}</dd>
          </div>
        )}
      </dl>
      {skill.agents.length > 0 && (
        <p className="ohf-skill-agents">
          <span className="ohf-ev-dim">{skill.agents.length === 1 ? "Subagent" : "Subagents"}</span> {skill.agents.join(", ")}
        </p>
      )}
      {invalid && skill.problems.length > 0 && (
        <ul className="ohf-skill-problems" aria-label="Why the bundle was refused">
          {skill.problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      )}
      {canManage && (
        <div className="ohf-skill-actions">
          {armed ? (
            <>
              <span className="ohf-ev-dim">Delete “{skill.name || skill.slug}”?</span>
              <button type="button" className="ohf-btn-solid ohf-skill-delete" disabled={busy} onClick={() => void remove()}>
                {busy ? "Deleting…" : "Delete"}
              </button>
              <button type="button" className="ohf-btn-quiet" disabled={busy} onClick={() => setArmed(false)}>
                Cancel
              </button>
            </>
          ) : (
            <button type="button" className="ohf-btn-quiet" aria-label={`Delete ${skill.name || skill.slug}`} onClick={() => setArmed(true)}>
              <TrashIcon size={12} />
              Delete
            </button>
          )}
        </div>
      )}
      {error && (
        <div className="ohf-alert" role="alert">
          <span className="ohf-alert-text">{error}</span>
        </div>
      )}
    </li>
  );
}
