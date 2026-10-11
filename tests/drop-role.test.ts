import { describe, expect, it } from "vitest";

import { getModel } from "@/generation/catalog";
import type { MediaItem, MediaRole } from "@/generation/catalog/types";
import { dropRoleFor, kindOfFile } from "@/openhiggsfield/data";

/* Files dropped on the composer body pick their own slot. One image is the
   start frame; a batch can only mean a list, so several images go to the
   references even where a one-slot frame comes first in the catalog — five
   references dropped under Seedance 2.5 must not end as one start frame with
   four files lost and the reference slot locked behind it. */

const image = { type: "image/png" };
const clip = { type: "video/mp4" };
const track = { type: "audio/wav" };

function item(id: string, role: MediaRole): MediaItem {
  return { id, url: `https://files.example.com/${id}`, role };
}

describe("dropRoleFor", () => {
  const seedance = getModel("seedance-2.5");

  it("lands a single image on the start frame", () => {
    expect(dropRoleFor(seedance, [], [image])).toBe("start");
  });

  it("sends a batch of images to the references, past the one-slot frames", () => {
    expect(dropRoleFor(seedance, [], [image, image, image])).toBe("reference");
    /* More than the list takes still goes to the list; the upload reports the surplus. */
    expect(dropRoleFor(seedance, [], Array.from({ length: 40 }, () => image))).toBe("reference");
  });

  it("picks the slot by the files' kind", () => {
    expect(dropRoleFor(seedance, [], [clip])).toBe("video");
    expect(dropRoleFor(seedance, [], [clip, clip])).toBe("video");
    expect(dropRoleFor(seedance, [], [track])).toBe("audio");
  });

  it("passes the slots the plane blocks while another is open", () => {
    /* A start frame blocks the lists: the next image is the end frame. */
    expect(dropRoleFor(seedance, [item("s", "start")], [image])).toBe("end");
    /* A reference blocks the frames: one image joins the references. */
    expect(dropRoleFor(seedance, [item("r", "reference")], [image])).toBe("reference");
  });

  it("hands back a blocked slot when nothing open has room, so the upload can say why", () => {
    const frames = [item("s", "start"), item("e", "end")];
    expect(dropRoleFor(seedance, frames, [image])).toBe("reference");
    expect(dropRoleFor(seedance, frames, [clip])).toBe("video");
  });

  it("falls back on a slot of another kind, which the upload then refuses by MIME", () => {
    expect(dropRoleFor(getModel("kling-3-std"), [], [clip])).toBe("start");
  });

  it("is null once every slot is taken", () => {
    expect(dropRoleFor(getModel("kling-3-turbo"), [item("s", "start")], [image])).toBeNull();
  });
});

describe("kindOfFile", () => {
  it("sorts by the MIME family and treats anything else as an image", () => {
    expect(kindOfFile(clip)).toBe("video");
    expect(kindOfFile(track)).toBe("audio");
    expect(kindOfFile(image)).toBe("image");
    expect(kindOfFile({ type: "" })).toBe("image");
  });
});
