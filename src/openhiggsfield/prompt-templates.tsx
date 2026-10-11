"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { create } from "zustand";

import type { Surface } from "@/generation/catalog";
import { createTemplate, deleteTemplate, listTemplates, useTemplate as recordTemplateUse } from "@/server/template-actions";
import type { PromptTemplate } from "@/server/templates";

import { CloseIcon, PlusIcon, SearchIcon, TrashIcon } from "./icons";
import {
  STARTER_TEMPLATES,
  TEMPLATE_LIMITS,
  TEMPLATE_SURFACES,
  TEMPLATE_SURFACE_LABELS,
  fillTemplate,
  isReservedVariable,
  matchesTemplate,
  oneLine,
  parseTags,
  reservedValues,
  variableLabel,
  variablesOf,
  type ProductBrief,
  type StarterTemplate,
  type TemplateSurface,
} from "./templates";

/* The palette opens the panel from outside the composer. A counter rather
   than a flag: every press is a fresh request, and the composer, which owns
   the anchor the panel opens off, decides where it lands. */
type TemplatesRequest = { nonce: number; open: () => void };

export const useTemplatesRequest = create<TemplatesRequest>()((set) => ({
  nonce: 0,
  open: () => set((state) => ({ nonce: state.nonce + 1 })),
}));

/** Open the composer's Templates panel from anywhere — the palette's "Templates". */
export function openTemplates(): void {
  useTemplatesRequest.getState().open();
}

type Group = "product" | "team" | "starter";

const GROUP_LABELS: Record<Group, string> = {
  product: "This product",
  team: "Team",
  starter: "Starter pack",
};

/** One row of the list: a saved template, or a starter not yet in the library
    (no id, nothing to count). */
type Row = {
  key: string;
  id: string | null;
  group: Group;
  title: string;
  body: string;
  tags: readonly string[];
  surface: TemplateSurface;
  uses: number;
};

/* What the panel shows in place of the list: the fill form for a row whose
   variables the product could not answer, or the form that saves the prompt. */
type Mode =
  | { kind: "list" }
  | { kind: "fill"; row: Row; append: boolean; names: string[]; values: Record<string, string> }
  | { kind: "save" };

const LIST: Mode = { kind: "list" };

/** How long a pressed trash waits for its second press. */
const ARM_MS = 3000;

function rowOf(template: PromptTemplate): Row {
  return {
    key: template.id,
    id: template.id,
    group: template.productId === null ? "team" : "product",
    title: template.title,
    body: template.body,
    tags: template.tags,
    surface: template.surface,
    uses: template.uses,
  };
}

function starterRow(starter: StarterTemplate, index: number): Row {
  return { key: `starter:${index}`, id: null, group: "starter", ...starter, uses: 0 };
}

/** The team's prompt library, off the control at the prompt's end. A row
    pressed lands in the prompt — the product answers its own variables, the
    fill form asks the rest — and the current prompt can be saved as a row.
    Search leads, as in the model picker; the starter pack stands in for an
    empty library until the team has its own. */
