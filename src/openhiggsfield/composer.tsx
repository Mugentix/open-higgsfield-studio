"use client";

import { useEffect, useRef, useState } from "react";
import type { CSSProperties, DragEvent, ReactNode } from "react";

import { parseSettings } from "@/generation/catalog";
import type { ModelEntry, Surface } from "@/generation/catalog";
import { MAX_BATCH, useActive } from "@/generation/stores/active";
import { useImagePrompt, useVideoPrompt } from "@/generation/stores/prompt";
import { useSettings } from "@/generation/stores/settings";

import { swatchFor } from "./artwork";
import { AssetPicker, droppedFiles, hasFiles } from "./asset-picker";
import { PROMPT_PLACEHOLDERS, countSetting, planeConflict, roleNoun, rolesOf } from "./data";
import { underDialog } from "./hotkeys";
import { ArrowUpIcon, CaretDownIcon, CloseIcon, MinusIcon, PlusIcon, TemplateIcon, WarningIcon } from "./icons";
import { MediaStrip, useMediaTray } from "./media-tray";
import { ModelIcon, modelIconSrc } from "./model-icon";
import { ModelPicker } from "./model-picker";
import { TemplatesPopover, useTemplatesRequest } from "./prompt-templates";
import { SettingPill, SettingPopover } from "./settings";
import { insertIntoPrompt, type ProductBrief } from "./templates";

/* Overlay ids: the three fixed panels, or one setting addressed by its catalog
   key — the rail renders whatever the model declares, so the ids cannot be a
   closed union. */
const PICKER = "picker";
const ASSETS = "assets";
const TEMPLATES = "templates";
const SETTING = "setting:";

const PROMPT_MAX_HEIGHT = 168;

/* What the studio itself can deliver for a model that carries no count of its
   own: one platform request per result. */
const STUDIO_COUNTS = Array.from({ length: MAX_BATCH }, (_, index) => index + 1);

/** Breathing room between a popover and the control it opened from. */
const POPOVER_GAP = 8;

/** Declared widths keep an opening popover inside the composer's own column. */
function popoverWidth(id: string, model: ModelEntry): number {
  if (id === PICKER || id === ASSETS) return 560;
  if (id === TEMPLATES) return 480;
  /* The ratio list carries a second column of "also render in" marks. */
  if (id === `${SETTING}aspectRatio`) return 244;
  /* A list of an enum's values is the narrow panel; a slider needs its travel. */
  if (id.startsWith(SETTING) && model.settings[id.slice(SETTING.length)]?.type === "enum") {
    return 216;
  }
  return 268;
}

