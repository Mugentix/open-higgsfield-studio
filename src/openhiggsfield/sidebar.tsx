"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type Ref,
} from "react";

import { useLayout } from "@/generation/stores/layout";
import { archiveProject, createProduct, createProject, renameProject, type Workspace } from "@/server/project-actions";
import type { SpendReport } from "@/server/spend";
import { readStudio } from "./studio-read";
import { DEFAULT_SPEND_DAYS } from "@/server/spend-periods";
import type { Role } from "@/server/team";

import { VIEW_LABELS, type GalleryView } from "./data";
import { menuStep } from "./hotkeys";
import {
  AgentIcon,
  ArchiveIcon,
  AssetsIcon,
  ChevronRightIcon,
  CloseIcon,
  DotsIcon,
  GearIcon,
  HeartIcon,
  PencilIcon,
  PlusIcon,
  SearchIcon,
  SidebarIcon,
} from "./icons";
import { ProductDialog } from "./product-dialog";
import { AGENTS_ENABLED } from "@/features";

const ROLE_LABELS: Record<Role, string> = { owner: "Owner", admin: "Admin", member: "Member" };

/* The scopes that span both surfaces. They keep the ids the topbar tabs gave
   them, so the gallery panel's aria-labelledby still finds its label here. */
const LIBRARY: readonly GalleryView[] = ["assets", "favorites"];

const CREDITS = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

export type SidebarProject = { id: string; name: string; active: boolean };

export type SidebarProduct = {
  id: string;
  name: string;
  /** What the product folds to on the rail. */
  mono: string;
  /** Holds the current project. */
  active: boolean;
  projects: SidebarProject[];
};

/** The two letters a product folds to: the initials of its first two words,
    or the first two letters of a one-word name. */
export function monogram(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters = words.length >= 2 ? `${words[0]![0]}${words[1]![0]}` : (words[0] ?? "?").slice(0, 2);
  return letters.toUpperCase();
}

/** The workspace as the sidebar lists it: every product with its open
    projects, and the one holding the current project marked. Archived
    projects stay off the list whatever the workspace carries. */
export function sidebarTree(workspace: Workspace | null, projectId: string | null): SidebarProduct[] {
  return (workspace?.products ?? []).map((product) => {
    const projects = product.projects
      .filter((project) => project.status === "active")
      .map((project) => ({ id: project.id, name: project.name, active: project.id === projectId }));
    return {
      id: product.id,
      name: product.name,
      mono: monogram(product.name),
      active: projects.some((project) => project.active),
      projects,
    };
  });
}

/** Case-insensitive substring: the filter box's one rule, at both levels. */
function matches(name: string, query: string): boolean {
  return name.toLowerCase().includes(query);
}

/** The tree narrowed to a query, both levels at once. A product whose own
    name matches keeps every project; any other keeps the projects that match
    and stands only while it has one. An empty query is the whole tree. */
export function filterTree(tree: SidebarProduct[], query: string): SidebarProduct[] {
  const q = query.trim().toLowerCase();
  if (!q) return tree;
  const shown: SidebarProduct[] = [];
  for (const product of tree) {
    if (matches(product.name, q)) {
      shown.push(product);
      continue;
    }
    const projects = product.projects.filter((project) => matches(project.name, q));
    if (projects.length) shown.push({ ...product, projects });
  }
  return shown;
}

/** One line of the tree as the keyboard walks it. */
export type TreeRow =
  | { id: string; kind: "product"; productId: string }
  | { id: string; kind: "project"; productId: string; projectId: string };

/** The DOM id a row focuses by; the two kinds share one namespace. */
export function rowId(kind: TreeRow["kind"], id: string): string {
  return `${kind}:${id}`;
}

/** The rows on screen, top to bottom: every product, and under each open one
    its projects. A shut group contributes its own row alone. */
