import { strToU8, zipSync } from "fflate";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { dotenv, ensureHome, fetchInputs, homePaths, installSkill, prepareWorkspace, safeFileName } from "../../worker/home";
import { MemoryMedia, memoryReader, skillRecord } from "./doubles";

let root: string;
let media: MemoryMedia;

function zipOf(files: Record<string, string>): Uint8Array {
  return zipSync(Object.fromEntries(Object.entries(files).map(([name, body]) => [name, strToU8(body)])));
}

const BUNDLE = {
  "SKILL.md": "---\nname: Drama Ad Machine\ndescription: Makes ads.\n---\n# Drama\n",
  "scripts/kie.py": "print('hi')\n",
  "agents/sd2-qc.md": "---\nname: sd2-qc-inspector\n---\nInspect.\n",
  "references/notes.md": "notes",
};

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "ohf-homes-"));
  media = new MemoryMedia();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("homePaths and ensureHome", () => {
  it("lays a team's HOME out under the root and refuses an odd team id", () => {
    const home = homePaths(root, "team-1");
    expect(home).toEqual({
      teamId: "team-1",
      dir: path.join(root, "team-1"),
      claudeDir: path.join(root, "team-1", ".claude"),
      skillsDir: path.join(root, "team-1", ".claude", "skills"),
      agentsDir: path.join(root, "team-1", ".claude", "agents"),
      documentsDir: path.join(root, "team-1", "Documents"),
      runsDir: path.join(root, "team-1", "runs"),
    });
    expect(() => homePaths(root, "../etc")).toThrow(/Unsafe team id/);
  });

  it("creates the folders, private to the worker user", async () => {
    const home = await ensureHome(root, "team-1");
    for (const dir of [home.claudeDir, home.skillsDir, home.agentsDir, home.documentsDir, home.runsDir]) {
      const info = await stat(dir);
      expect(info.isDirectory()).toBe(true);
      expect(info.mode & 0o777).toBe(0o700);
    }
  });
});

describe("installSkill", () => {
  it("unpacks the bundle under .claude/skills/<slug>, copies agents, and skips when current", async () => {
    const home = await ensureHome(root, "team-1");
    const skill = skillRecord();
    await media.put(skill.storageKey, zipOf(BUNDLE), "application/zip");

    const first = await installSkill(home, skill, memoryReader(media));
    expect(first).toEqual({ installed: true, files: 4 });
    const folder = path.join(home.skillsDir, "drama-ad-machine");
    expect(await readFile(path.join(folder, "SKILL.md"), "utf8")).toContain("name: Drama Ad Machine");
    expect((await stat(path.join(folder, "scripts/kie.py"))).mode & 0o111).not.toBe(0);
    expect(await readFile(path.join(home.agentsDir, "sd2-qc.md"), "utf8")).toContain("sd2-qc-inspector");
    expect((await readdir(home.skillsDir)).sort()).toEqual(["drama-ad-machine"]);

    const again = await installSkill(home, skill, memoryReader(media));
    expect(again).toEqual({ installed: false, files: skill.files });
  });

  it("replaces an older version whole", async () => {
    const home = await ensureHome(root, "team-1");
    const v1 = skillRecord({ version: "1.0" });
    await media.put(v1.storageKey, zipOf({ ...BUNDLE, "scripts/old.py": "old" }), "application/zip");
    await installSkill(home, v1, memoryReader(media));
    const folder = path.join(home.skillsDir, "drama-ad-machine");
    expect(await stat(path.join(folder, "scripts/old.py"))).toBeTruthy();

    const v2 = skillRecord({ version: "2.0", storageKey: "t/team-1/skills/skill-1.zip" });
    await media.put(v2.storageKey, zipOf({ ...BUNDLE, "SKILL.md": BUNDLE["SKILL.md"].replace("Makes ads.", "Makes better ads.") }), "application/zip");
    expect(await installSkill(home, v2, memoryReader(media))).toEqual({ installed: true, files: 4 });
    expect(await readFile(path.join(folder, "SKILL.md"), "utf8")).toContain("better");
    await expect(stat(path.join(folder, "scripts/old.py"))).rejects.toThrow();
    expect((await readdir(home.skillsDir)).sort()).toEqual(["drama-ad-machine"]);
  });

  it("refuses a bundle with a traversal, a missing SKILL.md, or a skill that is not ready", async () => {
    const home = await ensureHome(root, "team-1");
    const bad = skillRecord({ id: "bad" });
    await media.put(bad.storageKey, zipOf({ "SKILL.md": "x", "../escape.py": "boom" }), "application/zip");
    await expect(installSkill(home, bad, memoryReader(media))).rejects.toThrow(/Unsafe path/);
    expect(await readdir(home.skillsDir)).toEqual([]);

    const headless = skillRecord({ id: "headless", storageKey: "t/x/headless.zip" });
    await media.put(headless.storageKey, zipOf({ "README.md": "no skill" }), "application/zip");
    await expect(installSkill(home, headless, memoryReader(media))).rejects.toThrow(/no SKILL.md/);

    await expect(installSkill(home, skillRecord({ status: "invalid" }), memoryReader(media))).rejects.toThrow(/invalid/);
  });
});

