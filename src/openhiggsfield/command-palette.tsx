"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import type { ModelEntry } from "@/generation/catalog";
import type { Workspace } from "@/server/project-actions";

import { SURFACE_LABELS, VIEWS, VIEW_LABELS, type GalleryView } from "./data";
import { keyCaps, modKey } from "./hotkeys";
import {
  AssetsIcon,
  CommandIcon,
  FolderIcon,
  GearIcon,
  HeartIcon,
  ImageIcon,
  KeyboardIcon,
  PlusIcon,
  SearchIcon,
  SidebarIcon,
  TemplateIcon,
  VideoIcon,
} from "./icons";
import { ModelIcon, modelIconSrc } from "./model-icon";

/* Cmd/Ctrl+K: one field that reaches everything the sidebar, the picker and
   the scope tabs reach — a project three hundred rows down, a model by name,
   a scope, the handful of actions the studio has. The list is built from the
   workspace and the catalog each time it opens, never from a list of its own:
   a model added to the catalog is in here the same moment. */

export type PaletteAction = "new-project" | "new-product" | "toggle-sidebar" | "team" | "shortcuts" | "templates";

export type PaletteCommand =
  | { type: "project"; id: string }
  | { type: "product"; id: string }
  | { type: "model"; id: string }
  | { type: "scope"; view: GalleryView }
  | { type: "action"; action: PaletteAction };

export type PaletteKind = PaletteCommand["type"];

export type PaletteItem = {
  /** Unique across the list; doubles as the option's DOM id. */
  id: string;
  kind: PaletteKind;
  label: string;
  /** What the label belongs to — a project's product, a model's surface —
      searched with the label and, for a project, drawn before it. */
  parent?: string;
  /** The right-hand word: what kind of thing this is, or where it leads. */
  hint: string;
  /** The keys that do the same thing without the palette, if any. */
  keys?: string;
  /** The one in force right now: the current project, model or scope. */
  current: boolean;
  command: PaletteCommand;
};

/** The order kinds rank in when a query scores two items alike, and the
    order the empty palette lists its sections in. */
const KIND_ORDER: readonly PaletteKind[] = ["project", "product", "model", "scope", "action"];

export type PaletteSource = {
  workspace: Workspace | null;
  /** The catalog as the composer sees it — MODELS, or a subset under test. */
  models: readonly ModelEntry[];
  projectId: string | null;
  modelId: string;
  view: GalleryView;
  sidebar: "open" | "rail";
  /** Whether a template library is wired in; without one the row is absent
      rather than dead. */
  templates: boolean;
};

/** Everything the palette can do, unranked. Projects and products come from
    the workspace, models from the catalog, scopes from the view list, and the
    actions are the few the studio has. */
export function paletteItems(source: PaletteSource): PaletteItem[] {
  const items: PaletteItem[] = [];
  const currentProduct = source.workspace?.products.find((product) =>
    product.projects.some((project) => project.id === source.projectId),
  );
  for (const product of source.workspace?.products ?? []) {
    const open = product.projects.filter((project) => project.status === "active");
    for (const project of open) {
      items.push({
        id: `project:${project.id}`,
        kind: "project",
        label: project.name,
        parent: product.name,
        hint: "Project",
        current: project.id === source.projectId,
        command: { type: "project", id: project.id },
      });
    }
    items.push({
      id: `product:${product.id}`,
      kind: "product",
      label: product.name,
      hint: `Product · ${open.length} ${open.length === 1 ? "project" : "projects"}`,
      current: product.id === currentProduct?.id,
      command: { type: "product", id: product.id },
    });
  }
  for (const model of source.models) {
    items.push({
      id: `model:${model.id}`,
      kind: "model",
      label: model.label,
      parent: SURFACE_LABELS[model.surface],
      hint: `${SURFACE_LABELS[model.surface]} model`,
      current: model.id === source.modelId,
      command: { type: "model", id: model.id },
    });
  }
  for (const view of VIEWS) {
    items.push({
      id: `scope:${view}`,
      kind: "scope",
      label: VIEW_LABELS[view],
      hint: "Scope",
      current: view === source.view,
      command: { type: "scope", view },
    });
  }
  const action = (action: PaletteAction, label: string, hint: string, keys?: string): PaletteItem => ({
    id: `action:${action}`,
    kind: "action",
    label,
    hint,
    ...(keys ? { keys } : {}),
    current: false,
    command: { type: "action", action },
  });
  items.push(action("new-project", "New project…", currentProduct ? `in ${currentProduct.name}` : "Action"));
  items.push(action("new-product", "New product…", "Action"));
  items.push(action("toggle-sidebar", source.sidebar === "open" ? "Fold the sidebar" : "Open the sidebar", "Action", "["));
  items.push(action("team", "Team & spend", "Members, key, credits"));
  items.push(action("shortcuts", "Keyboard shortcuts", "Action", "?"));
  if (source.templates) items.push(action("templates", "Templates", "Prompt library"));
  return items;
}

