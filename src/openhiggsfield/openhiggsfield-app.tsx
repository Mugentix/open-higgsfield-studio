"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { submitGeneration, type KeyStatus } from "@/generation/actions";
import { ROLE_WORDS, attachInput, useTargetsFor } from "@/generation/attach";
import { MODELS, getModel, parseSettings, resolveModelId } from "@/generation/catalog";
import type { GenerationPlane, MediaRole, Surface } from "@/generation/catalog";
import { FORMATS_CAP, planesFor, ratiosFor } from "@/generation/formats";
import type { Attachment } from "@/generation/media-roles";
import { assemblePlane } from "@/generation/plane";
import { POLL_DEADLINE_MS, stopWatching, watchRequest } from "@/generation/poll";
import { useActive } from "@/generation/stores/active";
import { useFormats } from "@/generation/stores/formats";
import { useLayout } from "@/generation/stores/layout";
import { useImagePrompt, useVideoPrompt } from "@/generation/stores/prompt";
import { useSettings } from "@/generation/stores/settings";
import type { RunView } from "@/generation/views";
import type { GalleryFilter, GalleryItem } from "@/server/gallery";
import { setAssetProduct } from "@/server/asset-actions";
import type { Workspace } from "@/server/project-actions";
import { ActionError, unwrap } from "@/server/result";
import { replayRun } from "@/server/run-actions";

import { runAnnouncement, verdictAnnouncement } from "./announce";
import { GRAIN_URI } from "./artwork";
import { useAssets } from "./asset-data";
import { CommandPalette, type PaletteCommand } from "./command-palette";
import { Compare, canCompare } from "./compare";
import { Composer } from "./composer";
import {
  ASSET_KEYS,
  countSetting,
  CROSS_VIEWS,
  durationBadge,
  hasPlane,
  metaOf,
  productShelf,
  ratioToCss,
  rolesOf,
  type GalleryView,
  type Verdict,
  utilityLine,
} from "./data";
import { exportNameFor, saveFile, saveZip, zipNameFor, type ExportContext } from "./download";
import { EMPTY_FILTERS, FilterBar, type Facets, type Filters } from "./filter-bar";
import { Gallery } from "./gallery";
import { useGallery, type Tile } from "./gallery-data";
import { stepRun, type RunRecord } from "./history";
import { hotkeysQuiet, isPaletteChord, isShortcutsKey, underDialog } from "./hotkeys";
import { CloseIcon, UndoIcon } from "./icons";
import { openTemplates } from "./prompt-templates";
import { SelectionBar, type SaveProgress } from "./selection-bar";
import { Shortcuts } from "./shortcuts";
import { Sidebar, type SidebarHandle } from "./sidebar";
import { readStudio } from "./studio-read";
import { TeamModal } from "./team-modal";
import { Topbar } from "./topbar";
import { Viewer } from "./viewer";

/* Long enough to read the bar and reach it; the drain line states the window. */
const UNDO_MS = 6000;

export interface ActiveRun {
  /** Identifies the skeleton this run occupies, so a batch clears one tile at
      a time as its own request settles. */
  id: string;
  surface: Surface;
  modelLabel: string;
  ratio: string;
  startedAt: number;
}

export type Viewer = {
  id: string;
  name: string;
  email: string;
  teamName: string;
  role: "owner" | "admin" | "member";
};

/** What a press has settled before any plane leaves: how many results each
    plane yields, the batch every plane of the press shares, and the project
    they land in. A plane made from a tile names it, so the run keeps its
    input's shape on the wall and remembers where it came from. */
type Press = {
  expected: number;
  batchId: string;
  projectId: string;
  source?: Tile;
};

/** Run ids are the studio's own; anything else is not a run of this team. */
const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** How long a watch waits before it stops asking on the tab's behalf: the
    entry's own limit. The server keeps checking on its own clock after that. */
function deadlineFor(modelId: string): number {
  try {
    return getModel(resolveModelId(modelId)).kie.deadlineMs ?? POLL_DEADLINE_MS;
  } catch {
    return POLL_DEADLINE_MS;
  }
}

/** The model's name for a line read aloud, when no tile on the wall carries
    it; an id the catalog no longer knows is read as itself. */
function labelFor(modelId: string): string {
  try {
    return getModel(resolveModelId(modelId)).label;
  } catch {
    return modelId;
  }
}

function describeError(caught: unknown): string {
  const message = caught instanceof Error ? caught.message : String(caught);
  if (caught instanceof ActionError) {
    if (caught.code === "unauthenticated") return "Your session ended. Sign in again to continue.";
    if (caught.code === "missing_key") return "Add the team's KIE API key to generate.";
    if (caught.code === "invalid") return `${message}.`;
  }
  return `Generation failed — ${message}. Adjust the prompt or inputs and try again; if it repeats, check the key in the sidebar.`;
}

/** A session that ended mid-work sends the visitor back through the gate. */
function bounceIfSignedOut(caught: unknown): void {
  if (caught instanceof ActionError && caught.code === "unauthenticated") window.location.assign("/login");
}

/** `initialView` is a Library scope named in the address — the agents pages
    send one when their sidebar's Assets or Favorites is pressed. */