export function treeRows(tree: SidebarProduct[], expanded: (product: SidebarProduct) => boolean): TreeRow[] {
  const rows: TreeRow[] = [];
  for (const product of tree) {
    rows.push({ id: rowId("product", product.id), kind: "product", productId: product.id });
    if (!expanded(product)) continue;
    for (const project of product.projects) {
      rows.push({ id: rowId("project", project.id), kind: "project", productId: product.id, projectId: project.id });
    }
  }
  return rows;
}

/** What a key does to the tree from the row at `index`: moves focus to
    another row, toggles a product, opens a project — or nothing, and the key
    is left for whoever else listens. The APG tree pattern, less type-ahead,
    since the letter keys belong to the tiles and the filter box does the
    finding. */
export type TreeMove = { focus: number } | { toggle: string } | { open: string };

export function treeKey(rows: readonly TreeRow[], index: number, key: string, expanded: (productId: string) => boolean): TreeMove | null {
  const row = rows[index];
  if (!row) return null;
  const last = rows.length - 1;
  switch (key) {
    case "ArrowDown":
      return { focus: Math.min(index + 1, last) };
    case "ArrowUp":
      return { focus: Math.max(index - 1, 0) };
    case "Home":
      return { focus: 0 };
    case "End":
      return { focus: last };
    case "ArrowRight": {
      if (row.kind !== "product") return null;
      if (!expanded(row.productId)) return { toggle: row.productId };
      const child = rows[index + 1];
      return child?.kind === "project" && child.productId === row.productId ? { focus: index + 1 } : null;
    }
    case "ArrowLeft": {
      if (row.kind === "product") return expanded(row.productId) ? { toggle: row.productId } : null;
      const parent = rows.findIndex((entry) => entry.kind === "product" && entry.productId === row.productId);
      return parent >= 0 ? { focus: parent } : null;
    }
    case "Enter":
    case " ":
      return row.kind === "product" ? { toggle: row.productId } : { open: row.projectId };
    default:
      return null;
  }
}

export type RecentProject = { id: string; name: string; product: string; active: boolean };

/** The recents as the sidebar lists them: the ids the store remembers,
    resolved against the open projects the tree carries. An archived or
    deleted one drops out rather than standing as a blank row. */
export function recentProjects(tree: SidebarProduct[], recent: readonly string[]): RecentProject[] {
  const byId = new Map<string, RecentProject>();
  for (const product of tree) {
    for (const project of product.projects) {
      byId.set(project.id, { id: project.id, name: project.name, product: product.name, active: project.active });
    }
  }
  return recent.map((id) => byId.get(id)).filter((entry): entry is RecentProject => entry !== undefined);
}

/* One inline form at a time: a new product, a new project under one, or a
   project's new name. Typed in place, never a page away. */
type Form = { kind: "product" } | { kind: "project"; productId: string } | { kind: "rename"; projectId: string };

/** What the palette can ask the column to do: the inline forms live here, so
    "New project…" from anywhere lands on the same field the "+" opens. */
export type SidebarHandle = {
  /** A new project under the product given, or the one holding the current
      project; the column opens if it was folded and the field takes focus. */
  newProject: (productId?: string | null) => void;
  newProduct: () => void;
};

/* The left column: the team and the way into its settings, the projects
   opened lately, the products with their projects — where the next run lands
   — the scopes that span both surfaces, and what the team has spent. Folded,
   it is a rail of the same marks; the DOM is the same in both states and the
   labels step aside. Built for a team with hundreds of projects: a filter
   narrows both levels as it is typed, product groups fold shut and stay shut,
   and the whole tree is one keyboard surface. */
