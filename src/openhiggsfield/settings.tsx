"use client";

import { useEffect, useRef } from "react";

import type { ModelEntry } from "@/generation/catalog";
import { ratiosFor } from "@/generation/formats";
import { useFormats } from "@/generation/stores/formats";
import { useSettings } from "@/generation/stores/settings";

import {
  ratioBox,
  settingLabel,
  settingPillLabel,
  settingValueLabel,
} from "./data";
import { AudioIcon, CheckIcon, ClockIcon, FormatIcon, GemIcon } from "./icons";
import { Field, OptionList, Slider } from "./ui";

/* The aspect-ratio setting is the one that fans out: beside the primary the
   pill holds, extra ratios can be ticked and the press renders every one. */
const ASPECT = "aspectRatio";

/* One shared empty list, so a model with nothing ticked reads the same
   reference every render instead of a fresh array the store cannot settle on. */
const NONE: readonly string[] = [];

/** The extra ratios the press will also render, as the catalog still offers
    them and without the primary, which planesFor would skip anyway. */
function extraRatios(model: ModelEntry, chosen: readonly string[], primary: unknown): string[] {
  return ratiosFor(model, chosen).filter((ratio) => ratio !== primary);
}

/* One drawn mark per setting the catalog is known to declare. Anything new
   arrives as its value alone rather than under a borrowed glyph — a wrong icon
   reads as a wrong control. */
function glyphFor(key: string, value: unknown) {
  if (key === "aspectRatio") {
    /* The mark is the ratio: the pill draws the frame it is about to make, in a
       fixed optical box so 21:9 and 1:1 leave their labels on the same rail. */
    const box = typeof value === "string" ? ratioBox(value) : null;
    return (
      <span className="ohf-ctl-ratio">
        <span
          className={`ohf-ctl-ratio-box${box ? "" : " ohf-ctl-ratio-box--auto"}`}
          style={box ?? undefined}
        />
      </span>
    );
  }
  if (key === "resolution") return <GemIcon size={13} />;
  if (key === "duration") return <ClockIcon size={13} />;
  if (key === "outputFormat") return <FormatIcon size={13} />;
  if (key === "generateAudio" || key === "sound" || key === "keepOriginalSound") {
    return <AudioIcon size={13} />;
  }
  return null;
}

/** One catalog setting, standing on the composer's control rail. Booleans are
    the control themselves; everything else opens its values in a popover. */
export function SettingPill({
  model,
  settingKey,
  values,
  open,
  onOpen,
}: {
  model: ModelEntry;
  settingKey: string;
  values: Record<string, unknown>;
  open: boolean;
  onOpen: (trigger: HTMLElement) => void;
}) {
  const settings = useSettings();
  const chosen = useFormats((state) => state.byModel[model.id] ?? NONE);
  const field = model.settings[settingKey];
  if (!field) return null;

  const label = settingLabel(settingKey);
  const value = values[settingKey];
  const glyph = glyphFor(settingKey, value);
  /* Several formats ticked: the pill counts them rather than naming one, and
     the glyph keeps drawing the primary the composer will lead with. */
  const extra = settingKey === ASPECT ? extraRatios(model, chosen, value) : [];
  const shown = extra.length ? `${extra.length + 1} formats` : settingValueLabel(settingKey, value);
  const spoken = extra.length
    ? `${settingValueLabel(settingKey, value)}, also ${extra.join(", ")}`
    : settingValueLabel(settingKey, value);

  if (field.type === "boolean") {
    const on = value === true;
    return (
      <button
        type="button"
        className="ohf-ctl ohf-ctl--flag"
        aria-pressed={on}
        aria-label={`${label} — ${on ? "on" : "off"}`}
        onClick={() => settings.set(model.id, { [settingKey]: !on })}
      >
        {glyph && (
          <span className="ohf-ctl-glyph" aria-hidden>
            {glyph}
          </span>
        )}
        <span className="ohf-ctl-value">{settingPillLabel(settingKey)}</span>
      </button>
    );
  }

  return (
    <button
      type="button"
      className="ohf-ctl ohf-tip"
      data-tip={label}
      aria-expanded={open}
      aria-haspopup="dialog"
      aria-label={`${label} — ${spoken}`}
      onClick={(event) => onOpen(event.currentTarget)}
    >
      {glyph && (
        <span className="ohf-ctl-glyph" aria-hidden>
          {glyph}
        </span>
      )}
      <span className="ohf-ctl-value">{shown}</span>
    </button>
  );
}