export function TemplatesPopover({
  surface,
  productId,
  product,
  prompt,
  onInsert,
  onClose,
}: {
  surface: Surface;
  /** The product the composer is in: its templates join the team's. */
  productId: string | null;
  /** The same product's brief, for the reserved variables. Absent, they are
      asked for like any other. */
  product: ProductBrief | null;
  /** The prompt as it stands: what Save keeps, and what Shift appends to. */
  prompt: string;
  onInsert: (text: string, append: boolean) => void;
  onClose: () => void;
}) {
  const [templates, setTemplates] = useState<PromptTemplate[] | null>(null);
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<Mode>(LIST);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  /* A delete asks twice: the first press arms the trash, the second removes.
     The arm falls back on its own so a stray press never lingers. */
  const [armed, setArmed] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    let live = true;
    void listTemplates({ productId: productId ?? undefined }).then((result) => {
      if (!live) return;
      if (result.ok) setTemplates(result.data);
      else setError(result.error);
    });
    return () => {
      live = false;
    };
  }, [productId]);

  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(null), ARM_MS);
    return () => clearTimeout(timer);
  }, [armed]);

  /* The library cut by the query and stood in groups. Within a group the rows
     that fit this surface come first and the server's newest-first order holds
     under that; a template for the other surface is still words, so it is
     listed, only dimmer. The starter pack appears while the library is empty. */
  const groups = useMemo(() => {
    const fit = (row: Row) => (row.surface === surface || row.surface === "any" ? 0 : 1);
    const saved = (templates ?? [])
      .map(rowOf)
      .filter((row) => matchesTemplate(row, query))
      .sort((a, b) => fit(a) - fit(b));
    const out: Array<{ group: Group; rows: Row[] }> = [];
    for (const group of ["product", "team"] as const) {
      const rows = saved.filter((row) => row.group === group);
      if (rows.length) out.push({ group, rows });
    }
    if (templates && templates.length === 0) {
      const rows = STARTER_TEMPLATES.map(starterRow).filter((row) => matchesTemplate(row, query));
      if (rows.length) out.push({ group: "starter", rows });
    }
    return out;
  }, [templates, query, surface]);

  const flat = useMemo(() => groups.flatMap((entry) => entry.rows), [groups]);
  const fits = (row: Row) => row.surface === surface || row.surface === "any";

  function note(message: string) {
    setError(null);
    setStatus(message);
  }

  /** A row pressed: the product answers what it can; anything left is asked. */
  function pick(row: Row, append: boolean) {
    const known = reservedValues(product);
    const names = variablesOf(row.body).filter((name) => !(isReservedVariable(name) && known[name] !== undefined));
    if (names.length === 0) {
      commit(row, fillTemplate(row.body, known), append);
      return;
    }
    setMode({ kind: "fill", row, append, names, values: Object.fromEntries(names.map((name) => [name, ""])) });
  }

  /** The words land in the prompt, and a saved template counts one more use —
      a cosmetic count the panel need not wait on. */
  function commit(row: Row, text: string, append: boolean) {
    onInsert(text, append);
    if (row.id) void recordTemplateUse({ id: row.id });
    onClose();
  }

  function onFill(event: FormEvent) {
    event.preventDefault();
    if (mode.kind !== "fill") return;
    /* A field left blank keeps its braces in the prompt, where it can be seen
       and finished, rather than vanishing into nothing. */
    const typed = Object.fromEntries(Object.entries(mode.values).filter(([, value]) => value.trim().length > 0));
    commit(mode.row, fillTemplate(mode.row.body, { ...reservedValues(product), ...typed }), mode.append);
  }

  async function remove(row: Row) {
    if (!row.id) return;
    if (armed !== row.key) {
      setArmed(row.key);
      return;
    }
    setArmed(null);
    const result = await deleteTemplate({ id: row.id });
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setTemplates((prev) => prev?.filter((template) => template.id !== row.id) ?? prev);
    note(`Removed “${row.title}”`);
  }

  /** The starter pack, copied into the team's library in one press. */
  async function addStarters() {
    setBusy(true);
    const results = await Promise.all(STARTER_TEMPLATES.map((starter) => createTemplate({ ...starter, productId: null })));
    setBusy(false);
    const failed = results.find((result) => !result.ok);
    if (failed && !failed.ok) setError(failed.error);
    const listed = await listTemplates({ productId: productId ?? undefined });
    if (listed.ok) setTemplates(listed.data);
    if (!failed) note(`${STARTER_TEMPLATES.length} starters added to the team library`);
  }

  /* Arrow keys walk the rows; the search field sits above the first, so Up
     from it returns to the words and Down from the field enters the list. */
  function onListKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const rows = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("[data-tpl-row]"));
    const index = rows.indexOf(document.activeElement as HTMLElement);
    if (index < 0) return;
    let to = -1;
    if (event.key === "ArrowDown") to = Math.min(rows.length - 1, index + 1);
    else if (event.key === "ArrowUp") {
      if (index === 0) {
        event.preventDefault();
        inputRef.current?.focus();
        return;
      }
      to = index - 1;
    } else if (event.key === "Home") to = 0;
    else if (event.key === "End") to = rows.length - 1;
    if (to < 0) return;
    event.preventDefault();
    rows[to]?.focus();
  }

  function onSearchKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      listRef.current?.querySelector<HTMLElement>("[data-tpl-row]")?.focus();
      return;
    }
    /* Enter on the words takes the first match: type, press, done. */
    if (event.key === "Enter" && flat[0]) {
      event.preventDefault();
      pick(flat[0], event.shiftKey);
    }
  }

  const hasPrompt = prompt.trim().length > 0;

  return (
    <div className="ohf-popover ohf-popover--templates" role="dialog" aria-label="Templates">
      {mode.kind === "list" && (
        <>
          <div className="ohf-picker-head">
            <span className="ohf-picker-search-ic" aria-hidden>
              <SearchIcon size={16} />
            </span>
            <input
              ref={inputRef}
              className="ohf-picker-input"
              value={query}
              placeholder="Search templates"
              aria-label="Search templates"
              onChange={(event) => {
                setQuery(event.target.value);
                if (listRef.current) listRef.current.scrollTop = 0;
              }}
              onKeyDown={onSearchKeyDown}
            />
            <button
              type="button"
              className="ohf-icon-btn ohf-icon-btn--ghost ohf-picker-close"
              aria-label="Close"
              title="Close"
              onClick={onClose}
            >
              <CloseIcon size={13} />
            </button>
          </div>

          <div className="ohf-tpl-list ohf-scroll" ref={listRef} onKeyDown={onListKeyDown}>
            {templates === null && !error && (
              <p className="ohf-tpl-status" role="status">
                Loading…
              </p>
            )}

            {templates !== null && flat.length === 0 && (
              <div className="ohf-picker-empty">
                <span className="ohf-picker-empty-ic">
                  <SearchIcon size={15} />
                </span>
                <span className="ohf-picker-empty-title">No template matches “{query.trim()}”</span>
                <span className="ohf-picker-empty-hint">Titles, bodies and tags are all searched.</span>
                <button
                  type="button"
                  className="ohf-btn-solid"
                  onClick={() => {
                    setQuery("");
                    inputRef.current?.focus();
                  }}
                >
                  Clear search
                </button>
              </div>
            )}

            {groups.map(({ group, rows }) => (
              <div key={group} role="group" aria-label={GROUP_LABELS[group]}>
                <div className="ohf-pop-head ohf-tpl-group">
                  <span>
                    {GROUP_LABELS[group]} · {rows.length}
                  </span>
                  {group === "starter" && (
                    <button
                      type="button"
                      className="ohf-tpl-group-action"
                      disabled={busy}
                      title="Copy every starter into the team's library, where they can be edited"
                      onClick={() => void addStarters()}
                    >
                      <PlusIcon size={11} />
                      {busy ? "Adding…" : "Add all to the library"}
                    </button>
                  )}
                </div>
                {rows.map((row) => (
                  <div key={row.key} className="ohf-tpl-row" data-fit={fits(row)}>
                    <button
                      type="button"
                      className="ohf-tpl-main"
                      data-tpl-row
                      title={row.body}
                      onClick={(event) => pick(row, event.shiftKey)}
                      onKeyDown={(event) => {
                        if (event.key === "Delete" && row.id) {
                          event.preventDefault();
                          void remove(row);
                        }
                      }}
                    >
                      <span className="ohf-tpl-title">{row.title}</span>
                      <span className="ohf-tpl-preview">{oneLine(row.body)}</span>
                      <span className="ohf-tpl-meta">
                        <span className="ohf-tpl-surface">{TEMPLATE_SURFACE_LABELS[row.surface]}</span>
                        {row.tags.map((tag) => (
                          <span key={tag} className="ohf-tpl-tag">
                            {tag}
                          </span>
                        ))}
                        {row.uses > 0 && (
                          <span className="ohf-tpl-uses">
                            {row.uses} {row.uses === 1 ? "use" : "uses"}
                          </span>
                        )}
                      </span>
                    </button>
                    {row.id && (
                      <button
                        type="button"
                        className="ohf-tpl-del"
                        data-armed={armed === row.key}
                        aria-label={armed === row.key ? `Confirm removing ${row.title}` : `Remove ${row.title}`}
                        title={armed === row.key ? "Press again to remove" : "Remove from the library"}
                        onClick={() => void remove(row)}
                        onBlur={() => setArmed((current) => (current === row.key ? null : current))}
                      >
                        {armed === row.key ? "Remove?" : <TrashIcon size={12} />}
                      </button>
                    )}
                  </div>
                ))}
              </div>
            ))}
          </div>

          {(status || error) && (
            <p className={`ohf-tpl-status${error ? " ohf-tpl-status--error" : ""}`} role={error ? "alert" : "status"}>
              {error ?? status}
            </p>
          )}

          <div className="ohf-tpl-foot">
            <span className="ohf-tpl-hint">Enter inserts · Shift+Enter appends</span>
            <span className={`ohf-tip ohf-tip--end${hasPrompt ? "" : " ohf-tpl-save-slot"}`} data-tip={hasPrompt ? undefined : "Write a prompt first"}>
              <button
                type="button"
                className="ohf-btn-solid"
                disabled={!hasPrompt}
                onClick={() => {
                  setError(null);
                  setMode({ kind: "save" });
                }}
              >
                <PlusIcon size={12} />
                Save prompt as template
              </button>
            </span>
          </div>
        </>
      )}

      {mode.kind === "fill" && (
        <FillForm
          mode={mode}
          hasProduct={product !== null}
          onChange={(name, value) => setMode({ ...mode, values: { ...mode.values, [name]: value } })}
          onBack={() => setMode(LIST)}
          onSubmit={onFill}
          onClose={onClose}
        />
      )}

      {mode.kind === "save" && (
        <SaveForm
          surface={surface}
          productId={productId}
          productName={product?.name ?? null}
          body={prompt}
          onBack={() => setMode(LIST)}
          onClose={onClose}
          onSaved={(template) => {
            setTemplates((prev) => [template, ...(prev ?? [])]);
            setMode(LIST);
            note(`Saved “${template.title}”`);
          }}
        />
      )}
    </div>
  );
}