describe("prepareWorkspace", () => {
  it("creates inputs/, outputs/ and a private .env, and lays the attachments in by name", async () => {
    const home = await ensureHome(root, "team-1");
    await media.put("t/team-1/u/2026/10/a.png", new Uint8Array([1, 2, 3]), "image/png");
    const fetched: string[] = [];
    const workspace = await prepareWorkspace(home, { id: "run-1" }, {
      attachments: [
        { name: "ref.png", url: "https://media.test/t/team-1/u/2026/10/a.png" },
        { name: "ref.png", url: "https://elsewhere.test/other.png" },
        { name: "Weird name?.mp4", url: "https://media.test/t/team-1/u/2026/10/a.png" },
      ],
      env: { KIE_API_KEY: "kie-0123456789abcdef", EMPTY: "", HF_KEY: 'with "quote" and $dollar' },
      objects: memoryReader(media),
      fetch: async (url) => {
        fetched.push(url);
        return new Uint8Array([9]);
      },
    });
    expect(workspace).toMatchObject({ runId: "run-1", dir: path.join(home.runsDir, "run-1") });
    expect(workspace.inputs).toEqual(["inputs/ref.png", "inputs/ref-2.png", "inputs/Weird name_.mp4"]);
    expect(fetched).toEqual(["https://elsewhere.test/other.png"]);
    expect(await readFile(path.join(workspace.inputsDir, "ref.png"))).toEqual(Buffer.from([1, 2, 3]));
    expect(await readFile(path.join(workspace.inputsDir, "ref-2.png"))).toEqual(Buffer.from([9]));
    expect((await stat(workspace.outputsDir)).isDirectory()).toBe(true);
    expect((await stat(workspace.envFile)).mode & 0o777).toBe(0o600);
    expect(await readFile(workspace.envFile, "utf8")).toBe('KIE_API_KEY="kie-0123456789abcdef"\nHF_KEY="with \\"quote\\" and \\$dollar"\n');
  });

  it("keeps a file that is already there instead of fetching it again", async () => {
    const home = await ensureHome(root, "team-1");
    let reads = 0;
    const objects = { ...memoryReader(media), read: async () => (reads++, new Uint8Array([1])) };
    const workspace = await prepareWorkspace(home, { id: "run-2" }, { attachments: [{ name: "a.png", url: "https://media.test/k" }], env: {}, objects });
    expect(reads).toBe(1);
    expect(await fetchInputs(workspace.inputsDir, [{ name: "a.png", url: "https://media.test/k" }], objects)).toEqual(["a.png"]);
    expect(reads).toBe(1);
  });

  it("gives a different file sent later under a taken name its own name, and reuses only the same source", async () => {
    const home = await ensureHome(root, "team-1");
    await media.put("t/team-1/u/a", new Uint8Array([1]), "image/png");
    await media.put("t/team-1/u/b", new Uint8Array([2]), "image/png");
    const objects = memoryReader(media);
    const workspace = await prepareWorkspace(home, { id: "run-3" }, { attachments: [{ name: "ref.png", url: "https://media.test/t/team-1/u/a" }], env: {}, objects });
    expect(workspace.inputs).toEqual(["inputs/ref.png"]);

    /* A reply attaches another file that happens to carry the same name. */
    expect(await fetchInputs(workspace.inputsDir, [{ name: "ref.png", url: "https://media.test/t/team-1/u/b" }], objects)).toEqual(["ref-2.png"]);
    expect(await readFile(path.join(workspace.inputsDir, "ref.png"))).toEqual(Buffer.from([1]));
    expect(await readFile(path.join(workspace.inputsDir, "ref-2.png"))).toEqual(Buffer.from([2]));
    expect(JSON.parse(await readFile(path.join(workspace.inputsDir, ".manifest.json"), "utf8"))).toEqual({
      "ref.png": "https://media.test/t/team-1/u/a",
      "ref-2.png": "https://media.test/t/team-1/u/b",
    });

    /* The first file again, and a third under the same name: the first is reused, the third is numbered on. */
    expect(
      await fetchInputs(
        workspace.inputsDir,
        [
          { name: "ref.png", url: "https://media.test/t/team-1/u/a" },
          { name: "ref.png", url: "https://elsewhere.test/c.png" },
        ],
        objects,
        async () => new Uint8Array([3]),
      ),
    ).toEqual(["ref.png", "ref-3.png"]);
    expect((await readdir(workspace.inputsDir)).sort()).toEqual([".manifest.json", "ref-2.png", "ref-3.png", "ref.png"]);
  });
});

describe("dotenv and safeFileName", () => {
  it("writes quoted KEY=value lines and drops odd keys and empty values", () => {
    expect(dotenv({ A_KEY: "x y", "bad-key": "z", EMPTY: "", B: "1" })).toBe('A_KEY="x y"\nB="1"\n');
  });

  it("keeps a usable file name and borrows the extension from the url", () => {
    expect(safeFileName("../../etc/passwd")).toBe("passwd");
    expect(safeFileName("My Take (1).png")).toBe("My Take (1).png");
    expect(safeFileName("", "https://x/y/clip.mp4?sig=1")).toBe("attachment.mp4");
    expect(safeFileName("..hidden")).toBe("hidden");
    expect(safeFileName("a/b/c:d*e.wav")).toBe("c_d_e.wav");
  });
});