export function Sidebar({
  ref,
  viewer,
  keyConfigured,
  busy,
  workspace,
  projectId,
  onProject,
  onWorkspaceChanged,
  view,
  onView,
  onTeam,
}: {
  ref?: Ref<SidebarHandle>;
  viewer: { name: string; email: string; teamName: string; role: Role };
  keyConfigured: boolean;
  /** A run is in flight somewhere on the team: the lamp pulses. */
  busy: boolean;
  workspace: Workspace | null;
  projectId: string | null;
  onProject: (id: string) => void;
  onWorkspaceChanged: () => void;
  view: GalleryView;
  onView: (next: GalleryView) => void;
  onTeam: () => void;
}) {
  const sidebar = useLayout((state) => state.sidebar);
  const toggleSidebar = useLayout((state) => state.toggleSidebar);
  const collapsed = useLayout((state) => state.collapsed);
  const toggleCollapsed = useLayout((state) => state.toggleCollapsed);
  const expand = useLayout((state) => state.expand);
  const recent = useLayout((state) => state.recent);
  const open = sidebar === "open";
  /* The Agents pages share this column; their entry is current by route,
     since they are pages of their own rather than a scope of the wall. */
  const onAgents = (usePathname() ?? "").startsWith("/agents");
  const tree = useMemo(() => sidebarTree(workspace, projectId), [workspace, projectId]);
  /* Members see the list; owners and admins also put projects away. The
     action checks the role again — this only keeps a refused row off the menu. */
  const canManage = viewer.role !== "member";

  const [form, setForm] = useState<Form | null>(null);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  /* The product whose brief is open for editing — name, offer url, brand
     notes — the values a template's reserved variables fill from. */
  const [editing, setEditing] = useState<string | null>(null);
  const [spend, setSpend] = useState<SpendReport | null>(null);
  const [query, setQuery] = useState("");
  /* The one row of the tree that is in the tab order — the roving index. Null
     until a row is reached, when the current project stands in. */
  const [cursor, setCursor] = useState<string | null>(null);
  const treeRef = useRef<HTMLDivElement>(null);
  /* The "…" the open menu came off, so Escape can hand focus back to it. */
  const menuOpener = useRef<HTMLElement | null>(null);

  const q = query.trim();
  const shown = useMemo(() => filterTree(tree, q), [tree, q]);
  const recents = useMemo(() => recentProjects(tree, recent), [tree, recent]);
  /* A filter opens every group it leaves standing: a match hidden under a
     shut chevron is no match. The rail draws no projects at all, so there
     every group counts as shut and the arrows walk the products alone. */
  const isExpanded = useCallback(
    (productId: string) => open && (q !== "" || !collapsed.includes(productId)),
    [open, q, collapsed],
  );
  const rows = useMemo(() => treeRows(shown, (product) => isExpanded(product.id)), [shown, isExpanded]);
  const focusedId = useMemo(() => {
    if (cursor && rows.some((row) => row.id === cursor)) return cursor;
    return rows.find((row) => row.kind === "project" && row.projectId === projectId)?.id ?? rows[0]?.id ?? null;
  }, [cursor, rows, projectId]);

  /* The group holding the current project is never left shut: a jump from the
     palette or a recent into a folded product opens it, and so does arriving. */
  const activeProductId = useMemo(() => tree.find((product) => product.active)?.id ?? null, [tree]);
  useEffect(() => {
    if (activeProductId) expand(activeProductId);
  }, [activeProductId, projectId, expand]);

  /* The row that owns the open menu is marked, so a press on its own "…"
     toggles the menu rather than closing and reopening it. Focus enters the
     menu as it opens and returns to the "…" on Escape — the menu-button
     pattern the tiles' Use menu follows too. */
  useEffect(() => {
    if (!menuFor) return;
    treeRef.current?.querySelector<HTMLElement>('[data-menu-owner] [role="menuitem"]')?.focus();
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (target?.closest("[data-menu-owner]")) return;
      setMenuFor(null);
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setMenuFor(null);
      menuOpener.current?.focus();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menuFor]);

  /* The same window the team dialog opens on. Asked once on arrival and again
     each time the studio goes quiet, since a run that settled is a run that
     was billed. */
  useEffect(() => {
    if (busy) return;
    let live = true;
    void readStudio("spend", { days: DEFAULT_SPEND_DAYS }).then((result) => {
      if (live && result.ok) setSpend(result.data);
    });
    return () => {
      live = false;
    };
  }, [busy]);

  function begin(next: Form, initial = "") {
    setMenuFor(null);
    setError(null);
    setName(initial);
    setForm(next);
  }

  function cancel() {
    setForm(null);
    setName("");
  }

  /* The inline forms are hidden on the rail, so a request from outside opens
     the column first and clears a filter that would hide the row. */
  const openColumn = useCallback(() => {
    const layout = useLayout.getState();
    if (layout.sidebar !== "open") layout.toggleSidebar();
    setQuery("");
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      newProject: (productId) => {
        const target = productId ?? activeProductId ?? tree[0]?.id ?? null;
        if (!target) {
          openColumn();
          begin({ kind: "product" });
          return;
        }
        openColumn();
        expand(target);
        begin({ kind: "project", productId: target });
      },
      newProduct: () => {
        openColumn();
        begin({ kind: "product" });
      },
    }),
    [activeProductId, tree, openColumn, expand],
  );

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!form) return;
    setSaving(true);
    setError(null);
    const fail = (message: string) => {
      setSaving(false);
      setError(message);
    };
    let landed: string | undefined;
    if (form.kind === "product") {
      const result = await createProduct({ name });
      if (!result.ok) return fail(result.error);
      landed = result.data.projects[0]?.id;
    } else if (form.kind === "project") {
      const result = await createProject({ productId: form.productId, name });
      if (!result.ok) return fail(result.error);
      landed = result.data.id;
    } else {
      const result = await renameProject({ projectId: form.projectId, name });
      if (!result.ok) return fail(result.error);
    }
    setSaving(false);
    cancel();
    onWorkspaceChanged();
    if (landed) onProject(landed);
  }

  /* Archiving the current project leaves the studio without one; the
     workspace reload that follows lands it on the team's default. */
  async function onArchive(id: string) {
    setMenuFor(null);
    setError(null);
    const result = await archiveProject(id);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    onWorkspaceChanged();
  }

  /* A product row pressed: on the rail it opens the column, since its
     projects are what the press is after; open, it folds the group — unless a
     filter is holding every group open, when there is nothing to fold. */
  const pressProduct = useCallback(
    (productId: string) => {
      if (!open) {
        toggleSidebar();
        return;
      }
      if (q === "") toggleCollapsed(productId);
    },
    [open, q, toggleSidebar, toggleCollapsed],
  );

  const focusRow = useCallback((id: string) => {
    setCursor(id);
    treeRef.current?.querySelector<HTMLElement>(`[data-tree-id="${CSS.escape(id)}"]`)?.focus();
  }, []);

  /* The keys reach the tree from its rows alone: a "+" or "…" inside a row
     keeps Enter for its own press, and the inline form keeps the arrows for
     its caret. */
  const onTreeKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const id = (event.target as HTMLElement).dataset.treeId;
    if (!id) return;
    const index = rows.findIndex((row) => row.id === id);
    if (index < 0) return;
    const move = treeKey(rows, index, event.key, isExpanded);
    if (!move) return;
    event.preventDefault();
    if ("focus" in move) {
      const row = rows[move.focus];
      if (row) focusRow(row.id);
    } else if ("toggle" in move) {
      pressProduct(move.toggle);
    } else {
      onProject(move.open);
    }
  };

  /* Typed, then Down into the matches, or Enter straight onto the first one:
     a project three hundred rows down is a word and a key away. */
  const onFilterKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      if (query) setQuery("");
      else event.currentTarget.blur();
      return;
    }
    if (event.key === "ArrowDown" && rows[0]) {
      event.preventDefault();
      focusRow(rows[0].id);
      return;
    }
    if (event.key === "Enter" && q) {
      const first = rows.find((row) => row.kind === "project");
      if (first && first.kind === "project") onProject(first.projectId);
    }
  };

  const inlineForm = (placeholder: string) => (
    <form className="ohf-side-form" onSubmit={(event) => void onSubmit(event)}>
      <input
        className="ohf-input"
        placeholder={placeholder}
        aria-label={placeholder}
        value={name}
        autoFocus
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") cancel();
        }}
      />
      <button type="submit" className="ohf-keys-save" disabled={saving || !name.trim()}>
        {form?.kind === "rename" ? "Save" : "Add"}
      </button>
    </form>
  );

  const me = viewer.name || viewer.email;
  /* Resolved against the workspace each render: a product renamed elsewhere
     reopens under its new name, and one archived closes the dialog. */
  const editingProduct = editing ? (workspace?.products.find((product) => product.id === editing) ?? null) : null;
  const spendLine =
    spend === null
      ? "…"
      : spend.runs === 0
        ? `No spend in ${spend.days} days`
        : `${CREDITS.format(spend.total)} credits · ${spend.days} days`;

  return (
    <aside className="ohf-sidebar" aria-label="Sidebar">
      <div className="ohf-side-top">
        <button
          type="button"
          className="ohf-side-toggle"
          aria-expanded={open}
          aria-label={open ? "Collapse the sidebar" : "Expand the sidebar"}
          title={`${open ? "Collapse" : "Expand"} sidebar  [`}
          onClick={toggleSidebar}
        >
          <SidebarIcon />
        </button>
        <div className="ohf-side-team ohf-side-label">
          <span className="ohf-side-team-name">{viewer.teamName}</span>
          <span className="ohf-side-team-me">
            {keyConfigured ? `${me} · ${ROLE_LABELS[viewer.role]}` : "Add the team's KIE key"}
          </span>
        </div>
        {/* Generations run on the team's key, so the button that opens the
            team carries the lamp: steady with a key held, pulsing while a run
            is in flight — the one place in the column accent moves. */}
        <button
          type="button"
          className="ohf-side-gear"
          data-busy={busy}
          data-ready={keyConfigured}
          onClick={onTeam}
          aria-label={keyConfigured ? `${viewer.teamName} — team and key` : `${viewer.teamName} — add the KIE key`}
          title={keyConfigured ? "Team, members, key and spend" : "Add the team's KIE key"}
        >
          <GearIcon />
          <span className="ohf-lamp" />
        </button>
      </div>

      <nav className="ohf-side-body ohf-scroll" aria-label="Workspace">
        {/* Where the visitor was lately, newest first. Stands aside while a
            filter is typed: the filter is the finding then. */}
        {recents.length > 0 && q === "" && (
          <>
            <div className="ohf-side-head ohf-side-label">Recent</div>
            <div className="ohf-side-recent">
              {recents.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  className="ohf-side-item ohf-side-recent-item"
                  aria-current={entry.active ? "true" : undefined}
                  title={`${entry.product} › ${entry.name}`}
                  onClick={() => onProject(entry.id)}
                >
                  <span className="ohf-side-label">{entry.name}</span>
                  <span className="ohf-side-sub ohf-side-label">{entry.product}</span>
                </button>
              ))}
            </div>
          </>
        )}

        <div className="ohf-side-head ohf-side-label">Products</div>
        <div className="ohf-side-filter">
          <SearchIcon size={13} />
          <input
            className="ohf-side-filter-input"
            placeholder="Filter products and projects"
            aria-label="Filter products and projects"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onFilterKeyDown}
          />
          {query && (
            <button
              type="button"
              className="ohf-icon-btn ohf-icon-btn--ghost ohf-side-filter-clear"
              aria-label="Clear filter"
              onClick={() => setQuery("")}
            >
              <CloseIcon size={11} />
            </button>
          )}
        </div>

        {/* One tree, one tab stop: the arrows walk the rows, Left and Right
            fold and open a product, Enter opens a project. The row that holds
            the tab stop also lends it to its own controls, so "+" and "…" are
            a Tab away from the row they belong to and nowhere else. */}
        <div
          ref={treeRef}
          className="ohf-side-tree"
          role="tree"
          aria-label="Products and projects"
          data-filtering={q ? "" : undefined}
          onKeyDown={onTreeKeyDown}
        >
          {shown.map((product) => {
            const expanded = isExpanded(product.id);
            const productRow = rowId("product", product.id);
            const atProduct = focusedId === productRow;
            const count = product.projects.length;
            return (
              <div key={product.id} className="ohf-side-group" data-active={product.active}>
                <div
                  role="treeitem"
                  aria-expanded={expanded}
                  aria-label={`${product.name}, ${count} ${count === 1 ? "project" : "projects"}`}
                  tabIndex={atProduct ? 0 : -1}
                  data-tree-id={productRow}
                  className="ohf-side-product"
                  onClick={() => pressProduct(product.id)}
                  onFocus={() => setCursor(productRow)}
                >
                  <span className="ohf-side-chevron" aria-hidden>
                    <ChevronRightIcon />
                  </span>
                  {/* On the rail the product is its monogram, and pressing the
                      row opens the column where its projects can be picked. */}
                  <span className="ohf-side-mono" aria-hidden>
                    {product.mono}
                  </span>
                  <span className="ohf-side-product-name ohf-side-label" title={product.name}>
                    {product.name}
                  </span>
                  <span className="ohf-side-count" aria-hidden>
                    {count}
                  </span>
                  <button
                    type="button"
                    className="ohf-icon-btn ohf-icon-btn--ghost ohf-side-add"
                    tabIndex={atProduct ? 0 : -1}
                    aria-label={`New project in ${product.name}`}
                    title="New project"
                    onClick={(event) => {
                      event.stopPropagation();
                      begin({ kind: "project", productId: product.id });
                    }}
                  >
                    <PlusIcon size={12} />
                  </button>
                  <button
                    type="button"
                    className="ohf-icon-btn ohf-icon-btn--ghost ohf-side-add"
                    tabIndex={atProduct ? 0 : -1}
                    aria-label={`Edit ${product.name}`}
                    title="Edit product — name, offer URL, brand notes"
                    onClick={(event) => {
                      event.stopPropagation();
                      setMenuFor(null);
                      setEditing(product.id);
                    }}
                  >
                    <PencilIcon size={12} />
                  </button>
                </div>
                {expanded && (
                  <div role="group" className="ohf-side-projects">
                    {product.projects.map((project) => {
                      if (form?.kind === "rename" && form.projectId === project.id) {
                        return (
                          <div key={project.id} className="ohf-side-row" role="none">
                            {inlineForm("Project name")}
                          </div>
                        );
                      }
                      const projectRow = rowId("project", project.id);
                      const atProject = focusedId === projectRow;
                      return (
                        <div
                          key={project.id}
                          role="treeitem"
                          aria-selected={project.active}
                          aria-label={project.name}
                          tabIndex={atProject ? 0 : -1}
                          data-tree-id={projectRow}
                          data-menu-owner={menuFor === project.id ? "" : undefined}
                          className="ohf-side-row"
                          onClick={() => onProject(project.id)}
                          onFocus={() => setCursor(projectRow)}
                        >
                          <div className="ohf-side-item" title={project.name}>
                            <span className="ohf-side-label">{project.name}</span>
                          </div>
                          <button
                            type="button"
                            className="ohf-icon-btn ohf-icon-btn--ghost ohf-side-more"
                            tabIndex={atProject ? 0 : -1}
                            aria-label={`Options for ${project.name}`}
                            aria-haspopup="menu"
                            aria-expanded={menuFor === project.id}
                            onClick={(event) => {
                              event.stopPropagation();
                              menuOpener.current = event.currentTarget;
                              setMenuFor((current) => (current === project.id ? null : project.id));
                            }}
                          >
                            <DotsIcon size={12} />
                          </button>
                          {menuFor === project.id && (
                            <div
                              className="ohf-menu ohf-side-menu"
                              role="menu"
                              aria-label={`Options for ${project.name}`}
                              onClick={(event) => event.stopPropagation()}
                              /* The arrows walk the rows here rather than the
                                 tree behind them; Enter is the row's own press. */
                              onKeyDown={(event) => {
                                const rows = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]'));
                                const to = menuStep(rows.length, rows.indexOf(event.target as HTMLElement), event.key);
                                if (to === null) return;
                                event.preventDefault();
                                event.stopPropagation();
                                rows[to]?.focus();
                              }}
                            >
                              <button
                                type="button"
                                role="menuitem"
                                className="ohf-menu-row"
                                onClick={() => begin({ kind: "rename", projectId: project.id }, project.name)}
                              >
                                <span className="ohf-menu-ic">
                                  <PencilIcon />
                                </span>
                                <span className="ohf-menu-label">Rename</span>
                              </button>
                              {canManage && (
                                <button type="button" role="menuitem" className="ohf-menu-row" onClick={() => void onArchive(project.id)}>
                                  <span className="ohf-menu-ic">
                                    <ArchiveIcon />
                                  </span>
                                  <span className="ohf-menu-label">Archive</span>
                                </button>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
                {form?.kind === "project" && form.productId === product.id && inlineForm("Project name")}
              </div>
            );
          })}
          {q !== "" && shown.length === 0 && <div className="ohf-side-empty">No product or project matches “{q}”</div>}
        </div>
        {form?.kind === "product" ? (
          inlineForm("Product name")
        ) : (
          <button type="button" className="ohf-side-item ohf-side-new" onClick={() => begin({ kind: "product" })}>
            <PlusIcon size={12} />
            <span className="ohf-side-label">New product</span>
          </button>
        )}
        {error && (
          <div className="ohf-alert ohf-side-alert" role="alert">
            <span className="ohf-alert-text">{error}</span>
          </div>
        )}

        <div className="ohf-side-head ohf-side-label">Library</div>
        {LIBRARY.map((id) => (
          <button
            key={id}
            type="button"
            id={`ohf-tab-${id}`}
            className="ohf-side-item ohf-side-link"
            aria-pressed={view === id}
            title={VIEW_LABELS[id]}
            onClick={() => onView(id)}
          >
            {id === "assets" ? <AssetsIcon size={15} /> : <HeartIcon size={14} filled={view === "favorites"} />}
            <span className="ohf-side-label">{VIEW_LABELS[id]}</span>
          </button>
        ))}
        {/* The skill runner: a page, not a scope, so a link rather than a
            pressed button — marked current while it is the page on screen. It
            stays off the sidebar until the Agents surface is switched on. */}
        {AGENTS_ENABLED && (
          <Link
            href="/agents"
            className="ohf-side-item ohf-side-link ohf-side-agents"
            aria-current={onAgents ? "page" : undefined}
            title="Agents — run the team's skills"
          >
            <AgentIcon size={15} />
            <span className="ohf-side-label">Agents</span>
          </Link>
        )}
      </nav>

      <div className="ohf-side-foot ohf-side-label">
        <span className="ohf-side-spend" title={`Credits the team spent in the last ${DEFAULT_SPEND_DAYS} days`}>
          {spendLine}
        </span>
      </div>

      {/* The brief is a modal, so it stands over the studio wherever the
          column is; a saved brief reloads the workspace the names come from. */}
      {editingProduct && (
        <ProductDialog
          product={editingProduct}
          onClose={() => setEditing(null)}
          onSaved={onWorkspaceChanged}
        />
      )}
    </aside>
  );
}