/* One input per variable the product could not answer. Enter moves to the
   next empty field, and inserts from the last. */
function FillForm({
  mode,
  hasProduct,
  onChange,
  onBack,
  onSubmit,
  onClose,
}: {
  mode: Extract<Mode, { kind: "fill" }>;
  hasProduct: boolean;
  onChange: (name: string, value: string) => void;
  onBack: () => void;
  onSubmit: (event: FormEvent) => void;
  onClose: () => void;
}) {
  const firstRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    firstRef.current?.focus();
  }, []);

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>, index: number) {
    if (event.key !== "Enter") return;
    const inputs = Array.from(event.currentTarget.form?.querySelectorAll<HTMLInputElement>("input") ?? []);
    const next = inputs.slice(index + 1).find((input) => input.value.trim().length === 0);
    if (!next) return;
    event.preventDefault();
    next.focus();
  }

  const reserved = mode.names.filter(isReservedVariable);

  return (
    <form className="ohf-tpl-form" onSubmit={onSubmit}>
      <div className="ohf-picker-head ohf-tpl-form-head">
        <span className="ohf-tpl-form-title">Fill in “{mode.row.title}”</span>
        <button type="button" className="ohf-icon-btn ohf-icon-btn--ghost ohf-picker-close" aria-label="Close" title="Close" onClick={onClose}>
          <CloseIcon size={13} />
        </button>
      </div>
      <div className="ohf-tpl-form-body ohf-scroll">
        {mode.names.map((name, index) => (
          <label key={name} className="ohf-tpl-field">
            <span className="ohf-field-label">{variableLabel(name)}</span>
            <input
              ref={index === 0 ? firstRef : undefined}
              className="ohf-input"
              value={mode.values[name] ?? ""}
              placeholder={`{{${name}}}`}
              autoComplete="off"
              onChange={(event) => onChange(name, event.target.value)}
              onKeyDown={(event) => onKeyDown(event, index)}
            />
          </label>
        ))}
        {reserved.length > 0 && (
          <p className="ohf-tpl-form-copy">
            {hasProduct
              ? `Set ${reserved.map(variableLabel).join(" and ").toLowerCase()} once under Edit product and this is filled for you.`
              : "The product's brief fills these once the workspace has loaded."}
          </p>
        )}
        <p className="ohf-tpl-form-copy">A field left blank keeps its braces in the prompt, so nothing goes missing quietly.</p>
      </div>
      <div className="ohf-tpl-foot">
        <button type="button" className="ohf-btn-quiet" onClick={onBack}>
          Back
        </button>
        <button type="submit" className="ohf-keys-save">
          {mode.append ? "Append to prompt" : "Insert"}
        </button>
      </div>
    </form>
  );
}