export function Composer({
  surface,
  model,
  generating,
  error,
  focusNonce,
  productId,
  product,
  onPin,
  notice,
  selection,
  selecting,
  onError,
  onGenerate,
}: {
  surface: Surface;
  model: ModelEntry;
  generating: boolean;
  error: string | null;
  focusNonce: number;
  /** The product the next run lands in; the picker shows its shelf. */
  productId: string | null;
  /** The same product's brief — name, offer url, brand notes — so a template's
      reserved variables fill without asking. Absent, they are asked for. */
  product?: ProductBrief | null;
  onPin: (assetId: string, pinned: boolean) => Promise<void>;
  /* Transient receipts from the gallery share the composer's banner strip
     rather than adding a floating layer of their own. */
  notice?: ReactNode;
  /* The bulk toolbar takes the composer's slot while runs are picked; it is
     always mounted so it can animate away, and states its own presence. */
  selection: ReactNode;
  selecting: boolean;
  onError: (message: string | null) => void;
  onGenerate: () => void;
}) {
  const setModel = useActive((state) => state.setModel);
  const batch = useActive((state) => state.batch);
  const setBatch = useActive((state) => state.setBatch);
  const imagePrompt = useImagePrompt();
  const videoPrompt = useVideoPrompt();
  const prompt = surface === "image" ? imagePrompt : videoPrompt;
  const settings = useSettings();
  const values = parseSettings(model, settings.byModel[model.id] ?? {});
  const tray = useMediaTray(model, onError);

  const [overlay, setOverlay] = useState<string | null>(null);
  const [anchor, setAnchor] = useState({ x: 0, y: 0 });
  const [shortcut, setShortcut] = useState<string | null>(null);
  const [dropOver, setDropOver] = useState(false);
  const dockRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const templatesRef = useRef<HTMLButtonElement>(null);
  /* The control the open panel came off, so a panel put away by Escape or
     its own close can hand focus back to it. */
  const triggerRef = useRef<HTMLElement | null>(null);
  const dropDepth = useRef(0);
  /* A utility takes no words: the one role it declares is the whole plane,
     and the press waits on that slot instead of the textarea. */
  const promptless = model.prompt === "none";
  const need = rolesOf(model)[0] ?? "reference";
  const needFilled = tray.items.some((item) => item.role === need);
  /* A run in flight is not a lock: it holds its own tile in the grid, so the
     only thing that can stop a press is having nothing to say — or, for a
     utility, nothing to work on. */
  const conflict = planeConflict(model, tray.items);
  const disabled = conflict !== null || (promptless ? !needFilled : prompt.text.trim().length === 0);
  /* The textarea owns Cmd/Ctrl+Enter; without one, the dock listens for it
     itself so a utility presses the same way a prompt does. */
  useEffect(() => {
    if (!promptless) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey) || event.repeat) return;
      if (underDialog()) return;
      event.preventDefault();
      if (!disabled) onGenerate();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [promptless, disabled, onGenerate]);

  /* One batch control, two mechanisms. A model that declares its own
     results-per-request gets that setting written; the rest are submitted once
     per result by the studio. Either way the control means "results per press",
     so the model's own count key never also appears as a settings pill. */
  const native = countSetting(model);
  const counts = native ? native.counts : STUDIO_COUNTS;
  /* A utility runs once — the studio's batch is not its dial, and the label
     says so — so the control stands down while one is chosen. */
  const batchValue = promptless ? 1 : native ? Number(values[native.key]) || counts[0]! : batch;
  const settingKeys = Object.keys(model.settings).filter((key) => key !== native?.key);

  function setBatchValue(next: number) {
    if (!native) {
      setBatch(next);
      return;
    }
    settings.set(model.id, { [native.key]: native.kind === "enum" ? String(next) : next });
  }

  /* The dock floats over the gallery, so the gallery cannot reserve its height
     from layout. It reads it from here instead, and the last row keeps clearing
     a composer that grew — a long prompt, a media strip, the undo receipt. */
  useEffect(() => {
    const dock = dockRef.current;
    if (!dock) return;
    const observer = new ResizeObserver(() => {
      dock.parentElement?.style.setProperty("--ohf-dock-h", `${dock.offsetHeight}px`);
    });
    observer.observe(dock);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!overlay) return;
    const onPointerDown = (event: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) setOverlay(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOverlay(null);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [overlay]);

  /* Auto-grow the prompt, including when text is set programmatically — and
     again when the column narrows, because the field shares its line with the
     attachment now and the same text rewraps onto more of them. Only a width
     change re-measures: reacting to the height we just set would loop. */
  useEffect(() => {
    const el = promptRef.current;
    if (!el) return;
    const grow = () => {
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, PROMPT_MAX_HEIGHT)}px`;
    };
    grow();
    let width = el.clientWidth;
    const observer = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      grow();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [prompt.text]);

  useEffect(() => {
    if (focusNonce > 0) promptRef.current?.focus();
  }, [focusNonce]);

  /* A panel anchored to a control the visitor can no longer see is a stray
     plate — the swap closes whatever the composer had open. */
  useEffect(() => {
    if (selecting) setOverlay(null);
  }, [selecting]);

  /* A panel that closes with focus inside it leaves focus on nothing; it goes
     back to the control the panel opened off. Where the prompt took it first
     — a template inserted, the words reached for — or a pointer landed on
     another control, that choice stands. */
  useEffect(() => {
    if (overlay !== null) return;
    const active = document.activeElement;
    if (active === null || active === document.body) triggerRef.current?.focus();
  }, [overlay]);

  // Rendered only after mount: the modifier is the visitor's, not the server's.
  useEffect(() => {
    setShortcut(/Mac|iP(hone|ad|od)/.test(navigator.userAgent) ? "⌘↵" : "Ctrl↵");
  }, []);

  /* The palette asks for the Templates panel from outside the composer; it
     opens off its own control here, the way a press on it would. A utility
     has no prompt to fill, so the request goes quiet. */
  const templatesNonce = useTemplatesRequest((state) => state.nonce);
  useEffect(() => {
    if (templatesNonce === 0 || promptless) return;
    const trigger = templatesRef.current;
    if (trigger && overlay !== TEMPLATES) toggle(TEMPLATES, trigger);
  }, [templatesNonce]);

  /* Popovers are positioned by the composer so the wide ones stay inside its
     column, but they open off the control that summoned them: the anchor
     travels to the trigger's left edge, clamped to the column, and rises from
     just above the trigger's own top rather than from the whole dock.
     One thing outranks the trigger: the attachments. A panel laid over the
     frames already on the plane makes the visitor choose blind, so where the
     strip is present every panel clears it. */
  function toggle(next: string, trigger: HTMLElement) {
    if (overlay === next) {
      setOverlay(null);
      return;
    }
    const wrap = wrapRef.current;
    if (!wrap) return;
    const wrapBox = wrap.getBoundingClientRect();
    const triggerBox = trigger.getBoundingClientRect();
    const strip = wrap.querySelector(".ohf-strip");
    const ceiling = strip
      ? Math.min(triggerBox.top, strip.getBoundingClientRect().top)
      : triggerBox.top;
    const available = wrap.clientWidth;
    const width = Math.min(popoverWidth(next, model), available);
    setAnchor({
      x: Math.round(Math.max(0, Math.min(triggerBox.left - wrapBox.left, available - width))),
      y: Math.round(wrapBox.bottom - ceiling + POPOVER_GAP),
    });
    triggerRef.current = trigger;
    setOverlay(next);
  }

  const attachLabel = tray.allFull ? "Change the inputs" : "Add an input";
  /* Slots with room the plane does not block. When every remaining slot is
     blocked the tip carries the reason, so the visitor learns what to remove
     before the picker tells them nothing can be picked. */
  const openRoles = tray.roles.filter(
    (role) =>
      !tray.blocked[role] &&
      tray.items.filter((item) => item.role === role).length < (model.roles[role] ?? 0),
  );
  const blockedReason = openRoles.length === 0 ? Object.values(tray.blocked)[0] : undefined;
  const attachTip = !tray.allFull && blockedReason ? blockedReason : attachLabel;
  const settingKey = overlay?.startsWith(SETTING) ? overlay.slice(SETTING.length) : null;

  /* Files dropped anywhere on the composer go up for the first slot with room
     and land on the plane as they arrive; the picker's own drop zone edits its
     slot instead. A strip item being reordered carries no files and passes
     through. The depth counter survives the enter/leave pairs children fire. */
  const dropProps = {
    onDragEnter: (event: DragEvent<HTMLDivElement>) => {
      if (!hasFiles(event) || tray.roles.length === 0) return;
      dropDepth.current += 1;
      setDropOver(true);
    },
    onDragOver: (event: DragEvent<HTMLDivElement>) => {
      if (!hasFiles(event) || tray.roles.length === 0) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    },
    onDragLeave: (event: DragEvent<HTMLDivElement>) => {
      if (!hasFiles(event)) return;
      dropDepth.current = Math.max(0, dropDepth.current - 1);
      if (dropDepth.current === 0) setDropOver(false);
    },
    onDrop: (event: DragEvent<HTMLDivElement>) => {
      const files = droppedFiles(event);
      dropDepth.current = 0;
      setDropOver(false);
      if (files.length === 0 || tray.roles.length === 0) return;
      event.preventDefault();
      const role = tray.dropRole(files);
      if (!role) {
        onError("Every input slot is taken — remove one in the composer first.");
        return;
      }
      tray.upload(role, files, "plane");
    },
  };
  const generateLabel = batchValue > 1 ? `Generate ${batchValue} results` : "Generate";
  const generateTip = conflict
    ? conflict
    : disabled
      ? promptless
        ? `Attach a ${roleNoun(need, 1)} first`
        : "Write a prompt first"
      : `${generateLabel} · ${shortcut ?? "⌘↵"}`;
  /* The hint stands where the words would: what the model waits for, then,
     once it has it, that pressing is all that is left. */
  const promptHint = needFilled
    ? `${model.label} takes no prompt — press Generate.`
    : `Attach a ${roleNoun(need, 1)} — ${model.label} takes no prompt.`;

  return (
    <div className="ohf-dock" ref={dockRef} data-selecting={selecting}>
      <div
        className="ohf-composer-wrap ohf-enter-2"
        ref={wrapRef}
        style={
          {
            "--ohf-pop-x": `${anchor.x}px`,
            "--ohf-pop-y": `${anchor.y}px`,
          } as CSSProperties
        }
      >
        {notice}

        {error && (
          <div className="ohf-alert" role="alert">
            <span className="ohf-alert-ic">
              <WarningIcon />
            </span>
            <span className="ohf-alert-text">{error}</span>
            <button
              type="button"
              className="ohf-icon-btn ohf-icon-btn--ghost"
              aria-label="Dismiss error"
              title="Dismiss error"
              onClick={() => onError(null)}
            >
              <CloseIcon size={12} />
            </button>
          </div>
        )}

        {/* Keyed by setting: a second pill pressed while one panel stands
            open remounts the panel, so it opens on its own value in force. */}
        {settingKey && <SettingPopover key={settingKey} model={model} settingKey={settingKey} values={values} />}
        {overlay === ASSETS && (
          <AssetPicker
            model={model}
            items={tray.items}
            uploads={tray.uploads}
            productId={productId}
            staged={tray.staged}
            stagedRole={tray.stagedRole}
            uploading={tray.uploading}
            progress={tray.progress}
            note={tray.note}
            blocked={tray.blocked}
            onUpload={tray.begin}
            onDrop={(role, files) => tray.upload(role, files, "picker")}
            onApply={tray.apply}
            onPin={(assetId, pinned) => {
              void onPin(assetId, pinned).then(() => tray.refreshAssets());
            }}
            onClose={() => setOverlay(null)}
          />
        )}
        {overlay === PICKER && (
          <ModelPicker
            selectedId={model.id}
            surface={surface}
            onPick={(next) => {
              setModel(next.id);
              setOverlay(null);
            }}
            onClose={() => setOverlay(null)}
          />
        )}
        {overlay === TEMPLATES && (
          <TemplatesPopover
            surface={surface}
            productId={productId}
            product={product ?? null}
            prompt={prompt.text}
            onInsert={(text, append) => {
              prompt.setText(insertIntoPrompt(prompt.text, text, append));
              /* Focusing the field puts the panel away and the auto-grow
                 effect sizes it for the new words. */
              promptRef.current?.focus();
            }}
            onClose={() => setOverlay(null)}
          />
        )}

        {/* One slot, two instruments. Both are laid on the same cell and
            aligned to the same bottom edge, so the dock never changes height
            and the toolbar rises exactly where the composer's rail was. */}
        <div className="ohf-swap">
          {/* Inert while the toolbar stands in its place: the composer fades
              under it, and a faded control must not stay a Tab stop. The id is
              where the skip link lands. */}
          <div id="ohf-composer" className={`ohf-composer${dropOver ? " ohf-drop--over" : ""}`} inert={selecting} {...dropProps}>
            <MediaStrip model={model} />

            {/* The attachment sits beside the words it belongs to, on the same
                left rail the control row starts from. */}
            <div className="ohf-composer-head">
              {tray.roles.length > 0 && (
                <>
                  {tray.input}
                  <button
                    type="button"
                    className="ohf-attach ohf-tip ohf-tip--start"
                    data-tip={attachTip}
                    disabled={tray.allFull}
                    aria-label={tray.uploading ? "Uploading" : attachLabel}
                    aria-expanded={overlay === ASSETS}
                    aria-haspopup="dialog"
                    onClick={(event) => toggle(ASSETS, event.currentTarget)}
                  >
                    {tray.uploading ? (
                      <span className="ohf-spinner" aria-hidden />
                    ) : (
                      <PlusIcon size={16} />
                    )}
                  </button>
                </>
              )}

              {/* The prompt lives inside the wrap the outside-pointer rule
                  guards, so it has to dismiss for itself: reaching for the words
                  puts the open control away. Pointer and focus both, because a
                  button click does not move focus on every platform — the field
                  can still hold it while a popover stands open. */}
              {promptless ? (
                <p className="ohf-prompt ohf-prompt--hint" role="status">
                  {promptHint}
                </p>
              ) : (
                <textarea
                  ref={promptRef}
                  id="ohf-prompt"
                  className="ohf-prompt"
                  rows={1}
                  value={prompt.text}
                  placeholder={PROMPT_PLACEHOLDERS[surface]}
                  aria-label="Prompt"
                  onPointerDown={() => setOverlay(null)}
                  onFocus={() => setOverlay(null)}
                  onChange={(event) => prompt.setText(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                      event.preventDefault();
                      if (!disabled) onGenerate();
                    }
                  }}
                />
              )}

              {/* The team's library, at the end of the words it fills. The
                  attach button's twin on the other side of the field. */}
              {!promptless && (
                <button
                  ref={templatesRef}
                  type="button"
                  className="ohf-attach ohf-tpl-btn ohf-tip ohf-tip--end"
                  data-tip="Prompt templates — Shift-pick appends"
                  aria-label="Prompt templates"
                  aria-expanded={overlay === TEMPLATES}
                  aria-haspopup="dialog"
                  onClick={(event) => toggle(TEMPLATES, event.currentTarget)}
                >
                  <TemplateIcon size={15} />
                </button>
              )}
            </div>

            <div className="ohf-composer-row">
              <div className="ohf-controls">
                <button
                  type="button"
                  className="ohf-ctl ohf-ctl--model ohf-tip"
                  data-tip="Change model"
                  /* The tip's words, then the visible label — the name the
                     reader hears has to hold the name the eye sees. */
                  aria-label={`Change model — ${model.label}`}
                  aria-expanded={overlay === PICKER}
                  aria-haspopup="dialog"
                  onClick={(event) => toggle(PICKER, event.currentTarget)}
                >
                  {modelIconSrc(model.id) ? (
                    <ModelIcon modelId={model.id} />
                  ) : (
                    <span className="ohf-model-swatch" style={{ background: swatchFor(surface, model.id) }} />
                  )}
                  <span className="ohf-ctl-name">{model.label}</span>
                  <span className="ohf-caret">
                    <CaretDownIcon />
                  </span>
                </button>

                {settingKeys.map((key) => (
                  <SettingPill
                    key={key}
                    model={model}
                    settingKey={key}
                    values={values}
                    open={overlay === `${SETTING}${key}`}
                    onOpen={(trigger) => toggle(`${SETTING}${key}`, trigger)}
                  />
                ))}

                {!promptless && <BatchStepper value={batchValue} counts={counts} onChange={setBatchValue} />}
              </div>

              <span className="ohf-generate-slot ohf-tip ohf-tip--end" data-tip={generateTip}>
                <button
                  type="button"
                  className="ohf-generate"
                  disabled={disabled}
                  data-busy={generating}
                  aria-label={generateLabel}
                  onClick={onGenerate}
                >
                  {/* The sheen is the only thing a run in flight changes here:
                      the label still names what pressing does, because pressing
                      is still allowed. Progress is the grid's to report. */}
                  {generating && <span className="ohf-generate-sheen" aria-hidden />}
                  <span className="ohf-generate-glyph" aria-hidden>
                    <ArrowUpIcon size={15} />
                  </span>
                  <span className="ohf-generate-label">Generate</span>
                  {shortcut && <kbd className="ohf-kbd">{shortcut}</kbd>}
                </button>
              </span>
            </div>
          </div>

          {selection}
        </div>
      </div>
    </div>
  );
}

/* Results per press. Every unit is a real generation, so the number is a
   spinbutton the keyboard can drive rather than two anonymous arrows, and the
   ceiling stays in view beside it. The arrows walk the counts the model
   actually allows — Soul offers 1 or 4, and there is no 2 to land on. */
function BatchStepper({
  value,
  counts,
  onChange,
}: {
  value: number;
  counts: number[];
  onChange: (next: number) => void;
}) {
  const index = Math.max(0, counts.indexOf(value));
  const last = counts.length - 1;
  const max = counts[last]!;
  const label = `Batch size — ${value} result${value > 1 ? "s" : ""} per press`;

  const step = (delta: number) => {
    const next = counts[Math.min(last, Math.max(0, index + delta))]!;
    if (next !== value) onChange(next);
  };

  return (
    <div className="ohf-batch ohf-tip" data-tip={label}>
      <button
        type="button"
        className="ohf-batch-step"
        aria-label="Fewer results"
        disabled={index <= 0}
        onClick={() => step(-1)}
      >
        <MinusIcon size={12} />
      </button>
      <span
        className="ohf-batch-value"
        role="spinbutton"
        tabIndex={0}
        aria-label="Batch size"
        aria-valuemin={counts[0]}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-valuetext={`${value} of ${max}`}
        onKeyDown={(event) => {
          const delta =
            event.key === "ArrowUp" || event.key === "ArrowRight"
              ? 1
              : event.key === "ArrowDown" || event.key === "ArrowLeft"
                ? -1
                : 0;
          if (delta !== 0) {
            event.preventDefault();
            step(delta);
            return;
          }
          if (event.key === "Home") {
            event.preventDefault();
            onChange(counts[0]!);
          }
          if (event.key === "End") {
            event.preventDefault();
            onChange(max);
          }
        }}
      >
        {value}
        <span className="ohf-batch-max" aria-hidden>
          /{max}
        </span>
      </span>
      <button
        type="button"
        className="ohf-batch-step"
        aria-label="More results"
        disabled={index >= last}
        onClick={() => step(1)}
      >
        <PlusIcon size={12} />
      </button>
    </div>
  );
}
