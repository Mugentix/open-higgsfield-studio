"use client";

import { useEffect, useRef, useState } from "react";

import { SHORTCUTS, SHORTCUT_GROUPS, keyCaps, modKey, type ShortcutGroup } from "./hotkeys";
import { CloseIcon } from "./icons";

/* "?" — every key the studio answers to, on one sheet, drawn from the registry
   the handlers are pinned to. Four groups, two columns; a key that appears in
   two groups (Esc, the arrows) does two things and says so twice. */
export function Shortcuts({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  /* Opened by a key press, so the visitor's modifier is known at first
     render — nothing here was server-drawn. */
  const [mod] = useState(() => modKey());

  /* The panel takes focus so no row opens pre-ringed, and the opener has it
     back on the way out — unless something else took it first. */
  /* The opener is read once into a ref: React runs this effect twice in
     development, and a second read would find the sheet's own panel. */
  const opener = useRef<HTMLElement | null>(null);
  useEffect(() => {
    opener.current ??= document.activeElement instanceof HTMLElement ? document.activeElement : null;
    ref.current?.showModal();
    panelRef.current?.focus();
    return () => {
      if (document.activeElement === null || document.activeElement === document.body) opener.current?.focus();
    };
  }, []);

  const groups = SHORTCUT_GROUPS.map((group) => ({ group, rows: SHORTCUTS.filter((entry) => entry.group === group) })).filter(
    (entry) => entry.rows.length > 0,
  );

  return (
    <dialog
      ref={ref}
      className="ohf-shortcuts"
      aria-labelledby="ohf-shortcuts-title"
      onClose={onClose}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === ref.current) onClose();
      }}
    >
      <div ref={panelRef} tabIndex={-1} className="ohf-dialog-panel ohf-shortcuts-panel">
        <div className="ohf-keys-head">
          <div>
            <div id="ohf-shortcuts-title" className="ohf-keys-title">
              Keyboard shortcuts
            </div>
            <p className="ohf-keys-copy">
              The letters stand down while you type and under a dialog. <kbd className="ohf-kbd">{mod}</kbd>{" "}
              <kbd className="ohf-kbd">K</kbd> is a chord and works from anywhere.
            </p>
          </div>
          <button type="button" className="ohf-icon-btn" aria-label="Close" onClick={onClose}>
            <CloseIcon size={13} />
          </button>
        </div>

        <div className="ohf-shortcuts-body ohf-scroll">
          {groups.map(({ group, rows }) => (
            <section key={group} className="ohf-shortcuts-group" aria-labelledby={groupId(group)}>
              <h3 id={groupId(group)} className="ohf-pop-head ohf-shortcuts-head">
                {group}
              </h3>
              <ul className="ohf-shortcuts-list">
                {rows.map((entry) => (
                  <li key={entry.keys} className="ohf-shortcuts-row">
                    <span className="ohf-shortcuts-does">{entry.does}</span>
                    <span className="ohf-shortcuts-keys">
                      {keyCaps(entry.keys, mod).map((cap, index) => (
                        <kbd key={`${cap}-${index}`} className="ohf-kbd">
                          {cap}
                        </kbd>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </dialog>
  );
}

function groupId(group: ShortcutGroup): string {
  return `ohf-shortcuts-${group.toLowerCase()}`;
}