/* The prompt as it stands, kept: a title, where it applies, a few tags. The
   surface defaults to the one the composer is on. */
function SaveForm({
  surface,
  productId,
  productName,
  body,
  onBack,
  onClose,
  onSaved,
}: {
  surface: Surface;
  productId: string | null;
  productName: string | null;
  body: string;
  onBack: () => void;
  onClose: () => void;
  onSaved: (template: PromptTemplate) => void;
}) {
  const [title, setTitle] = useState("");
  const [tags, setTags] = useState("");
  const [scope, setScope] = useState<"product" | "team">(productId ? "product" : "team");
  const [saveSurface, setSaveSurface] = useState<TemplateSurface>(surface);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = await createTemplate({
      title,
      body,
      tags: parseTags(tags),
      surface: saveSurface,
      productId: scope === "product" ? productId : null,
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    onSaved(result.data);
  }

  const names = variablesOf(body);

  return (
    <form className="ohf-tpl-form" onSubmit={(event) => void onSubmit(event)}>
      <div className="ohf-picker-head ohf-tpl-form-head">
        <span className="ohf-tpl-form-title">Save prompt as template</span>
        <button type="button" className="ohf-icon-btn ohf-icon-btn--ghost ohf-picker-close" aria-label="Close" title="Close" onClick={onClose}>
          <CloseIcon size={13} />
        </button>
      </div>
      <div className="ohf-tpl-form-body ohf-scroll">
        <label className="ohf-tpl-field">
          <span className="ohf-field-label">Title</span>
          <input
            ref={titleRef}
            className="ohf-input"
            value={title}
            maxLength={TEMPLATE_LIMITS.title}
            placeholder="Product hero shot"
            required
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        <label className="ohf-tpl-field">
          <span className="ohf-field-label">Tags</span>
          <input
            className="ohf-input"
            value={tags}
            placeholder="hook, ugc, before-after"
            onChange={(event) => setTags(event.target.value)}
          />
        </label>
        <div className="ohf-tpl-form-row">
          <label className="ohf-tpl-field">
            <span className="ohf-field-label">Where</span>
            <select
              className="ohf-tpl-select"
              value={scope}
              onChange={(event) => setScope(event.target.value as "product" | "team")}
            >
              {productId && <option value="product">{productName ? `Only ${productName}` : "Only this product"}</option>}
              <option value="team">Every product</option>
            </select>
          </label>
          <label className="ohf-tpl-field">
            <span className="ohf-field-label">Surface</span>
            <select
              className="ohf-tpl-select"
              value={saveSurface}
              onChange={(event) => setSaveSurface(event.target.value as TemplateSurface)}
            >
              {TEMPLATE_SURFACES.map((option) => (
                <option key={option} value={option}>
                  {TEMPLATE_SURFACE_LABELS[option]}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p className="ohf-tpl-form-copy" title={body}>
          {oneLine(body)}
        </p>
        <p className="ohf-tpl-form-copy">
          {names.length > 0
            ? `Asks for ${names.map((name) => `{{${name}}}`).join(", ")} when used.`
            : "Write {{product}}, {{offer_url}} or {{brand_notes}} in a prompt and the product fills them in; any other {{variable}} is asked for."}
        </p>
        {error && (
          <div className="ohf-alert" role="alert">
            <span className="ohf-alert-text">{error}</span>
          </div>
        )}
      </div>
      <div className="ohf-tpl-foot">
        <button type="button" className="ohf-btn-quiet" onClick={onBack}>
          Back
        </button>
        <button type="submit" className="ohf-keys-save" disabled={busy || !title.trim()}>
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
    </form>
  );
}
