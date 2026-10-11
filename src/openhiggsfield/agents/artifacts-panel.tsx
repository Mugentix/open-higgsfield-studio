"use client";

import { useEffect, useState } from "react";

import { publishAgentArtifact } from "@/server/agent-actions";
import type { AgentArtifactRecord } from "@/server/agents-contract";

import { saveFile } from "../download";
import { AssetsIcon, AudioIcon, CloseIcon, DocumentIcon, DownloadIcon, OpenOutIcon } from "../icons";
import { baseName, bounceIfSignedOut } from "./client";
import { formatBytes } from "./events";
import { Markdown } from "./markdown-view";

/* What the run made: every file the worker lifted out of the workspace,
   newest first. Pictures and clips show themselves; a document opens in a
   reader under the grid; anything can be saved, and a picture or a clip can
   be put on the team's wall, where it stands beside the generations as a
   result of its own — the wall holds media, so a document stays here. */

const TEXT_LIKE = /\.(md|markdown|txt|json|csv|tsv|yaml|yml|py|sh|log|srt|vtt)$/i;
const DOC_CAP = 200_000;

export function ArtifactsPanel({
  artifacts,
  onChanged,
  announce,
}: {
  artifacts: AgentArtifactRecord[];
  onChanged: () => void;
  announce: (line: string | null) => void;
}) {
  const [reading, setReading] = useState<AgentArtifactRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [publishing, setPublishing] = useState<string | null>(null);

  /* The reader follows its file: republished or re-listed, the record changes
     but the path stays; a file that vanished closes it. */
  useEffect(() => {
    if (reading && !artifacts.some((artifact) => artifact.id === reading.id)) setReading(null);
  }, [artifacts, reading]);

  async function publish(artifact: AgentArtifactRecord) {
    setPublishing(artifact.id);
    setError(null);
    const result = await publishAgentArtifact({ artifactId: artifact.id });
    setPublishing(null);
    if (!result.ok) {
      bounceIfSignedOut(result.code);
      setError(result.error);
      return;
    }
    announce(`${baseName(artifact.path)} is on the wall`);
    onChanged();
  }

  async function save(artifact: AgentArtifactRecord) {
    setError(null);
    const ok = await saveFile(artifact.url, baseName(artifact.path));
    if (!ok) setError("The file could not be read for saving. Open it in a tab and save it from there.");
  }

  if (artifacts.length === 0) {
    return (
      <div className="ohf-artifacts-empty">
        <span className="ohf-picker-empty-ic">
          <DocumentIcon size={15} />
        </span>
        <span className="ohf-picker-empty-title">Nothing made yet</span>
        <span className="ohf-picker-empty-hint">Files the agent writes to outputs/ appear here after each turn — plans, boards, takes.</span>
      </div>
    );
  }

  return (
    <div className="ohf-artifacts">
      <ul className="ohf-artifact-grid" aria-label="Artifacts">
        {artifacts.map((artifact) => {
          const name = baseName(artifact.path);
          const readable = artifact.fileKind === "document" || (artifact.fileKind === "other" && TEXT_LIKE.test(artifact.path));
          const published = artifact.resultId !== null;
          const publishable = artifact.fileKind === "image" || artifact.fileKind === "video";
          return (
            <li key={artifact.id} className="ohf-artifact" data-kind={artifact.fileKind} data-published={published}>
              <div className="ohf-artifact-preview">
                {artifact.fileKind === "image" ? (
                  /* eslint-disable-next-line @next/next/no-img-element */
                  <img src={artifact.url} alt={name} loading="lazy" />
                ) : artifact.fileKind === "video" ? (
                  <video src={artifact.url} controls preload="metadata" playsInline aria-label={name} />
                ) : artifact.fileKind === "audio" ? (
                  <div className="ohf-artifact-glyph">
                    <AudioIcon size={18} />
                    <audio src={artifact.url} controls preload="metadata" aria-label={name} />
                  </div>
                ) : readable ? (
                  <button type="button" className="ohf-artifact-glyph ohf-artifact-open" aria-label={`Read ${name}`} onClick={() => setReading(artifact)}>
                    <DocumentIcon size={18} />
                    <span className="ohf-artifact-ext">{extensionOf(name)}</span>
                  </button>
                ) : (
                  <div className="ohf-artifact-glyph">
                    <DocumentIcon size={18} />
                    <span className="ohf-artifact-ext">{extensionOf(name)}</span>
                  </div>
                )}
              </div>
              <div className="ohf-artifact-meta">
                <span className="ohf-artifact-name" title={artifact.path}>
                  {name}
                </span>
                <span className="ohf-artifact-size">{formatBytes(artifact.sizeBytes)}</span>
              </div>
              <div className="ohf-artifact-actions">
                <a
                  className="ohf-icon-btn ohf-icon-btn--ghost"
                  href={artifact.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={`Open ${name} in a new tab`}
                  title="Open in a new tab"
                >
                  <OpenOutIcon />
                </a>
                <button type="button" className="ohf-icon-btn ohf-icon-btn--ghost" aria-label={`Save ${name}`} title="Save" onClick={() => void save(artifact)}>
                  <DownloadIcon />
                </button>
                {published ? (
                  <span className="ohf-artifact-badge">
                    <AssetsIcon size={12} />
                    On the wall
                  </span>
                ) : !publishable ? null : (
                  <button
                    type="button"
                    className="ohf-btn-quiet ohf-artifact-publish"
                    disabled={publishing !== null}
                    aria-label={`Add ${name} to the wall`}
                    onClick={() => void publish(artifact)}
                  >
                    <AssetsIcon size={12} />
                    {publishing === artifact.id ? "Adding…" : "Add to wall"}
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {error && (
        <div className="ohf-alert" role="alert">
          <span className="ohf-alert-text">{error}</span>
        </div>
      )}
      {reading && <DocumentReader artifact={reading} onClose={() => setReading(null)} />}
    </div>
  );
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toUpperCase().slice(0, 5) : "FILE";
}

/* A document, read in place: Markdown through the stream's own renderer,
   anything else as text. Capped, so a stray log cannot stall the page. */
function DocumentReader({ artifact, onClose }: { artifact: AgentArtifactRecord; onClose: () => void }) {
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const name = baseName(artifact.path);
  const markdown = /\.(md|markdown)$/i.test(name);

  useEffect(() => {
    let current = true;
    setText(null);
    setFailed(false);
    void fetch(artifact.url, { mode: "cors" })
      .then(async (response) => {
        if (!response.ok) throw new Error(String(response.status));
        return response.text();
      })
      .then((body) => {
        if (current) setText(body);
      })
      .catch(() => {
        if (current) setFailed(true);
      });
    return () => {
      current = false;
    };
  }, [artifact.url]);

  const cut = text !== null && text.length > DOC_CAP;
  const shown = cut ? text.slice(0, DOC_CAP) : text;

  return (
    <section className="ohf-artifact-doc" aria-label={`Reading ${name}`}>
      <div className="ohf-artifact-doc-head">
        <span className="ohf-artifact-doc-name" title={artifact.path}>
          {name}
        </span>
        <button type="button" className="ohf-icon-btn ohf-icon-btn--ghost" aria-label="Close the reader" onClick={onClose}>
          <CloseIcon size={12} />
        </button>
      </div>
      <div className="ohf-artifact-doc-body ohf-scroll">
        {failed ? (
          <p className="ohf-ev-dim">The file could not be read here; open it in a tab instead.</p>
        ) : shown === null ? (
          <p className="ohf-ev-dim">Loading…</p>
        ) : markdown ? (
          <Markdown source={shown} />
        ) : (
          <pre className="ohf-code">{shown}</pre>
        )}
        {cut && <p className="ohf-ev-dim">Cut at {formatBytes(DOC_CAP)} — open the file for the rest.</p>}
      </div>
    </section>
  );
}
