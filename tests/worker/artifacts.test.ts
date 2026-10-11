import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { artifactKey, describeFile, locateFile, scanWorkspace, uploadArtifact, type Snapshot } from "../../worker/artifacts";
import { MemoryMedia } from "./doubles";

let dir: string;

async function put(relative: string, body: string | Uint8Array): Promise<string> {
  const file = path.join(dir, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, body);
  return file;
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "ohf-artifacts-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("scanWorkspace", () => {
  it("finds outputs at any depth and loose media only shallow, skipping inputs and dot files", async () => {
    await put("outputs/plan.md", "# plan");
    await put("outputs/takes/deep/er/take-1.mp4", "mp4");
    await put("outputs/notes.xyz", "other kind");
    await put("board.png", "png");
    await put("notes.md", "md");
    await put("scripts/readme.txt", "txt is not loose media");
    await put("a/b/deep.png", "depth 2 is in");
    await put("a/b/c/deeper.png", "depth 3 is out");
    await put("inputs/ref.png", "the person's file");
    await put(".env", "KIE_API_KEY=x");
    await put("node_modules/pkg/x.png", "dependency");
    await put("outputs/.hidden.png", "hidden");
    await put("outputs/empty.png", "");

    const { changed, snapshot } = await scanWorkspace(dir, new Map());
    expect(changed.map((file) => file.path).sort()).toEqual([
      "a/b/deep.png",
      "board.png",
      "notes.md",
      "outputs/notes.xyz",
      "outputs/plan.md",
      "outputs/takes/deep/er/take-1.mp4",
    ]);
    expect(changed.find((file) => file.path === "outputs/takes/deep/er/take-1.mp4")).toMatchObject({ fileKind: "video", mime: "video/mp4", size: 3 });
    expect(changed.find((file) => file.path === "outputs/notes.xyz")).toMatchObject({ fileKind: "other" });
    expect(snapshot.size).toBe(6);
  });

  it("skips what did not change, by size and mtime first, then by hash", async () => {
    const plan = await put("outputs/plan.md", "# plan");
    const first = await scanWorkspace(dir, new Map());
    expect(first.changed).toHaveLength(1);

    const second = await scanWorkspace(dir, first.snapshot);
    expect(second.changed).toEqual([]);

    /* Touched, same bytes: the hash says it is the same file. */
    await utimes(plan, new Date(Date.now() + 5_000), new Date(Date.now() + 5_000));
    const third = await scanWorkspace(dir, second.snapshot);
    expect(third.changed).toEqual([]);

    await writeFile(plan, "# plan v2");
    const fourth = await scanWorkspace(dir, third.snapshot);
    expect(fourth.changed.map((file) => file.path)).toEqual(["outputs/plan.md"]);

    await put("outputs/new.png", "png");
    const fifth = await scanWorkspace(dir, fourth.snapshot);
    expect(fifth.changed.map((file) => file.path)).toEqual(["outputs/new.png"]);
  });

  it("forgets a deleted file so a later rewrite is uploaded again", async () => {
    await put("outputs/a.md", "a");
    const first = await scanWorkspace(dir, new Map());
    await rm(path.join(dir, "outputs/a.md"));
    const second = await scanWorkspace(dir, first.snapshot);
    expect(second.snapshot.has("outputs/a.md")).toBe(false);
    await put("outputs/a.md", "a");
    expect((await scanWorkspace(dir, second.snapshot as Snapshot)).changed).toHaveLength(1);
  });
});

describe("artifactKey and describeFile", () => {
  it("folds a workspace path into the store's charset under the run", () => {
    expect(artifactKey("team", "run", "outputs/My Take (1).png")).toBe("t/team/agents/run/outputs/My_Take_1_.png");
    expect(artifactKey("team", "run", "outputs/../x.png")).toBe("t/team/agents/run/outputs/x.png");
    expect(artifactKey("team", "run", "outputs/.hidden")).toBe("t/team/agents/run/outputs/_hidden");
  });

  it("knows kinds by extension", () => {
    expect(describeFile("a/b.JPG")).toEqual({ fileKind: "image", mime: "image/jpeg" });
    expect(describeFile("x.mov")).toEqual({ fileKind: "video", mime: "video/quicktime" });
    expect(describeFile("x.wav")).toEqual({ fileKind: "audio", mime: "audio/wav" });
    expect(describeFile("x.md")).toEqual({ fileKind: "document", mime: "text/markdown" });
    expect(describeFile("x.bin")).toEqual({ fileKind: "other", mime: "application/octet-stream" });
  });
});

describe("locateFile and uploadArtifact", () => {
  it("resolves a path inside the workspace and refuses one outside", async () => {
    await put("outputs/board.png", "png bytes");
    const found = await locateFile(dir, "./outputs/board.png");
    expect(found).toMatchObject({ path: "outputs/board.png", fileKind: "image", size: 9 });
    expect(await locateFile(dir, "../outside.png")).toBeNull();
    expect(await locateFile(dir, "/etc/passwd")).toBeNull();
    expect(await locateFile(dir, "outputs/missing.png")).toBeNull();
    expect(await locateFile(dir, "outputs")).toBeNull();
  });

  it("refuses a symlink, as the file or as a folder on the way, and the scan skips it", async () => {
    /* Another team's HOME, as far as this workspace is concerned. */
    const other = await mkdtemp(path.join(os.tmpdir(), "ohf-other-team-"));
    try {
      await writeFile(path.join(other, ".env"), 'KIE_API_KEY="their-key-0123456789"');
      await mkdir(path.join(other, "renders"));
      await writeFile(path.join(other, "renders", "take.mp4"), "their take");
      await mkdir(path.join(dir, "outputs"));
      await symlink(path.join(other, ".env"), path.join(dir, "outputs", "notes.md"));
      await symlink(path.join(other, "renders"), path.join(dir, "outputs", "takes"));
      await put("outputs/own.md", "own notes");

      expect(await locateFile(dir, "outputs/notes.md")).toBeNull();
      expect(await locateFile(dir, "outputs/takes/take.mp4")).toBeNull();
      expect(await locateFile(dir, "outputs/own.md")).toMatchObject({ path: "outputs/own.md" });
      const { changed } = await scanWorkspace(dir, new Map());
      expect(changed.map((file) => file.path)).toEqual(["outputs/own.md"]);
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });

  it("streams the file into the store under the run's key", async () => {
    await put("outputs/board.png", "png bytes");
    const media = new MemoryMedia();
    const found = (await locateFile(dir, "outputs/board.png"))!;
    const draft = await uploadArtifact(media, { id: "run-1", teamId: "team-1" }, found);
    expect(draft).toEqual({
      path: "outputs/board.png",
      fileKind: "image",
      storageKey: "t/team-1/agents/run-1/outputs/board.png",
      url: "https://media.test/t/team-1/agents/run-1/outputs/board.png",
      sizeBytes: 9,
    });
    expect(media.objects.get(draft.storageKey)).toMatchObject({ contentType: "image/png" });
    expect(new TextDecoder().decode(media.objects.get(draft.storageKey)!.bytes)).toBe("png bytes");
  });
});
