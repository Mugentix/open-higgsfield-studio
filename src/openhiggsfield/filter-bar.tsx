"use client";

import { useEffect, useRef, useState } from "react";

import { ALL_MODELS } from "@/generation/catalog";

import { VERDICT_FILTERS, VERDICT_FILTER_LABELS, type VerdictFilter } from "./data";
import { hotkeysQuiet, modKey } from "./hotkeys";
import { CaretDownIcon, CheckIcon, CloseIcon, SearchIcon, SlidersIcon } from "./icons";

export type Filters = {
  q: string;
  modelIds: string[];
  userIds: string[];
  /** One verdict, or the runs without one; null is every run. */
  verdict: VerdictFilter | null;
};

export const EMPTY_FILTERS: Filters = { q: "", modelIds: [], userIds: [], verdict: null };

export type Facets = {
  authors: Array<{ id: string; name: string }>;
  models: Array<{ modelId: string; count: number }>;
  /** How many runs of the project carry each call, and how many none. */
  verdicts: Record<VerdictFilter, number>;
};

/* The wall's controls: what you are looking for (words), how the team called
   it, and who or which model made it. Where you are — product and project —
   is the sidebar's. Filters run on the server, so a team's whole history
   answers as fast as this session's. */
export function FilterBar({
  filters,
  onFilters,
  facets,
  viewerId,
}: {
  filters: Filters;
  onFilters: (next: Filters) => void;
  facets: Facets | null;
  viewerId: string | null;
}) {
  const [draft, setDraft] = useState(filters.q);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const flagRef = useRef<HTMLButtonElement>(null);
  /* Whether the panel has been open at all: the restore below must not fire
     on mount and pull focus to the button on arrival. */
  const wasOpen = useRef(false);
  /* The placeholder names the two keys that reach further than this field:
     "/" lands the caret here, the chord opens the palette. The modifier is
     the visitor's, read after mount so the hydrating markup matches. */
  const [mod, setMod] = useState<string>("⌘");
  useEffect(() => {
    setMod(modKey());
  }, []);

  /* Typing filters after a beat, not per keystroke: each query is a round trip. */
  useEffect(() => {
    const timer = setTimeout(() => {
      if (draft.trim() !== filters.q) onFilters({ ...filters, q: draft.trim() });
    }, 250);
    return () => clearTimeout(timer);
  }, [draft, filters, onFilters]);

  /* "/" hands the caret to search — from the wall, never from another field,
     and never from behind a dialog, where the field it would reach is hidden. */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "/" && !hotkeysQuiet(event)) {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  /* The panel opens on the choice in force, as the settings panels do, and
     Escape from inside it hands focus back to the button that opened it. A
     pointer that landed elsewhere already chose. */
  useEffect(() => {
    if (open) {
      wasOpen.current = true;
      wrapRef.current?.querySelector<HTMLElement>('[role="dialog"] [aria-pressed="true"]')?.focus();
      return;
    }
    if (!wasOpen.current) return;
    const active = document.activeElement;
    if (active === null || active === document.body) flagRef.current?.focus();
  }, [open]);

  const active = filters.modelIds.length + filters.userIds.length + (filters.verdict ? 1 : 0);
  const toggle = (key: "modelIds" | "userIds", id: string) => {
    const list = filters[key];
    onFilters({ ...filters, [key]: list.includes(id) ? list.filter((x) => x !== id) : [...list, id] });
  };
  /* The verdict is one choice, not a set: pressing the one in force lets go. */
  const pickVerdict = (verdict: VerdictFilter | null) => {
    onFilters({ ...filters, verdict: filters.verdict === verdict ? null : verdict });
  };
  /* The wall can hold runs of an entry the picker no longer offers — a gated
     route — and the facet still names it rather than showing its id. */
  const labelOf = (modelId: string) => ALL_MODELS.find((m) => m.id === modelId)?.label ?? modelId;

  return (
    <div className="ohf-bar ohf-enter-1 ohf-filters">
      <label className="ohf-search">
        <SearchIcon size={14} />
        <input
          ref={searchRef}
          className="ohf-search-input"
          /* The wrapping label holds only the glyph, and the placeholder
             carries key hints the name should not. */
          aria-label="Search prompts"
          placeholder={`Search prompts  /  ·  ${mod}K`}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              setDraft("");
              (event.target as HTMLInputElement).blur();
            }
          }}
        />
        {draft && (
          <button type="button" className="ohf-icon-btn ohf-icon-btn--ghost" aria-label="Clear search" onClick={() => setDraft("")}>
            <CloseIcon size={11} />
          </button>
        )}
      </label>

      <div className="ohf-switch" ref={wrapRef}>
        <button
          ref={flagRef}
          type="button"
          className="ohf-ctl ohf-ctl--flag"
          aria-pressed={active > 0}
          aria-expanded={open}
          aria-haspopup="dialog"
          title="Filter by verdict, model or member"
          onClick={() => setOpen((v) => !v)}
        >
          <SlidersIcon />
          <span className="ohf-ctl-value">{active > 0 ? `Filters · ${active}` : "Filters"}</span>
          <CaretDownIcon />
        </button>
        {open && (
          <div className="ohf-popover ohf-popover--list ohf-popover--down ohf-filter-pop" role="dialog" aria-label="Filters">
            <div className="ohf-opts ohf-scroll">
              {viewerId && (
                <>
                  <div className="ohf-field-label ohf-filter-head">Made by</div>
                  <button
                    type="button"
                    className="ohf-opt"
                    aria-pressed={filters.userIds.length === 1 && filters.userIds[0] === viewerId}
                    onClick={() =>
                      onFilters({ ...filters, userIds: filters.userIds.length === 1 && filters.userIds[0] === viewerId ? [] : [viewerId] })
                    }
                  >
                    <span className="ohf-opt-label">Me</span>
                    {filters.userIds.length === 1 && filters.userIds[0] === viewerId && (
                      <span className="ohf-opt-check" aria-hidden>
                        <CheckIcon size={12} />
                      </span>
                    )}
                  </button>
                  {facets?.authors
                    .filter((author) => author.id !== viewerId)
                    .map((author) => (
                      <button
                        key={author.id}
                        type="button"
                        className="ohf-opt"
                        aria-pressed={filters.userIds.includes(author.id)}
                        onClick={() => toggle("userIds", author.id)}
                      >
                        <span className="ohf-opt-label">{author.name}</span>
                        {filters.userIds.includes(author.id) && (
                          <span className="ohf-opt-check" aria-hidden>
                            <CheckIcon size={12} />
                          </span>
                        )}
                      </button>
                    ))}
                </>
              )}

              {/* The team's calls: which creative won, what is still out, what
                  was put down — and what nobody has judged yet. The counts are
                  the project's, so an empty facet is stated rather than found. */}
              <div className="ohf-field-label ohf-filter-head">Verdict</div>
              <button type="button" className="ohf-opt" aria-pressed={filters.verdict === null} onClick={() => pickVerdict(null)}>
                <span className="ohf-opt-label">All</span>
                {filters.verdict === null && (
                  <span className="ohf-opt-check" aria-hidden>
                    <CheckIcon size={12} />
                  </span>
                )}
              </button>
              {VERDICT_FILTERS.map((verdict) => (
                <button
                  key={verdict}
                  type="button"
                  className="ohf-opt"
                  aria-pressed={filters.verdict === verdict}
                  onClick={() => pickVerdict(verdict)}
                >
                  <span className="ohf-opt-label">{VERDICT_FILTER_LABELS[verdict]}</span>
                  {facets && <span className="ohf-menu-count">{facets.verdicts[verdict] ?? 0}</span>}
                  {filters.verdict === verdict && (
                    <span className="ohf-opt-check" aria-hidden>
                      <CheckIcon size={12} />
                    </span>
                  )}
                </button>
              ))}

              <div className="ohf-field-label ohf-filter-head">Model</div>
              {(facets?.models ?? []).map((entry) => (
                <button
                  key={entry.modelId}
                  type="button"
                  className="ohf-opt"
                  aria-pressed={filters.modelIds.includes(entry.modelId)}
                  onClick={() => toggle("modelIds", entry.modelId)}
                >
                  <span className="ohf-opt-label">{labelOf(entry.modelId)}</span>
                  <span className="ohf-menu-count">{entry.count}</span>
                  {filters.modelIds.includes(entry.modelId) && (
                    <span className="ohf-opt-check" aria-hidden>
                      <CheckIcon size={12} />
                    </span>
                  )}
                </button>
              ))}
              {facets && facets.models.length === 0 && <div className="ohf-keys-copy">Nothing generated in this project yet.</div>}
              {active > 0 && (
                <button
                  type="button"
                  className="ohf-opt ohf-switch-new"
                  onClick={() => onFilters({ ...filters, modelIds: [], userIds: [], verdict: null })}
                >
                  <CloseIcon size={11} />
                  <span className="ohf-opt-label">Clear filters</span>
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
