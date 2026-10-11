"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { getKeyStatus } from "@/generation/actions";
import { useActive } from "@/generation/stores/active";
import { useLayout } from "@/generation/stores/layout";
import { getWorkspace, type Workspace } from "@/server/project-actions";

import { GRAIN_URI } from "../artwork";
import type { GalleryView } from "../data";
import { hotkeysQuiet } from "../hotkeys";
import type { Viewer } from "../openhiggsfield-app";
import { Sidebar } from "../sidebar";
import { TeamModal } from "../team-modal";
import { AgentsIndex } from "./agents-index";
import { bounceIfSignedOut } from "./client";
import { RunView } from "./run-view";

/* The agents pages in the studio's own shell: the same sidebar — team,
   projects, library — beside a main column that holds the runs, a run, or
   the skills. No gallery, so none of the wall's letter keys are listening;
   "[" still folds the sidebar, since the sidebar is here. */
export function AgentsApp({ fontClassName = "", viewer, runId = null }: { fontClassName?: string; viewer: Viewer; runId?: string | null }) {
  const router = useRouter();
  const sidebar = useLayout((state) => state.sidebar);
  const projectId = useActive((state) => state.projectId);
  const setProject = useActive((state) => state.setProject);

  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [keyConfigured, setKeyConfigured] = useState(false);
  const [keysOpen, setKeysOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  /* What the live region reads next; numbered, so the same line twice is
     heard twice (see the studio's own region). */
  const [said, setSaid] = useState<{ n: number; text: string } | null>(null);
  const announce = useCallback((text: string | null) => {
    if (text) setSaid((prev) => ({ n: (prev?.n ?? 0) + 1, text }));
  }, []);

  /* Products and projects, and the project a fresh session lands in — the
     same call the studio makes, so the two pages agree on the current one. */
  const loadWorkspace = useCallback(async () => {
    const result = await getWorkspace();
    if (!result.ok) {
      bounceIfSignedOut(result.code);
      return;
    }
    setWorkspace(result.data);
    const known = new Set(result.data.products.flatMap((p) => p.projects.map((pr) => pr.id)));
    const current = useActive.getState().projectId;
    if (!current || !known.has(current)) setProject(result.data.defaultProjectId);
    useLayout.getState().pruneRecent(known);
  }, [setProject]);
  useEffect(() => {
    void loadWorkspace();
  }, [loadWorkspace]);

  useEffect(() => {
    void getKeyStatus().then((result) => {
      if (!result.ok) {
        bounceIfSignedOut(result.code);
        return;
      }
      setKeyConfigured(result.data.source !== null);
    });
  }, []);

  /* The layout store hydrates on this call, after mount, for the reason
     layout.ts gives: the shell is server-rendered open. */
  useEffect(() => {
    void useLayout.persist.rehydrate();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "[" || event.repeat || event.metaKey || event.ctrlKey || event.altKey) return;
      if (hotkeysQuiet(event)) return;
      event.preventDefault();
      useLayout.getState().toggleSidebar();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  const switchProject = useCallback(
    (id: string) => {
      setProject(id);
      useLayout.getState().touchRecent(id);
    },
    [setProject],
  );

  /* The library scopes are the wall's: a press on Assets or Favorites goes
     back to the studio, naming the scope for it to open on. */
  const openStudio = useCallback((view: GalleryView) => router.push(`/?view=${view}`), [router]);

  const skipToMain = useCallback((event: React.MouseEvent<HTMLAnchorElement>) => {
    const main = document.getElementById("ohf-agents-main");
    if (!main) return;
    event.preventDefault();
    (main.querySelector<HTMLElement>("h1") ?? main).focus();
  }, []);

  return (
    <div className={`ohf ${fontClassName}`} style={{ "--ohf-grain": GRAIN_URI } as React.CSSProperties}>
      <a className="ohf-skip" href="#ohf-agents-main" onClick={skipToMain}>
        Skip to content
      </a>
      <div className="ohf-sr" role="status" aria-live="polite" aria-atomic="true">
        {said && <span key={said.n}>{said.text}</span>}
      </div>
      <div className="ohf-shell" data-sidebar={sidebar}>
        <Sidebar
          viewer={viewer}
          keyConfigured={keyConfigured}
          busy={busy}
          workspace={workspace}
          projectId={projectId}
          onProject={switchProject}
          onWorkspaceChanged={() => void loadWorkspace()}
          view="image"
          onView={openStudio}
          onTeam={() => setKeysOpen(true)}
        />
        <main className="ohf-main ohf-agents" id="ohf-agents-main" tabIndex={-1}>
          {runId ? (
            <RunView runId={runId} viewer={viewer} workspace={workspace} announce={announce} onBusy={setBusy} />
          ) : (
            <AgentsIndex role={viewer.role} workspace={workspace} projectId={projectId} announce={announce} onBusy={setBusy} />
          )}
        </main>
        {keysOpen && <TeamModal onClose={() => setKeysOpen(false)} onKeyChanged={(status) => setKeyConfigured(status.source !== null)} />}
      </div>
    </div>
  );
}