/** How well an item answers a query, lower is better; null when it does not.
    Every word typed has to land somewhere in the label or its parent, and the
    rank comes from where the first word lands: the label's own start, a word
    of it, anywhere in it, then the parent. */
export function paletteScore(item: PaletteItem, query: string): number | null {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return 0;
  const label = item.label.toLowerCase();
  const parent = (item.parent ?? "").toLowerCase();
  const haystack = `${parent} ${label}`;
  if (!words.every((word) => haystack.includes(word))) return null;
  const first = words[0]!;
  if (label.startsWith(first)) return 0;
  if (label.split(/\s+/).some((part) => part.startsWith(first))) return 1;
  if (label.includes(first)) return 2;
  if (parent.startsWith(first)) return 3;
  return 4;
}

/** A section of the list, headed or not. */
export type PaletteSection = { title: string | null; items: PaletteItem[] };

/** Room enough for every plausible query; a team with a thousand projects
    types one more letter rather than scrolling past the cap. */
export const PALETTE_CAP = 50;

/** The list as drawn. With nothing typed it is a landing: the projects opened
    lately, the scopes, the actions — the catalog waits for a letter, since
    thirty model rows are noise until one is wanted. Typed, it is one ranked
    list: by score, then by kind, then by the order the source gave. */
export function paletteSections(items: readonly PaletteItem[], query: string, recent: readonly string[]): PaletteSection[] {
  if (query.trim() === "") {
    const byId = new Map(items.map((item) => [item.id, item]));
    const recents = recent.map((id) => byId.get(`project:${id}`)).filter((item): item is PaletteItem => item !== undefined);
    const sections: PaletteSection[] = [];
    if (recents.length) sections.push({ title: "Recent", items: recents });
    sections.push({ title: "Scopes", items: items.filter((item) => item.kind === "scope") });
    sections.push({ title: "Actions", items: items.filter((item) => item.kind === "action") });
    return sections;
  }
  const ranked = items
    .map((item, index) => ({ item, index, score: paletteScore(item, query) }))
    .filter((entry): entry is { item: PaletteItem; index: number; score: number } => entry.score !== null)
    .sort(
      (a, b) =>
        a.score - b.score || KIND_ORDER.indexOf(a.item.kind) - KIND_ORDER.indexOf(b.item.kind) || a.index - b.index,
    )
    .slice(0, PALETTE_CAP)
    .map((entry) => entry.item);
  return [{ title: `${ranked.length} ${ranked.length === 1 ? "result" : "results"}`, items: ranked }];
}

const SCOPE_ICONS: Record<GalleryView, () => ReactNode> = {
  image: () => <ImageIcon size={14} />,
  video: () => <VideoIcon size={14} />,
  assets: () => <AssetsIcon size={14} />,
  favorites: () => <HeartIcon size={13} />,
};

const ACTION_ICONS: Record<PaletteAction, () => ReactNode> = {
  "new-project": () => <PlusIcon size={13} />,
  "new-product": () => <PlusIcon size={13} />,
  "toggle-sidebar": () => <SidebarIcon size={14} />,
  team: () => <GearIcon size={14} />,
  shortcuts: () => <KeyboardIcon size={14} />,
  templates: () => <TemplateIcon size={14} />,
};

function iconFor(item: PaletteItem): ReactNode {
  switch (item.command.type) {
    case "project":
      return <FolderIcon size={14} />;
    case "product":
      return <FolderIcon size={14} />;
    case "model":
      return modelIconSrc(item.command.id) ? <ModelIcon modelId={item.command.id} size={15} /> : <CommandIcon size={13} />;
    case "scope":
      return SCOPE_ICONS[item.command.view]();
    case "action":
      return ACTION_ICONS[item.command.action]();
  }
}

