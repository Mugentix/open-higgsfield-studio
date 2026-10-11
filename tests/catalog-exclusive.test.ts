import { beforeEach, describe, expect, it, vi } from "vitest";

import { ALL_MODELS, getModel } from "@/generation/catalog";
import type { MediaItem, MediaRole, ModelEntry } from "@/generation/catalog/types";
import { toKieFor } from "@/generation/to-kie";
import { FRAME_ROLES, LIST_ROLES, blockedRoles } from "@/openhiggsfield/data";

import { AUD, IMG, IMG2, VID, plane } from "./plane";

/* KIE's Seedance 2.5 doc: first_frame_url "cannot be used simultaneously with
   reference_image_urls, reference_video_urls, or reference_audio_urls". The
   catalog says which entries live by that rule through `exclusive`, and the
   composer blocks the second group on the strength of it — so the flag must
   agree with what the mapper actually refuses, for every entry, gated or not. */

const SAMPLE: Record<MediaRole, string> = { start: IMG, end: IMG2, reference: IMG2, video: VID, audio: AUD };

/** Every entry that could carry a frame and a reference-kind input at once. */
const BOTH_GROUPS = ALL_MODELS.filter(
  (entry) => FRAME_ROLES.some((role) => entry.roles[role]) && LIST_ROLES.some((role) => entry.roles[role]),
);

/** The first list role the entry declares: what a start frame is paired with. */
function listRoleOf(entry: ModelEntry): MediaRole {
  return LIST_ROLES.find((role) => entry.roles[role])!;
}

describe("exclusive: frames or references", () => {
  it("has entries of both kinds to check", () => {
    expect(BOTH_GROUPS.length).toBeGreaterThan(5);
    expect(BOTH_GROUPS.some((entry) => entry.exclusive)).toBe(true);
    expect(BOTH_GROUPS.some((entry) => !entry.exclusive)).toBe(true);
  });

  it.each(BOTH_GROUPS.map((entry) => [entry.id, entry] as const))(
    "%s: the mapper refuses a start frame with a reference iff the entry declares exclusive",
    (_id, entry) => {
      const paired = listRoleOf(entry);
      const submit = () =>
        toKieFor(plane(entry, { media: { start: [IMG], [paired]: [SAMPLE[paired]] } }), entry);
      if (entry.exclusive === "frames-or-references") {
        expect(submit).toThrow(/either frames or references/);
      } else {
        expect(submit).not.toThrow();
      }
    },
  );

  it("is never declared on an entry that cannot carry both groups", () => {
    for (const entry of ALL_MODELS) {
      if (entry.exclusive) expect(BOTH_GROUPS).toContain(entry);
    }
  });

  it("names the families the docs describe as exclusive", () => {
    const flagged = ALL_MODELS.filter((entry) => entry.exclusive).map((entry) => entry.id);
    expect(flagged).toEqual(
      expect.arrayContaining(["seedance-2.5", "seedance-2", "seedance-2-fast", "seedance-2-mini", "wan-3", "wan-3-prime", "kling-3-omni", "minimax-h3", "pixverse-6"]),
    );
    /* Motion Control needs the character frame and the driving clip together. */
    expect(flagged).not.toContain("kling-3-motion-std");
    expect(flagged).not.toContain("kling-3-motion-pro");
  });
});

function item(id: string, role: MediaRole): MediaItem {
  return { id, url: SAMPLE[role], role };
}

describe("blockedRoles", () => {
  const seedance = getModel("seedance-2.5");

  it("blocks nothing on an empty plane or on an entry that is not exclusive", () => {
    expect(blockedRoles(seedance, [])).toEqual({});
    const motion = getModel("kling-3-motion-std");
    expect(blockedRoles(motion, [item("s", "start")])).toEqual({});
  });

  it("blocks every list role while a frame is attached, and says which frame to remove", () => {
    const blocked = blockedRoles(seedance, [item("s", "start")]);
    expect(Object.keys(blocked).sort()).toEqual(["audio", "reference", "video"]);
    expect(blocked.reference).toBe(
      "Seedance 2.5 takes either frames or references — remove the start frame to add references",
    );
    expect(blocked.video).toMatch(/remove the start frame to add clips$/);
    expect(blocked.audio).toMatch(/remove the start frame to add audio tracks$/);
    expect(blockedRoles(seedance, [item("e", "end")]).reference).toMatch(/remove the end frame/);
    expect(blockedRoles(seedance, [item("s", "start"), item("e", "end")]).reference).toMatch(/remove the frames/);
  });

  it("blocks both frame roles while a reference of any kind is attached", () => {
    for (const role of LIST_ROLES) {
      const blocked = blockedRoles(seedance, [item("x", role)]);
      expect(Object.keys(blocked).sort()).toEqual(["end", "start"]);
      expect(blocked.start).toBe(
        "Seedance 2.5 takes either frames or references — remove the references to add a start frame",
      );
      expect(blocked.end).toMatch(/to add an end frame$/);
    }
  });

  it("ignores items of roles the entry does not declare", () => {
    const horse = getModel("happy-horse-1.1");
    expect(blockedRoles(horse, [item("a", "audio")])).toEqual({});
    expect(Object.keys(blockedRoles(horse, [item("s", "start")]))).toEqual(["reference"]);
  });
});

describe("attachInput on an exclusive entry", () => {
  const backing = new Map<string, string>();
  beforeEach(() => {
    backing.clear();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => backing.get(key) ?? null,
      setItem: (key: string, value: string) => void backing.set(key, value),
      removeItem: (key: string) => void backing.delete(key),
    });
    vi.resetModules();
  });

  it("refuses the other group with the reason instead of attaching or switching", async () => {
    const { useActive } = await import("@/generation/stores/active");
    const { useVideoMedia } = await import("@/generation/stores/media");
    const { attachInput } = await import("@/generation/attach");
    useActive.getState().setModel("seedance-2.5");
    useVideoMedia.getState().add(item("s", "start"));

    const outcome = attachInput({ url: IMG2, resultId: "r1" }, "reference");
    expect(outcome?.blocked).toMatch(/remove the start frame to add references/);
    expect(outcome?.switched).toBe(false);
    expect(useVideoMedia.getState().items.map((entry) => entry.role)).toEqual(["start"]);
    expect(useActive.getState().model).toBe("seedance-2.5");

    /* The same press once the frame is gone lands. */
    useVideoMedia.getState().remove("s");
    const landed = attachInput({ url: IMG2, resultId: "r1" }, "reference");
    expect(landed?.blocked).toBeUndefined();
    expect(useVideoMedia.getState().items.map((entry) => entry.role)).toEqual(["reference"]);
  });

  it("still fills a frame on an entry that takes frames with its references", async () => {
    const { useActive } = await import("@/generation/stores/active");
    const { useVideoMedia } = await import("@/generation/stores/media");
    const { attachInput } = await import("@/generation/attach");
    useActive.getState().setModel("kling-3-motion-std");
    useVideoMedia.getState().add(item("v", "video"));
    const outcome = attachInput({ url: IMG, resultId: "r2" }, "start");
    expect(outcome?.blocked).toBeUndefined();
    expect(useVideoMedia.getState().items.map((entry) => entry.role).sort()).toEqual(["start", "video"]);
  });
});
