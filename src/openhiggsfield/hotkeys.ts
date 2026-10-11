/* Every letter key and chord the studio answers to — R S E V on a tile, U and
   B for the tools, W T X for the team's call on it, "/" for search, "[" for
   the sidebar, "?" for the shortcuts, Alt+1…9 for the shelf — stands down in
   the same two places: while the visitor is typing, and under a dialog, where
   the surface the key acts on is not the one on top. One test for all of
   them, so no hotkey drifts from the others. Cmd/Ctrl+K is the exception by
   design: a chord, not a letter, so it opens the palette from the caret too.

   The same file holds the registry the shortcuts overlay draws: one list, so
   the overlay can never describe a key the handlers do not answer to — and
   the one piece of arrow arithmetic the studio's menus share. */

import { TILE_TOOLS, VERDICTS, VERDICT_KEYS, VERDICT_LABELS } from "./data";

/** The two facts of a key's target the guard reads; an element has both. */
type Focusable = { tagName?: string; isContentEditable?: boolean };

/** A text field has the caret: letters are words there, not commands. */
export function typingIn(target: EventTarget | Focusable | null): boolean {
  const element = target as Focusable | null;
  if (!element) return false;
  return element.tagName === "INPUT" || element.tagName === "TEXTAREA" || element.isContentEditable === true;
}

/** The viewer, compare and the team dialog are `<dialog>` elements; while one
    is open the grid, the composer and the sidebar are all behind it. */
export function underDialog(): boolean {
  return typeof document !== "undefined" && document.querySelector("dialog[open]") !== null;
}

/** Whether a studio hotkey should let this key press pass untouched. */
export function hotkeysQuiet(event: { target: EventTarget | Focusable | null }): boolean {
  return typingIn(event.target) || underDialog();
}

/** The modifier keys a chord reads; a KeyboardEvent carries all of them. */
type Chord = { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; target: EventTarget | Focusable | null };

/** Cmd/Ctrl+K — the command palette. A chord is never a word, so it answers
    from a text field too; it only refuses Alt, which would make it a different
    chord on every layout. */
export function isPaletteChord(event: Chord): boolean {
  return (event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "k";
}

/** "?" — the shortcuts overlay, on the letter keys' terms: a bare key, not
    while typing, and not under a dialog. Shift is how "?" is typed, so it is
    not a modifier here. */
export function isShortcutsKey(event: Chord): boolean {
  return event.key === "?" && !event.metaKey && !event.ctrlKey && !event.altKey && !hotkeysQuiet(event);
}

/** Where the arrows land in a menu of `count` rows from the row at `index`:
    the APG menu pattern — Down and Up wrap, Home and End jump to the ends —
    and null for any other key, which is left to the row. From outside the
    rows (index -1, the button that opened the menu) Down and Home enter at
    the top, Up and End at the bottom. */
export function menuStep(count: number, index: number, key: string): number | null {
  if (count <= 0) return null;
  const inside = index >= 0 && index < count;
  switch (key) {
    case "ArrowDown":
    case "Home":
      return key === "Home" || !inside ? 0 : (index + 1) % count;
    case "ArrowUp":
    case "End":
      return key === "End" || !inside ? count - 1 : (index - 1 + count) % count;
    default:
      return null;
  }
}

/* ---------- the registry ---------- */

export type ShortcutGroup = "Navigation" | "Composer" | "Tiles" | "Inputs";

/** The order the overlay lists the groups in. */
export const SHORTCUT_GROUPS: readonly ShortcutGroup[] = ["Navigation", "Composer", "Tiles", "Inputs"];

/** One line of the overlay. `keys` is the caps of the chord separated by
    spaces — "Mod K", "Alt 1…9", "← →" — and `Mod` stands for the platform's
    command key, which the overlay resolves to ⌘ or Ctrl when it draws. */
export type Shortcut = { keys: string; does: string; group: ShortcutGroup };

/** The token the overlay swaps for the visitor's own command key. */
export const MOD = "Mod";

/* The tile letters and the tools derive from the same tables the handlers
   read: R S E V from the roles, U and B from whatever promptless entries the
   catalog gives a key to (tileKeyHint draws the card's tip from the same
   list). A tool that both kinds answer to under one letter is one line. */
function toolShortcuts(): Shortcut[] {
  const byKey = new Map<string, string[]>();
  for (const kind of ["image", "video"] as const) {
    for (const tool of TILE_TOOLS[kind]) {
      const lines = byKey.get(tool.key) ?? [];
      if (!lines.includes(tool.label)) lines.push(tool.label);
      byKey.set(tool.key, lines);
    }
  }
  return [...byKey].map(([key, lines]) => ({ keys: key.toUpperCase(), does: `${lines.join(" · ")} on the hovered tile`, group: "Tiles" }));
}

/* The verdict letters come from the same table the grid and the viewer read
   (VERDICT_KEYS), so a key renamed there is renamed on the sheet. */
function verdictShortcuts(): Shortcut[] {
  return VERDICTS.map((verdict) => ({
    keys: VERDICT_KEYS[verdict].toUpperCase(),
    does: `Call the hovered tile ${VERDICT_LABELS[verdict].toLowerCase()} — again takes it back; in the viewer too`,
    group: "Tiles",
  }));
}

export const SHORTCUTS: readonly Shortcut[] = [
  { keys: `${MOD} K`, does: "Open the command palette — works while typing", group: "Navigation" },
  { keys: "?", does: "Show these shortcuts", group: "Navigation" },
  { keys: "/", does: "Search prompts", group: "Navigation" },
  { keys: "[", does: "Fold the sidebar to its rail and back", group: "Navigation" },
  { keys: "↑ ↓", does: "Move through the sidebar's products and projects", group: "Navigation" },
  { keys: "← →", does: "Collapse or expand a product; switch the surface tab", group: "Navigation" },
  { keys: "Enter", does: "Open the focused project", group: "Navigation" },
  { keys: "Esc", does: "Close what is open; leave the selection", group: "Navigation" },
  { keys: `${MOD} Enter`, does: "Generate", group: "Composer" },
  { keys: "Esc", does: "Close the open panel", group: "Composer" },
  { keys: "R", does: "Use the hovered tile as a reference", group: "Tiles" },
  { keys: "S", does: "Use the hovered tile as the start frame", group: "Tiles" },
  { keys: "E", does: "Use the hovered tile as the end frame", group: "Tiles" },
  { keys: "V", does: "Use the hovered tile as the video input", group: "Tiles" },
  ...toolShortcuts(),
  ...verdictShortcuts(),
  { keys: "Shift Click", does: "Extend the selection to this tile", group: "Tiles" },
  { keys: "← →", does: "Previous or next run in the viewer; walk the columns in Compare", group: "Tiles" },
  { keys: "Space", does: "Play or pause the clips in Compare", group: "Tiles" },
  { keys: "Alt 1…9", does: "Attach the product's Nth pinned file as a reference", group: "Inputs" },
  { keys: "← →", does: "Switch shelves in the asset picker", group: "Inputs" },
];

/** The caps a `keys` string draws, `Mod` already swapped for the visitor's
    command key. */
export function keyCaps(keys: string, mod: string): string[] {
  return keys.split(" ").map((cap) => (cap === MOD ? mod : cap));
}

/** The visitor's command key, read off the browser they are in. "⌘" where
    there is no browser to ask — a server render — and the caller corrects it
    after mount, so the hydrating markup matches. */
export function modKey(): "⌘" | "Ctrl" {
  if (typeof navigator === "undefined") return "⌘";
  return /Mac|iP(hone|ad|od)/.test(navigator.userAgent) ? "⌘" : "Ctrl";
}