export function CommandPalette({
  source,
  recent,
  onRun,
  onClose,
}: {
  source: PaletteSource;
  /** Project ids, newest first: the landing list's first section. */
  recent: readonly string[];
  /** The palette has already closed itself by the time this is called. */
  onRun: (command: PaletteCommand) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  /* Mounted only on a key press, so the visitor's own modifier is known at
     first render — nothing here was server-drawn. */
  const [mod] = useState(() => modKey());

  const items = useMemo(() => paletteItems(source), [source]);
  const sections = useMemo(() => paletteSections(items, query, recent), [items, query, recent]);
  const flat = useMemo(() => sections.flatMap((section) => section.items), [sections]);
  const activeItem = flat[Math.min(active, flat.length - 1)] ?? null;

  /* Opened as a modal: focus is trapped inside, and the field takes it. What
     had focus before is handed back on the way out — unless something else
     already took it, as the sidebar's new-project field does. The opener is
     read once into a ref: React runs this effect twice in development, and a
     second read would find the palette's own field. */
  const opener = useRef<HTMLElement | null>(null);
  useEffect(() => {
    opener.current ??= document.activeElement instanceof HTMLElement ? document.activeElement : null;
    ref.current?.showModal();
    inputRef.current?.focus();
    return () => {
      if (document.activeElement === null || document.activeElement === document.body) opener.current?.focus();
    };
  }, []);

  /* A new query is a new list: the cursor returns to its first line. */
  useEffect(() => {
    setActive(0);
  }, [query]);

  useEffect(() => {
    if (!activeItem) return;
    document.getElementById(`ohf-palette-${activeItem.id}`)?.scrollIntoView({ block: "nearest" });
  }, [activeItem]);

  const run = (item: PaletteItem) => {
    onClose();
    onRun(item.command);
  };

  return (
    <dialog
      ref={ref}
      className="ohf-palette"
      aria-label="Command palette"
      onClose={onClose}
      /* Escape would close the dialog outright; routed through onClose so the
         parent drops it in one step. */
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === ref.current) onClose();
      }}
    >
      <div className="ohf-dialog-panel ohf-palette-panel">
        <div className="ohf-picker-head ohf-palette-head">
          <span className="ohf-picker-search-ic" aria-hidden>
            <SearchIcon size={16} />
          </span>
          <input
            ref={inputRef}
            className="ohf-picker-input"
            role="combobox"
            aria-expanded="true"
            aria-controls="ohf-palette-list"
            aria-activedescendant={activeItem ? `ohf-palette-${activeItem.id}` : undefined}
            aria-autocomplete="list"
            aria-label="Jump to a project, switch model, run an action"
            placeholder="Jump to a project, switch model, run an action…"
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setActive((index) => Math.min(index + 1, Math.max(flat.length - 1, 0)));
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setActive((index) => Math.max(index - 1, 0));
              } else if (event.key === "Enter") {
                event.preventDefault();
                if (activeItem) run(activeItem);
              }
            }}
          />
          <kbd className="ohf-kbd ohf-palette-esc" aria-hidden>
            Esc
          </kbd>
        </div>

        <div id="ohf-palette-list" role="listbox" aria-label="Commands" className="ohf-picker-list ohf-scroll ohf-palette-list">
          {flat.length === 0 && (
            <div className="ohf-picker-empty">
              <span className="ohf-picker-empty-ic">
                <SearchIcon size={15} />
              </span>
              <span className="ohf-picker-empty-title">Nothing matches “{query.trim()}”</span>
              <span className="ohf-picker-empty-hint">Projects, products, models, scopes and actions all answer here.</span>
            </div>
          )}
          {sections.map((section) => (
            <div key={section.title ?? "list"} className="ohf-palette-section" role="presentation">
              {section.title && (
                <div className="ohf-pop-head ohf-picker-group" role="presentation">
                  {section.title}
                </div>
              )}
              {section.items.map((item) => {
                const selected = activeItem?.id === item.id;
                return (
                  /* Options, not buttons: the field holds focus and the
                     listbox is read through aria-activedescendant, so a row
                     is a target for the pointer and a line for the reader. */
                  <div
                    key={item.id}
                    id={`ohf-palette-${item.id}`}
                    role="option"
                    aria-selected={selected}
                    className="ohf-palette-row"
                    data-kind={item.kind}
                    data-current={item.current || undefined}
                    onMouseMove={() => {
                      const index = flat.indexOf(item);
                      if (index >= 0 && index !== active) setActive(index);
                    }}
                    onClick={() => run(item)}
                  >
                    <span className="ohf-palette-ic" aria-hidden>
                      {iconFor(item)}
                    </span>
                    <span className="ohf-palette-text">
                      {item.kind === "project" && item.parent && <span className="ohf-palette-parent">{item.parent} ›</span>}
                      <span className="ohf-palette-label">{item.label}</span>
                    </span>
                    {item.current && <span className="ohf-palette-now">Current</span>}
                    {item.keys ? (
                      <span className="ohf-palette-keys" aria-label={`Shortcut ${keyCaps(item.keys, mod).join(" ")}`}>
                        {keyCaps(item.keys, mod).map((cap) => (
                          <kbd key={cap} className="ohf-kbd">
                            {cap}
                          </kbd>
                        ))}
                      </span>
                    ) : (
                      <span className="ohf-palette-kind">{item.hint}</span>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>

        <div className="ohf-palette-foot" aria-hidden>
          <span>
            <kbd className="ohf-kbd">↑</kbd>
            <kbd className="ohf-kbd">↓</kbd> move
          </span>
          <span>
            <kbd className="ohf-kbd">Enter</kbd> open
          </span>
          <span>
            <kbd className="ohf-kbd">{mod}</kbd>
            <kbd className="ohf-kbd">K</kbd> close
          </span>
        </div>
      </div>
    </dialog>
  );
}