/** The values behind one pill — a list of the enum's values, or the slider of
    a range, scoped to the single setting the visitor reached for. */
export function SettingPopover({
  model,
  settingKey,
  values,
}: {
  model: ModelEntry;
  settingKey: string;
  values: Record<string, unknown>;
}) {
  const settings = useSettings();
  const chosen = useFormats((state) => state.byModel[model.id] ?? NONE);
  const rootRef = useRef<HTMLDivElement>(null);
  /* The panel opens on the value in force — the pressed line, or the slider —
     so the arrows work it at once, the way the picker opens on its search.
     Escape hands focus back to the pill through the composer. */
  useEffect(() => {
    rootRef.current?.querySelector<HTMLElement>('[aria-pressed="true"], input[type="range"]')?.focus();
  }, []);
  const field = model.settings[settingKey];
  if (!field || field.type === "boolean") return null;

  const label = settingLabel(settingKey);

  if (field.type === "enum") {
    const value = typeof values[settingKey] === "string" ? (values[settingKey] as string) : field.default;
    /* Only the ratio list carries the second column; null keeps every other
       enum's panel exactly as it was. */
    const extra = settingKey === ASPECT ? extraRatios(model, chosen, value) : null;
    return (
      <div
        ref={rootRef}
        className={`ohf-popover ohf-popover--setting ohf-popover--list${extra ? " ohf-popover--formats" : ""}`}
        role="dialog"
        aria-label={label}
      >
        <Field label={label}>
          <OptionList
            options={field.values.map((option) => ({
              value: option,
              label: settingValueLabel(settingKey, option),
            }))}
            value={value}
            ratio={settingKey === ASPECT}
            onChange={(next) => {
              settings.set(model.id, { [settingKey]: next });
              /* The new primary cannot also be an extra; untick it so the
                 pill's count stays what the press will deliver. */
              if (extra?.includes(next)) useFormats.getState().toggle(model.id, next);
            }}
            aside={
              extra
                ? (ratio) => {
                    /* The primary's own line has nothing to tick, and neither
                       has "auto": a placement is a frame, not a deferral. */
                    if (ratio === value || !ratioBox(ratio)) {
                      return <span className="ohf-format-mark ohf-format-mark--slot" aria-hidden />;
                    }
                    const on = extra.includes(ratio);
                    return (
                      <button
                        type="button"
                        role="checkbox"
                        className="ohf-format-mark"
                        aria-checked={on}
                        aria-label={`Also render in ${ratio}`}
                        title={on ? `Also rendering in ${ratio}` : `Also render in ${ratio}`}
                        onClick={() => useFormats.getState().toggle(model.id, ratio)}
                      >
                        <span className="ohf-format-box" aria-hidden>
                          {on && <CheckIcon size={9} />}
                        </span>
                      </button>
                    );
                  }
                : undefined
            }
          />
        </Field>
        {extra && (
          <div className="ohf-format-note">
            <span>
              {extra.length
                ? `${extra.length + 1} formats per press`
                : "Tick a ratio to also render in it"}
            </span>
            {extra.length > 0 && (
              <button type="button" className="ohf-format-clear" onClick={() => useFormats.getState().clear(model.id)}>
                Clear
              </button>
            )}
          </div>
        )}
      </div>
    );
  }

  const value = typeof values[settingKey] === "number" ? (values[settingKey] as number) : field.default;
  return (
    <div ref={rootRef} className="ohf-popover ohf-popover--setting ohf-scroll" role="dialog" aria-label={label}>
      <Field label={label} value={settingValueLabel(settingKey, value)}>
        <Slider
          min={field.min}
          max={field.max}
          step={field.step ?? 1}
          value={value}
          label={label}
          onChange={(next) => settings.set(model.id, { [settingKey]: next })}
        />
      </Field>
    </div>
  );
}
