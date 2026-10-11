import { afterEach, describe, expect, it, vi } from "vitest";

import { TILE_TOOLS, VERDICTS, VERDICT_KEYS, VERDICT_LABELS } from "@/openhiggsfield/data";
import {
  MOD,
  SHORTCUTS,
  SHORTCUT_GROUPS,
  hotkeysQuiet,
  isPaletteChord,
  isShortcutsKey,
  keyCaps,
  menuStep,
  modKey,
  typingIn,
  underDialog,
} from "@/openhiggsfield/hotkeys";

/* Every studio hotkey — the tile letters, "/", "[", "?", Alt+1…9 — asks this
   one helper whether to stand down, so the two rules are pinned here once.
   The registry the shortcuts overlay draws lives beside the guard, so the
   sheet can never list a key the handlers do not answer to. */

const field = (tagName: string, isContentEditable = false) => ({ tagName, isContentEditable });

function stubDocument(dialogOpen: boolean) {
  vi.stubGlobal("document", {
    querySelector: (selector: string) => (selector === "dialog[open]" && dialogOpen ? {} : null),
  });
}

/** A key press as the chord helpers read it: no modifiers unless given. */
function press(key: string, extra: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean; target: EventTarget | null }> = {}) {
  return { key, metaKey: false, ctrlKey: false, altKey: false, target: null, ...extra };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("typingIn", () => {
  it("is true for an input, a textarea and a contenteditable", () => {
    expect(typingIn(field("INPUT"))).toBe(true);
    expect(typingIn(field("TEXTAREA"))).toBe(true);
    expect(typingIn(field("DIV", true))).toBe(true);
  });

  it("is false for a button, a tile and a missing target", () => {
    expect(typingIn(field("BUTTON"))).toBe(false);
    expect(typingIn(field("DIV"))).toBe(false);
    expect(typingIn(null)).toBe(false);
  });
});

describe("underDialog", () => {
  it("is true only while a <dialog> is open", () => {
    stubDocument(true);
    expect(underDialog()).toBe(true);
    stubDocument(false);
    expect(underDialog()).toBe(false);
  });

  it("is false where there is no document at all", () => {
    vi.stubGlobal("document", undefined);
    expect(underDialog()).toBe(false);
  });
});

describe("hotkeysQuiet", () => {
  it("stands down while typing, whatever is open", () => {
    stubDocument(false);
    expect(hotkeysQuiet({ target: field("TEXTAREA") })).toBe(true);
  });

  it("stands down under a dialog, whatever has focus", () => {
    stubDocument(true);
    expect(hotkeysQuiet({ target: field("BUTTON") })).toBe(true);
    expect(hotkeysQuiet({ target: null })).toBe(true);
  });

  it("lets the key through on the wall with no dialog up", () => {
    stubDocument(false);
    expect(hotkeysQuiet({ target: field("BUTTON") })).toBe(false);
    expect(hotkeysQuiet({ target: null })).toBe(false);
  });
});

describe("isPaletteChord", () => {
  it("answers Cmd+K and Ctrl+K in either case, from a text field too", () => {
    stubDocument(false);
    expect(isPaletteChord(press("k", { metaKey: true }))).toBe(true);
    expect(isPaletteChord(press("K", { ctrlKey: true }))).toBe(true);
    expect(isPaletteChord(press("k", { metaKey: true, target: field("TEXTAREA") as unknown as EventTarget }))).toBe(true);
  });

  it("is not a bare K, and not a chord with Alt in it", () => {
    expect(isPaletteChord(press("k"))).toBe(false);
    expect(isPaletteChord(press("k", { metaKey: true, altKey: true }))).toBe(false);
    expect(isPaletteChord(press("j", { metaKey: true }))).toBe(false);
  });
});

describe("isShortcutsKey", () => {
  it("answers a bare ? on the wall", () => {
    stubDocument(false);
    expect(isShortcutsKey(press("?"))).toBe(true);
  });

  it("stands down while typing, under a dialog, and with a modifier held", () => {
    stubDocument(false);
    expect(isShortcutsKey(press("?", { target: field("INPUT") as unknown as EventTarget }))).toBe(false);
    expect(isShortcutsKey(press("?", { ctrlKey: true }))).toBe(false);
    stubDocument(true);
    expect(isShortcutsKey(press("?"))).toBe(false);
  });
});

describe("SHORTCUTS", () => {
  it("gives every key a distinct meaning within its group", () => {
    for (const group of SHORTCUT_GROUPS) {
      const keys = SHORTCUTS.filter((entry) => entry.group === group).map((entry) => entry.keys);
      expect(new Set(keys).size, `duplicate key in ${group}: ${keys.join(", ")}`).toBe(keys.length);
    }
  });

  it("names a known group and says what every key does", () => {
    for (const entry of SHORTCUTS) {
      expect(SHORTCUT_GROUPS).toContain(entry.group);
      expect(entry.keys.trim().length).toBeGreaterThan(0);
      expect(entry.does.trim().length).toBeGreaterThan(0);
    }
  });

  it("lists the palette chord and the overlay's own key under Navigation", () => {
    const navigation = SHORTCUTS.filter((entry) => entry.group === "Navigation").map((entry) => entry.keys);
    expect(navigation).toContain(`${MOD} K`);
    expect(navigation).toContain("?");
    expect(navigation).toContain("/");
    expect(navigation).toContain("[");
  });

  it("derives the tool letters from the catalog, beside R S E V", () => {
    const tiles = SHORTCUTS.filter((entry) => entry.group === "Tiles");
    const keys = tiles.map((entry) => entry.keys);
    for (const letter of ["R", "S", "E", "V"]) expect(keys).toContain(letter);
    for (const kind of ["image", "video"] as const) {
      for (const tool of TILE_TOOLS[kind]) {
        const row = tiles.find((entry) => entry.keys === tool.key.toUpperCase());
        expect(row, `no row for the ${tool.key} tool`).toBeDefined();
        expect(row!.does).toContain(tool.label);
      }
    }
  });

  it("derives the verdict letters from the same table the grid and the viewer read", () => {
    const tiles = SHORTCUTS.filter((entry) => entry.group === "Tiles");
    for (const verdict of VERDICTS) {
      const row = tiles.find((entry) => entry.keys === VERDICT_KEYS[verdict].toUpperCase());
      expect(row, `no row for the ${verdict} key`).toBeDefined();
      expect(row!.does.toLowerCase()).toContain(VERDICT_LABELS[verdict].toLowerCase());
    }
  });
});

describe("keyCaps", () => {
  it("splits a chord into caps and swaps Mod for the visitor's key", () => {
    expect(keyCaps("Mod K", "⌘")).toEqual(["⌘", "K"]);
    expect(keyCaps("Mod Enter", "Ctrl")).toEqual(["Ctrl", "Enter"]);
    expect(keyCaps("Alt 1…9", "⌘")).toEqual(["Alt", "1…9"]);
    expect(keyCaps("?", "⌘")).toEqual(["?"]);
  });
});

describe("menuStep", () => {
  it("walks the rows and wraps at both ends", () => {
    expect(menuStep(3, 0, "ArrowDown")).toBe(1);
    expect(menuStep(3, 2, "ArrowDown")).toBe(0);
    expect(menuStep(3, 1, "ArrowUp")).toBe(0);
    expect(menuStep(3, 0, "ArrowUp")).toBe(2);
  });

  it("jumps to the ends on Home and End from any row", () => {
    expect(menuStep(4, 2, "Home")).toBe(0);
    expect(menuStep(4, 1, "End")).toBe(3);
  });

  it("enters from the button that opened it: Down at the top, Up at the bottom", () => {
    expect(menuStep(3, -1, "ArrowDown")).toBe(0);
    expect(menuStep(3, -1, "ArrowUp")).toBe(2);
    expect(menuStep(3, -1, "Home")).toBe(0);
    expect(menuStep(3, -1, "End")).toBe(2);
  });

  it("leaves every other key, and an empty menu, alone", () => {
    expect(menuStep(3, 1, "Enter")).toBeNull();
    expect(menuStep(3, 1, "ArrowRight")).toBeNull();
    expect(menuStep(0, -1, "ArrowDown")).toBeNull();
  });
});

describe("modKey", () => {
  it("reads ⌘ on Apple platforms, Ctrl elsewhere, and ⌘ with no browser to ask", () => {
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)" });
    expect(modKey()).toBe("⌘");
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (X11; Linux x86_64)" });
    expect(modKey()).toBe("Ctrl");
    vi.stubGlobal("navigator", undefined);
    expect(modKey()).toBe("⌘");
  });
});