export function OpenHiggsfieldApp({ fontClassName = "", viewer, initialView }: { fontClassName?: string; viewer: Viewer; initialView?: GalleryView }) {
  const surface = useActive((state) => state.surface);
  const modelId = useActive((state) => state.model);
  const setModel = useActive((state) => state.setModel);
  const projectId = useActive((state) => state.projectId);
  const setProject = useActive((state) => state.setProject);
  const model = getModel(modelId);
  const setSettings = useSettings((state) => state.set);
  const sidebar = useLayout((state) => state.sidebar);

  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [facets, setFacets] = useState<Facets | null>(null);
  /* A verdict moves a run between the popover's counts without changing how
     many tiles the wall holds, so each call asks for the facets again. */
  const [facetsNonce, setFacetsNonce] = useState(0);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [view, setView] = useState<GalleryView>(initialView ?? surface);
  const [runs, setRuns] = useState<ActiveRun[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [freshIds, setFreshIds] = useState<string[]>([]);
  const [viewerId, setViewerId] = useState<string | null>(null);
  const [compareOpen, setCompareOpen] = useState(false);
  const [focusNonce, setFocusNonce] = useState(0);
  /* Deleting is a flag on the server; the tiles are held aside until the bar
     times out so undo is one press. */
  const [deleted, setDeleted] = useState<Tile[] | null>(null);
  /* Picked runs, in the order they were picked: the count stack shows the most
     recent sheets on top, and a range extends from the last one touched. */
  const [selected, setSelected] = useState<string[]>([]);
  const [saving, setSaving] = useState<SaveProgress | null>(null);
  const [keyConfigured, setKeyConfigured] = useState(false);
  const [keysOpen, setKeysOpen] = useState(false);
  /* The two navigation dialogs share one slot: the palette opens the
     shortcuts, and Cmd/Ctrl+K over the shortcuts brings the palette back. */
  const [overlay, setOverlay] = useState<"palette" | "shortcuts" | null>(null);
  /* What the live region reads next. Numbered, so the same line twice — two
     runs of one model settling in turn — is a change the reader hears both
     times rather than text that never moved. */
  const [said, setSaid] = useState<{ n: number; text: string } | null>(null);
  const announce = useCallback((text: string | null) => {
    if (text) setSaid((prev) => ({ n: (prev?.n ?? 0) + 1, text }));
  }, []);

  /* A scope that came in the address is state from here on; the address
     goes back to plain "/" so a reload lands on the studio's own. */
  useEffect(() => {
    if (initialView) window.history.replaceState(window.history.state, "", "/");
  }, [initialView]);

  const galleryRef = useRef<HTMLDivElement>(null);
  const sidebarRef = useRef<SidebarHandle>(null);
  /* An attach that switches model must not move the wall off what the
     visitor was looking at; the scope-follows-surface rule stands down once. */
  const holdScope = useRef(false);
  const rangeAnchor = useRef<number | null>(null);
  const visibleRef = useRef<Tile[]>([]);
  const itemsRef = useRef<Tile[]>([]);
  const watched = useRef(new Set<string>());
  /* Presses number their own skeletons, so two batches in flight together can
     never claim the same tile. */
  const press = useRef(0);
  const alive = useRef(true);
  const freshTimers = useRef<number[]>([]);

  /* The wall: one server query per scope, project and filter. */
  const filter = useMemo<GalleryFilter>(
    () => ({
      view,
      ...(projectId ? { projectId } : {}),
      ...(filters.modelIds.length ? { modelIds: filters.modelIds } : {}),
      ...(filters.userIds.length ? { userIds: filters.userIds } : {}),
      ...(filters.verdict ? { verdict: filters.verdict } : {}),
      ...(filters.q ? { q: filters.q } : {}),
    }),
    [view, projectId, filters],
  );
  const gallery = useGallery(filter);
  const items = gallery.items;
  itemsRef.current = items;

  /* The model picker can cross surfaces, so the scope follows it — unless the
     visitor parked on a scope that spans both. */
  useEffect(() => {
    if (holdScope.current) {
      holdScope.current = false;
      return;
    }
    setView((current) => (CROSS_VIEWS.has(current) ? current : surface));
  }, [surface]);

  const imageTargets = useMemo(() => useTargetsFor("image", model), [model]);
  const videoTargets = useMemo(() => useTargetsFor("video", model), [model]);
  /* The product the next run lands in — its shelf is the picker's, and its
     brief (name, offer url, brand notes) is what a template's reserved
     variables fill from. */
  const product = useMemo(
    () => workspace?.products.find((p) => p.projects.some((pr) => pr.id === projectId)) ?? null,
    [workspace, projectId],
  );
  const productId = product?.id ?? null;

  /* The words a saved file is filed under, by the project a run belongs to.
     Built once per workspace: every download and the zip's own name ask it. */
  const namesFor = useMemo(() => {
    const byProject = new Map<string, ExportContext>();
    for (const product of workspace?.products ?? []) {
      for (const project of product.projects) byProject.set(project.id, { product: product.name, project: project.name });
    }
    return (projectId: string | undefined): ExportContext => (projectId && byProject.get(projectId)) || {};
  }, [workspace]);

  /* The product's shelf, in the order the picker shows it — and the order the
     digit keys count it. Same team query the composer's tray reads. */
  const { assets } = useAssets();
  const shelf = useMemo(() => productShelf(assets, productId, "image"), [assets, productId]);

  /* Products and projects, and the project a fresh session lands in. */
  const loadWorkspace = useCallback(async () => {
    const result = await readStudio("workspace");
    if (!result.ok) {
      bounceIfSignedOut(new ActionError(result.error, result.code));
      return;
    }
    setWorkspace(result.data);
    const known = new Set(result.data.products.flatMap((p) => p.projects.map((pr) => pr.id)));
    const current = useActive.getState().projectId;
    if (!current || !known.has(current)) setProject(result.data.defaultProjectId);
    /* A project archived since it was last opened leaves the Recent list
       rather than holding one of its places blank. */
    useLayout.getState().pruneRecent(known);
  }, [setProject]);
  useEffect(() => {
    void loadWorkspace();
  }, [loadWorkspace]);

  useEffect(() => {
    if (!projectId) return;
    let live = true;
    void readStudio("facets", { projectId }).then((result) => {
      if (live && result.ok) setFacets(result.data);
    });
    return () => {
      live = false;
    };
  }, [projectId, items.length, facetsNonce]);

  useEffect(() => {
    void readStudio("key-status").then((result) => {
      if (!result.ok) {
        bounceIfSignedOut(new ActionError(result.error, result.code));
        return;
      }
      setKeyConfigured(result.data.source !== null);
      if (result.data.source === null) setKeysOpen(true);
    });
  }, []);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      stopWatching();
      for (const timer of freshTimers.current) clearTimeout(timer);
    };
  }, []);

  /* Each arrival blooms on its own clock: a batch lands over several seconds,
     and one shared timer would cut the last tile's entrance short. */
  const markFresh = useCallback((ids: string[]) => {
    setFreshIds((prev) => [...prev, ...ids]);
    freshTimers.current.push(
      window.setTimeout(
        () => setFreshIds((prev) => prev.filter((id) => !ids.includes(id))),
        900,
      ),
    );
  }, []);

  /** The tiles a settled run leaves on the wall, from what the wall already
      shows of it. Tiles the wall does not show (another scope) arrive through
      the change feed instead. */
  const settle = useCallback(
    (view: RunView) => {
      const now = Date.now();
      const changes: GalleryItem[] = [];
      for (const result of view.results) {
        const tile = itemsRef.current.find((item) => item.id === result.id);
        if (!tile) continue;
        const completed = result.status === "completed" && Boolean(result.url);
        changes.push({
          ...tile,
          status: completed ? "completed" : "failed",
          urls: completed && result.url ? [result.url] : [],
          error: completed ? undefined : (result.error ?? view.error ?? "the platform reported a failure"),
          mirrored: result.mirrored,
          updatedAt: now,
        });
      }
      if (changes.length) gallery.patch(changes);
      return changes;
    },
    [gallery],
  );

  /* One watch per run, used both by Generate and by a wall that already holds
     running tiles. The watch is what makes the server ask KIE promptly; the
     server keeps asking on its own after the tab stops. */
  const resume = useCallback(
    async (requestId: string, modelId: string) => {
      if (watched.current.has(requestId)) return;
      watched.current.add(requestId);
      try {
        const view = await watchRequest(requestId, { deadline: Date.now() + deadlineFor(modelId) });
        if (!alive.current) return;
        const records = settle(view);
        markFresh(records.filter((record) => record.status === "completed").map((record) => record.id));
        /* Read aloud whatever settled, on the wall or off it: the view holds
           every result of the request, and the wall's own tile, when it has
           one, names the model. */
        announce(
          runAnnouncement(
            records[0]?.modelLabel ?? labelFor(modelId),
            view.results
              .filter((result) => result.status !== "running")
              .map((result) => {
                const error = result.error ?? view.error;
                return {
                  status: result.status === "completed" && result.url ? ("completed" as const) : ("failed" as const),
                  ...(error ? { error } : {}),
                };
              }),
          ),
        );
        const failed = records.find((record) => record.status === "failed");
        if (failed) {
          setError((prev) => prev ?? `Run not delivered — ${failed.error}. Adjust the prompt or settings and retry.`);
        }
      } catch (caught) {
        if (!alive.current) return;
        bounceIfSignedOut(caught);
        /* A watch that timed out is not a failed run: the server is still
           checking, and the tile stays a skeleton until it knows. */
        if (caught instanceof ActionError) setError((prev) => prev ?? describeError(caught));
      } finally {
        watched.current.delete(requestId);
      }
    },
    [announce, markFresh, settle],
  );

  /* Running tiles on the wall — this tab's or a teammate's — get a watch. */
  useEffect(() => {
    for (const item of items) {
      if (item.status === "running" && RUN_ID.test(item.requestId)) void resume(item.requestId, item.modelId);
    }
  }, [items, resume]);

  const switchView = useCallback(
    (next: GalleryView) => {
      setView(next);
      galleryRef.current?.scrollTo({ top: 0 });
      if (CROSS_VIEWS.has(next) || next === surface) return;
      const first = MODELS.find((entry) => entry.surface === next);
      if (first) setModel(first.id);
    },
    [setModel, surface],
  );

  /* Every way into a project — the sidebar, a recent, the palette, a project
     just made — comes through here, so each one is remembered as opened. */
  const switchProject = useCallback(
    (id: string) => {
      setProject(id);
      useLayout.getState().touchRecent(id);
      setSelected([]);
      galleryRef.current?.scrollTo({ top: 0 });
    },
    [setProject],
  );

  /* What every press needs before a plane can leave: a key on the team and a
     project to land in. Names the one that is missing and answers null. */
  const pressTarget = useCallback((): string | null => {
    if (!keyConfigured) {
      setKeysOpen(true);
      setError("Add the team's KIE API key to generate.");
      return null;
    }
    const projectId = useActive.getState().projectId;
    if (!projectId) {
      setError("Pick a project first.");
      return null;
    }
    return projectId;
  }, [keyConfigured]);

  /* One plane leaving the studio, however it was made — typed in the composer,
     fanned out to another format, or run straight off a tile. Presses do not
     wait on each other: each opens its own skeletons and keeps its own watch,
     so the composer is free the moment the tiles appear and any number of runs
     can be in flight. */
  const submitPlane = useCallback(
    async (plane: GenerationPlane, view: Press) => {
      const entry = getModel(plane.model);
      /* A utility keeps its input's shape: its plane carries no ratio of its own. */
      const ratio =
        view.source?.ratio ??
        ratioToCss(plane.settings.aspectRatio, entry.surface === "image" ? "4 / 3" : "16 / 9");
      const meta = metaOf(entry, plane.settings);
      const badge = entry.surface === "video" ? durationBadge(plane.settings) : undefined;

      /* Batch size resolves to results, not to requests. A model that carries
         its own count answers one request with that many media; every other
         model is submitted once per result. Either way the grid opens the same
         number of skeletons, and each request clears the ones it owns. */
      const native = countSetting(entry);
      const startedAt = Date.now();
      const seq = ++press.current;
      const pending: ActiveRun[] = Array.from({ length: view.expected }, (_, index) => ({
        id: `pending-${seq}-${index}`,
        surface: entry.surface,
        modelLabel: entry.label,
        ratio,
        startedAt,
      }));
      const slots = native
        ? [{ skeletons: pending.map((slot) => slot.id) }]
        : pending.map((slot) => ({ skeletons: [slot.id] }));
      const productId =
        workspace?.products.find((p) => p.projects.some((pr) => pr.id === view.projectId))?.id ?? "";

      setError(null);
      /* Newest press on top, above whatever is still rendering from the last. */
      setRuns((prev) => [...pending, ...prev]);
      galleryRef.current?.scrollTo({ top: 0, behavior: "smooth" });

      const runOne = async (slot: { skeletons: string[] }) => {
        try {
          const queued = unwrap(
            await submitGeneration({
              plane,
              idempotencyKey: crypto.randomUUID(),
              batchId: view.batchId,
              projectId: view.projectId,
              ...(view.source ? { parentResultId: view.source.id } : {}),
            }),
          );
          /* The tiles the server minted take the skeletons' places at once. */
          gallery.patch(
            queued.resultIds.map((id) => ({
              id,
              requestId: queued.requestId,
              surface: entry.surface,
              kind: entry.surface,
              modelId: entry.id,
              modelLabel: entry.label,
              prompt: plane.prompt.text.trim(),
              ratio,
              meta,
              ...(badge ? { badge } : {}),
              urls: [],
              status: "running" as const,
              createdAt: startedAt,
              updatedAt: startedAt,
              favorite: false,
              verdict: null,
              note: null,
              settings: plane.settings,
              userId: viewer.id,
              userName: viewer.name,
              projectId: view.projectId,
              productId,
              mirrored: false,
              deletedAt: null,
            })),
          );
          setRuns((prev) => prev.filter((active) => !slot.skeletons.includes(active.id)));
          await resume(queued.requestId, entry.id);
        } catch (caught) {
          if (!alive.current) return;
          bounceIfSignedOut(caught);
          const message = describeError(caught);
          if (message.includes("API key")) setKeysOpen(true);
          setError((prev) => prev ?? message);
        } finally {
          if (alive.current) {
            setRuns((prev) => prev.filter((active) => !slot.skeletons.includes(active.id)));
          }
        }
      };

      await Promise.all(slots.map(runOne));
    },
    [resume, gallery, viewer, workspace],
  );

  /* Generate: the composer's plane, once per format it was asked for. A press
     snapshots the plane before anything else can change it, and every format
     leaves under the same batch so the wall can tell them apart from the next
     press. */
  const generate = useCallback(async () => {
    const projectId = pressTarget();
    if (!projectId) return;
    const plane = assemblePlane();
    const entry = getModel(plane.model);
    /* A utility has no words; the tile is signed with what was done instead.
       The mapper never sends this line. */
    if (entry.prompt === "none") plane.prompt.text = utilityLine(entry, plane.settings);
    else if (!plane.prompt.text.trim()) return;

    /* A utility runs once: the batch is the studio's, not the model's, and N
       copies of the same upscale are N identical bills. */
    const native = countSetting(entry);
    const expected =
      entry.prompt === "none"
        ? 1
        : native
          ? Math.max(1, Number(plane.settings[native.key]) || 1)
          : useActive.getState().batch;
    /* Primary first, then each extra ratio the catalog still offers; the count
       is settled once because no format changes it. */
    const planes = planesFor(plane, ratiosFor(entry, useFormats.getState().byModel[entry.id] ?? []));
    if (planes.length * expected > FORMATS_CAP) {
      setError(`Up to ${FORMATS_CAP} results per press — untick a format or lower the batch.`);
      return;
    }
    const batchId = crypto.randomUUID();
    /* Each press prepends its skeletons, so the primary goes last and lands
       on top, the extra formats beneath it in the order they were ticked. */
    await Promise.all([...planes].reverse().map((variant) => submitPlane(variant, { expected, batchId, projectId })));
  }, [pressTarget, submitPlane]);

  /* A utility on a finished tile — upscale it, lift its background — in one
     press: the tile is the plane's only input, the entry's defaults are its
     dials, and it lands beside its source with the lineage recorded. */
  const runUtility = useCallback(
    async (record: RunRecord, modelId: string) => {
      /* The viewer is released before anything can bail: it has already played
         its exit by the time it calls here, and a dialog left mounted behind
         the key prompt would trap the studio. */
      setViewerId(null);
      const url = record.urls[0];
      if (!url || record.status !== "completed") return;
      const projectId = pressTarget();
      if (!projectId) return;
      const tile = record as Tile;
      const entry = getModel(modelId);
      const role = rolesOf(entry)[0];
      if (!role) return;
      const settings = parseSettings(entry, {});
      const plane: GenerationPlane = {
        model: entry.id,
        prompt: { text: utilityLine(entry, settings) },
        media: { [role]: [{ id: tile.id, url, role, resultId: tile.id }] },
        settings,
      };
      await submitPlane(plane, {
        expected: 1,
        batchId: crypto.randomUUID(),
        projectId: tile.projectId || projectId,
        source: tile,
      });
    },
    [pressTarget, submitPlane],
  );

  /* Something on the wall or the shelf becomes the next run's input. The wall
     stays where it is even when the composer switches model to take the slot. */
  const place = useCallback((entry: Attachment, role: MediaRole) => {
    holdScope.current = true;
    const outcome = attachInput(entry, role);
    if (!outcome) {
      holdScope.current = false;
      setError("No model in the catalog takes that input.");
      return;
    }
    /* The target takes either frames or references and already holds the
       other group: nothing was attached and no model was switched, and the
       caret stays put — only the line says why. The viewer is still released:
       it has already played its exit by the time it calls here, and a dialog
       left mounted behind the line would trap the studio. */
    if (outcome.blocked) {
      holdScope.current = false;
      setViewerId(null);
      setError(outcome.blocked);
      return;
    }
    if (!outcome.switched) holdScope.current = false;
    setError(outcome.full ? `Every ${ROLE_WORDS[role].toLowerCase()} slot is taken — remove one in the composer first.` : null);
    setViewerId(null);
    setFocusNonce((n) => n + 1);
  }, []);

  const attach = useCallback(
    (record: RunRecord, role: MediaRole) => {
      const url = record.urls[0];
      /* Same release on the way out with nothing to attach: the viewer's R
         key answers on a run without a file too. */
      if (!url || record.status !== "completed") {
        setViewerId(null);
        return;
      }
      place({ url, resultId: record.id }, role);
    },
    [place],
  );

  /* Alt+1…9: the product's pinned files, as references, without opening the
     picker — a packshot is one chord away in every project of the product.
     Read by key code, since Option+digit types a symbol on a Mac keyboard —
     and for the same reason quiet in a text field, where that symbol is what
     was meant. Quiet under a dialog too, where the composer is not the
     surface on top. */
  const shelfRef = useRef(shelf);
  shelfRef.current = shelf;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.altKey || event.metaKey || event.ctrlKey) return;
      const digit = /^Digit([1-9])$/.exec(event.code)?.[1];
      if (!digit || Number(digit) > ASSET_KEYS) return;
      if (hotkeysQuiet(event)) return;
      const asset = shelfRef.current[Number(digit) - 1];
      if (!asset) return;
      event.preventDefault();
      place({ url: asset.url, assetId: asset.id }, "reference");
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [place]);

  /* The layout store hydrates on this call, not at module evaluation: the
     shell is server-rendered open, and a stored or narrow-screen "rail" read
     before React hydrates would leave data-sidebar out of step with it (see
     layout.ts). After mount the choice lands in a commit that can update it. */
  useEffect(() => {
    void useLayout.persist.rehydrate();
  }, []);

  /* "[" folds the sidebar to its rail and back, on the same terms as the
     other letter keys. */
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

  /* Cmd/Ctrl+K is a chord, so it answers from the caret too — the one key in
     the studio that does. Pressed again it closes the palette; over the
     shortcuts sheet it swaps to the palette; under any other dialog it stays
     quiet, since the viewer or the team is what is on top. "?" opens the
     shortcuts on the letter keys' terms: not while typing, not under a dialog. */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isPaletteChord(event)) {
        event.preventDefault();
        if (event.repeat) return;
        setOverlay((current) => {
          if (current === "palette") return null;
          if (current === "shortcuts") return "palette";
          return underDialog() ? current : "palette";
        });
        return;
      }
      if (isShortcutsKey(event)) {
        event.preventDefault();
        setOverlay("shortcuts");
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  /* Variants: the very plane this tile was made from, four more times, each
     run remembering where it came from. */
  const variants = useCallback(
    async (record: RunRecord) => {
      if (!hasPlane(record)) {
        setError("This came from a skill run — there is no plane to render again.");
        return;
      }
      const tile = record as Tile;
      const count = 4;
      const startedAt = Date.now();
      const seq = ++press.current;
      const pending: ActiveRun[] = Array.from({ length: count }, (_, index) => ({
        id: `pending-${seq}-${index}`,
        surface: tile.surface,
        modelLabel: tile.modelLabel,
        ratio: tile.ratio,
        startedAt,
      }));
      setError(null);
      setViewerId(null);
      setRuns((prev) => [...pending, ...prev]);
      galleryRef.current?.scrollTo({ top: 0, behavior: "smooth" });
      try {
        const created = unwrap(await replayRun({ resultId: tile.id, count, batchId: crypto.randomUUID() }));
        gallery.patch(
          created.flatMap((run) =>
            run.resultIds.map((id) => ({
              ...tile,
              id,
              requestId: run.requestId,
              urls: [],
              status: "running" as const,
              error: undefined,
              createdAt: startedAt,
              updatedAt: startedAt,
              favorite: false,
              mirrored: false,
              deletedAt: null,
              userId: viewer.id,
              userName: viewer.name,
            })),
          ),
        );
        setRuns((prev) => prev.filter((active) => !pending.some((slot) => slot.id === active.id)));
        await Promise.all(created.map((run) => resume(run.requestId, tile.modelId)));
      } catch (caught) {
        if (!alive.current) return;
        bounceIfSignedOut(caught);
        setError(describeError(caught));
      } finally {
        if (alive.current) setRuns((prev) => prev.filter((active) => !pending.some((slot) => slot.id === active.id)));
      }
    },
    [gallery, resume, viewer],
  );

  const pinAsset = useCallback(
    async (assetId: string, pinned: boolean) => {
      const result = await setAssetProduct({ assetId, productId: pinned ? productId : null });
      if (!result.ok) setError(result.error);
    },
    [productId],
  );

  /* Reuse restores the whole plane the run was made from — model, its dials,
     then the words. A reuse that dropped the ratio and resolution would
     re-render a different picture from the same prompt. */
  const retry = useCallback(
    (record: RunRecord) => {
      if (!hasPlane(record)) {
        setError("This came from a skill run — there is no plane to load back.");
        return;
      }
      const targetModel = resolveModelId(record.modelId);
      const target = MODELS.find((entry) => entry.id === targetModel);
      if (target) {
        setModel(target.id);
        if (record.settings && target.id === record.modelId) setSettings(target.id, record.settings);
      }
      /* A utility's record carries the line its tile was signed with, not a
         prompt; written to the store it would surface as the words the next
         real model generates from. */
      if (target?.prompt !== "none") {
        (record.surface === "image" ? useImagePrompt : useVideoPrompt).getState().setText(record.prompt);
      }
      setViewerId(null);
      setError(null);
      setFocusNonce((n) => n + 1);
    },
    [setModel, setSettings],
  );

  /* Remix: the words and dials back in the composer, and the picture itself
     as the reference to move from. */
  const remix = useCallback(
    (record: RunRecord) => {
      retry(record);
      attach(record, "reference");
    },
    [retry, attach],
  );

  /* The grid hands back the records it was given, which are always tiles. */
  const toggleFavorite = useCallback(
    (record: RunRecord) => {
      void gallery.favorite([record as Tile], !record.favorite);
    },
    [gallery],
  );

  /* The team's call on a run — winner, testing, killed, or taken back. The
     grid and the viewer have already decided between the call and its
     reversal; the cache puts it on the wall before the server answers. Said
     aloud too: a letter key on a hovered tile changes nothing a reader can
     hear otherwise. */
  const judgeRun = useCallback(
    (record: RunRecord, verdict: Verdict | null) => {
      void gallery.judge([record as Tile], verdict).then(() => setFacetsNonce((n) => n + 1));
      announce(verdictAnnouncement(verdict, record.prompt));
    },
    [announce, gallery],
  );

  /* The words behind the call. A refused save is reported on the composer's
     line; the viewer keeps the draft so the words are not lost with it. */
  const noteRun = useCallback(
    (record: RunRecord, note: string | null) => {
      gallery.note(record as Tile, note).catch((caught: unknown) => {
        bounceIfSignedOut(caught);
        setError(caught instanceof Error ? caught.message : "The note could not be saved.");
      });
    },
    [gallery],
  );

  const deleteRuns = useCallback(
    (records: Tile[]) => {
      if (records.length === 0) return;
      void gallery
        .remove(records)
        .then((gone) => {
          if (gone.length) setDeleted(gone);
          if (gone.length < records.length) {
            setError("Some of those runs belong to a teammate; an admin can remove them.");
          }
        })
        .catch((caught: unknown) => {
          bounceIfSignedOut(caught);
          setError(caught instanceof Error ? caught.message : "The runs could not be deleted.");
        });
    },
    [gallery],
  );

  const deleteRun = useCallback((record: RunRecord) => deleteRuns([record as Tile]), [deleteRuns]);

  const restoreDeleted = useCallback(() => {
    if (!deleted) return;
    void gallery.restore(deleted);
    setDeleted(null);
  }, [deleted, gallery]);

  useEffect(() => {
    if (!deleted) return;
    const timer = setTimeout(() => setDeleted(null), UNDO_MS);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDeleted(null);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [deleted]);

  /* ---------- picking runs ----------

     The grid is in selection mode whenever something is picked, so the mode has
     no switch of its own: the checkbox that appears on hover is the way in, and
     the toolbar's cross is the way out. */

  const pickedSet = useMemo(() => new Set(selected), [selected]);
  const byId = useMemo(() => new Map(items.map((record) => [record.id, record])), [items]);
  const pickedRecords = useMemo(
    () => selected.map((id) => byId.get(id)).filter((record): record is Tile => record !== undefined),
    [selected, byId],
  );

  useEffect(() => {
    visibleRef.current = items;
  }, [items]);

  /* A run that left the grid cannot stay picked — deleted, filtered away, or
     released from the shelf while the Favorites scope was the one on screen. */
  const visibleIds = useMemo(() => new Set(items.map((record) => record.id)), [items]);
  useEffect(() => {
    setSelected((prev) => {
      const next = prev.filter((id) => visibleIds.has(id));
      return next.length === prev.length ? prev : next;
    });
  }, [visibleIds]);

  /* Switching scope switches what "everything picked" means, so the selection
     does not travel with it. */
  useEffect(() => {
    setSelected([]);
    rangeAnchor.current = null;
  }, [view]);

  const clearPicked = useCallback(() => {
    setSelected([]);
    rangeAnchor.current = null;
  }, []);

  const togglePick = useCallback((id: string, index: number, range: boolean) => {
    const from = rangeAnchor.current;
    rangeAnchor.current = index;
    setSelected((prev) => {
      if (range && from !== null) {
        const span = visibleRef.current
          .slice(Math.min(from, index), Math.max(from, index) + 1)
          .filter((record) => record.status !== "running")
          .map((record) => record.id);
        const held = new Set(prev);
        return [...prev, ...span.filter((entry) => !held.has(entry))];
      }
      return prev.includes(id) ? prev.filter((entry) => entry !== id) : [...prev, id];
    });
  }, []);

  /* Escape leaves the selection the way it leaves every other transient layer
     in the studio. An open dialog owns the key while it is up. */
  useEffect(() => {
    if (selected.length === 0 || viewerId || compareOpen || overlay) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") clearPicked();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [selected.length, viewerId, compareOpen, overlay, clearPicked]);

  /* The comparison is of the selection; when that stops being two to four
     runs — a delete, a scope change — the dialog has nothing left to show. */
  useEffect(() => {
    if (!canCompare(pickedRecords.length)) setCompareOpen(false);
  }, [pickedRecords.length]);

  /* One keep for the whole selection: if every picked run is already kept the
     press releases them, which is what a pressed control has to mean. */
  const favoritePicked = useCallback(() => {
    const keep = !pickedRecords.every((record) => record.favorite === true);
    void gallery.favorite(pickedRecords, keep);
  }, [pickedRecords, gallery]);

  /* One call for the whole selection. The bar decides between the call and
     taking it back — a press on a control the whole set already answers to
     has to release — so the app only names the set. */
  const judgePicked = useCallback(
    (verdict: Verdict | null) => {
      void gallery.judge(pickedRecords, verdict).then(() => setFacetsNonce((n) => n + 1));
      announce(verdictAnnouncement(verdict, `${pickedRecords.length} ${pickedRecords.length === 1 ? "run" : "runs"}`));
    },
    [announce, gallery, pickedRecords],
  );

  const deletePicked = useCallback(() => {
    deleteRuns(pickedRecords);
    clearPicked();
  }, [deleteRuns, pickedRecords, clearPicked]);

  /* One run, saved from its card, the viewer or a compare column, under the
     name its product and project give it. The refusal is reported through the
     strip the composer already reserves for it. */
  const downloadRun = useCallback(
    async (record: RunRecord) => {
      const url = record.urls[0];
      if (!url) return;
      const ok = await saveFile(url, exportNameFor(record, namesFor((record as Tile).projectId), 0));
      if (!ok) {
        setError("The file could not be read for saving. Open the run to save it from the browser instead.");
      }
    },
    [namesFor],
  );

  /* Several picked runs travel as one archive: browsers throttle a burst of
     downloads into a single "allow multiple files?" prompt and drop the rest.
     The zip is filed under whatever the selection has in common — its project,
     else its product, else the day alone — and a single run is saved as itself. */
  const downloadPicked = useCallback(async () => {
    const files = pickedRecords.filter((record) => record.urls[0]);
    if (files.length === 0) return;
    if (files.length === 1) {
      await downloadRun(files[0]!);
      return;
    }
    const projectIds = new Set(files.map((record) => record.projectId));
    const productIds = new Set(files.map((record) => record.productId));
    const zipCtx: ExportContext =
      projectIds.size === 1
        ? namesFor(files[0]!.projectId)
        : productIds.size === 1
          ? { product: namesFor(files[0]!.projectId).product }
          : {};
    setSaving({ done: 0, total: files.length });
    const ok = await saveZip(
      files.map((record) => ({ name: exportNameFor(record, namesFor(record.projectId), 0), url: record.urls[0]! })),
      zipNameFor(zipCtx),
      { onProgress: (done, total) => setSaving({ done, total }) },
    );
    setSaving(null);
    if (!ok) {
      setError("Nothing could be saved: the files could not be read. Open a run to save it from the browser instead.");
    }
  }, [pickedRecords, downloadRun, namesFor]);

  /* An empty-gallery starter loads the composer and hands the visitor the
     caret; pressing Generate stays their call. */
  const applyStarter = useCallback(
    (text: string) => {
      (surface === "image" ? useImagePrompt : useVideoPrompt).getState().setText(text);
      setError(null);
      setFocusNonce((n) => n + 1);
    },
    [surface],
  );

  const openViewer = useCallback((id: string) => setViewerId(id), []);
  const openKeys = useCallback(() => setKeysOpen(true), []);
  const closeOverlay = useCallback(() => setOverlay(null), []);

  /* The first thing Tab reaches: past the sidebar and the wall, straight to
     the words. The caret lands in the prompt itself; a utility has none, so
     the first of its controls takes the focus instead. The href stands for
     the same jump where the handler cannot run. */
  const skipToComposer = useCallback((event: React.MouseEvent<HTMLAnchorElement>) => {
    const composer = document.getElementById("ohf-composer");
    if (!composer) return;
    event.preventDefault();
    (document.getElementById("ohf-prompt") ?? composer.querySelector<HTMLElement>("button:not(:disabled)"))?.focus();
  }, []);

  /* What a palette row does once chosen. A product opens its first project;
     the group unfolds in the sidebar as the project lands. A model switches
     the composer, and the scope follows the surface as it does from the
     picker. The palette has already closed by the time this runs. */
  const runCommand = useCallback(
    (command: PaletteCommand) => {
      switch (command.type) {
        case "project":
          switchProject(command.id);
          return;
        case "product": {
          const product = workspace?.products.find((entry) => entry.id === command.id);
          const first = product?.projects.find((project) => project.status === "active");
          if (first) switchProject(first.id);
          else sidebarRef.current?.newProject(command.id);
          return;
        }
        case "model":
          setModel(command.id);
          setFocusNonce((n) => n + 1);
          return;
        case "scope":
          switchView(command.view);
          return;
        case "action":
          switch (command.action) {
            case "new-project":
              sidebarRef.current?.newProject();
              return;
            case "new-product":
              sidebarRef.current?.newProduct();
              return;
            case "toggle-sidebar":
              useLayout.getState().toggleSidebar();
              return;
            case "team":
              setKeysOpen(true);
              return;
            case "shortcuts":
              setOverlay("shortcuts");
              return;
            case "templates":
              /* The composer owns the panel and the control it opens off;
                 this only asks. Safe from here: the palette is a <dialog>
                 that has closed, and the panel is a popover, not another. */
              openTemplates();
              return;
          }
      }
    },
    [switchProject, switchView, setModel, workspace],
  );

  /* The palette's world, built when it opens: projects and products from the
     workspace, models from the catalog, the scope and the model in force.
     Templates are offered while the composer has a prompt to fill — a
     utility takes none, and a row that did nothing would be a dead one. */
  const paletteSource = useMemo(
    () => ({ workspace, models: MODELS, projectId, modelId: model.id, view, sidebar, templates: model.prompt !== "none" }),
    [workspace, projectId, model.id, model.prompt, view, sidebar],
  );
  const recent = useLayout((state) => state.recent);
  const openCompare = useCallback(() => setCompareOpen(true), []);
  const closeCompare = useCallback(() => setCompareOpen(false), []);
  const favoriteById = useCallback(
    (id: string, keep: boolean) => {
      const record = byId.get(id);
      if (record) void gallery.favorite([record], keep);
    },
    [byId, gallery],
  );
  const runGenerate = useCallback(() => void generate(), [generate]);
  const runTool = useCallback((record: RunRecord, modelId: string) => void runUtility(record, modelId), [runUtility]);
  const downloadSelection = useCallback(() => void downloadPicked(), [downloadPicked]);
  const dismissDeleted = useCallback(() => setDeleted(null), []);
  const viewerItem = viewerId
    ? (items.find((record) => record.id === viewerId && record.status !== "running") ?? null)
    : null;

  /* The walk follows the scope on screen, not the whole log. At either end
     there is no neighbour to hand down, and the step goes quiet. */
  const viewable = useMemo(() => items.filter((record) => record.status !== "running"), [items]);
  const prevRun = viewerId ? stepRun(viewable, viewerId, -1) : null;
  const nextRun = viewerId ? stepRun(viewable, viewerId, 1) : null;

  const runsHere = useMemo(
    () => runs.filter((active) => view === "assets" || active.surface === view),
    [runs, view],
  );
  const busy = runs.length > 0 || items.some((record) => record.status === "running");

  return (
    <div className={`ohf ${fontClassName}`} style={{ "--ohf-grain": GRAIN_URI } as React.CSSProperties}>
      <a className="ohf-skip" href="#ohf-composer" onClick={skipToComposer}>
        Skip to composer
      </a>
      {/* The one place the studio speaks: runs settling on a wall that may
          be scrolled away, and calls made by a letter key. Polite, so it
          waits for the reader to finish; keyed, so a repeated line is read
          again. */}
      <div className="ohf-sr" role="status" aria-live="polite" aria-atomic="true">
        {said && <span key={said.n}>{said.text}</span>}
      </div>
      <div className="ohf-shell" data-sidebar={sidebar}>
        <Sidebar
          ref={sidebarRef}
          viewer={viewer}
          keyConfigured={keyConfigured}
          busy={busy}
          workspace={workspace}
          projectId={projectId}
          onProject={switchProject}
          onWorkspaceChanged={() => void loadWorkspace()}
          view={view}
          onView={switchView}
          onTeam={openKeys}
        />

        <main className="ohf-main">
          <Topbar view={view} onView={switchView}>
            <FilterBar filters={filters} onFilters={setFilters} facets={facets} viewerId={viewer.id} />
          </Topbar>

          <Gallery
            view={view}
            surface={surface}
            items={items}
            runs={runsHere}
            freshIds={freshIds}
            picked={pickedSet}
            onOpen={openViewer}
            onPick={togglePick}
            onReuse={retry}
            onFavorite={toggleFavorite}
            onVerdict={judgeRun}
            onDownload={downloadRun}
            onDelete={deleteRun}
            onStarter={applyStarter}
            onEndReached={gallery.loadMore}
            imageTargets={imageTargets}
            videoTargets={videoTargets}
            onUse={attach}
            onRemix={remix}
            onVariants={(record) => void variants(record)}
            onUtility={runTool}
            galleryRef={galleryRef}
          />

          <Composer
            surface={surface}
            model={model}
            generating={busy}
            error={error}
            focusNonce={focusNonce}
            productId={productId}
            product={product}
            onPin={pinAsset}
            selecting={selected.length > 0}
            selection={
              <SelectionBar
                records={pickedRecords}
                saving={saving}
                onCompare={openCompare}
                onDownload={downloadSelection}
                onFavorite={favoritePicked}
                onVerdict={judgePicked}
                onDelete={deletePicked}
                onClose={clearPicked}
              />
            }
            onError={setError}
            onGenerate={runGenerate}
            notice={
              deleted && (
                <UndoBar
                  records={deleted}
                  onUndo={restoreDeleted}
                  onDismiss={dismissDeleted}
                />
              )
            }
          />
        </main>

        {viewerItem && (
          <Viewer
            item={viewerItem}
            onPrev={prevRun ? () => setViewerId(prevRun.id) : undefined}
            onNext={nextRun ? () => setViewerId(nextRun.id) : undefined}
            onClose={() => setViewerId(null)}
            onReuse={() => retry(viewerItem)}
            onFavorite={() => toggleFavorite(viewerItem)}
            onVerdict={(verdict) => judgeRun(viewerItem, verdict)}
            onNote={(note) => noteRun(viewerItem, note)}
            targets={viewerItem.kind === "video" ? videoTargets : imageTargets}
            onUse={(role) => attach(viewerItem, role)}
            onVariants={() => void variants(viewerItem)}
            onUtility={(modelId) => runTool(viewerItem, modelId)}
            downloadName={exportNameFor(viewerItem, namesFor(viewerItem.projectId), 0)}
            /* The viewer is released along with the run, so undoing the
               delete restores it to the grid and not back over the studio. */
            onDelete={() => {
              setViewerId(null);
              deleteRun(viewerItem);
            }}
          />
        )}
        {/* The live records, not a snapshot: a heart pressed in a column is
            the same favorite the grid shows. */}
        {compareOpen && canCompare(pickedRecords.length) && (
          <Compare
            items={pickedRecords}
            onClose={closeCompare}
            onFavorite={favoriteById}
            onDownload={downloadRun}
          />
        )}
        {keysOpen && (
          <TeamModal
            onClose={() => setKeysOpen(false)}
            onKeyChanged={(status: KeyStatus) => {
              setKeyConfigured(status.source !== null);
              if (status.source !== null) setError(null);
            }}
          />
        )}
        {overlay === "palette" && <CommandPalette source={paletteSource} recent={recent} onRun={runCommand} onClose={closeOverlay} />}
        {overlay === "shortcuts" && <Shortcuts onClose={closeOverlay} />}
      </div>
    </div>
  );
}

/* Deletion's receipt, in the strip the composer already reserves for the
   generation error — the studio gains no second floating layer. The hairline
   drains across the bar so the window to change your mind is visible, not
   guessed at. */
function UndoBar({
  records,
  onUndo,
  onDismiss,
}: {
  records: Tile[];
  onUndo: () => void;
  onDismiss: () => void;
}) {
  const one = records.length === 1 ? records[0] : null;
  const subject = one
    ? one.prompt
      ? `“${one.prompt}”`
      : `${one.modelLabel} run`
    : `${records.length} runs`;

  return (
    <div className="ohf-undo" role="status">
      <span
        className="ohf-undo-drain"
        style={{ animationDuration: `${UNDO_MS}ms` }}
        aria-hidden
      />
      <span className="ohf-undo-text">{`Deleted ${subject}`}</span>
      <button type="button" className="ohf-undo-act" onClick={onUndo}>
        <UndoIcon />
        Undo
      </button>
      <button
        type="button"
        className="ohf-icon-btn ohf-icon-btn--ghost"
        aria-label="Dismiss"
        onClick={onDismiss}
      >
        <CloseIcon size={12} />
      </button>
    </div>
  );
}
