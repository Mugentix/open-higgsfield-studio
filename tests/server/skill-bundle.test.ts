import { strToU8, unzipSync, zipSync, type Zippable } from "fflate";
import { describe, expect, it, vi } from "vitest";

import { SKILL_FILES_MAX, SKILL_ZIP_MAX_BYTES } from "@/server/agents-contract";
import { SKILL_UNPACKED_MAX_BYTES, formatBytes, inspectSkillBundle, parseFrontmatter, slugify } from "@/server/skill-bundle";

/* Real zips, built here, read the way the worker will have to live with
   them. The bundle rules are the ones both sides enforce. */

/* Two of these build zips of thousands of entries, which the default budget
   does not always cover while the database suites run alongside. */
vi.setConfig({ testTimeout: 15_000 });

const SKILL_MD = `---
name: Drama Ad Machine
description: Takes a product and a script and produces takes, QC reports and an edit-ready folder.
license: Proprietary. Private skill of this account.
compatibility: Python 3.10+, ffmpeg, Pillow and numpy
metadata:
  version: "1.1"
  derived-from: seedance-dr-cartoon
---

# Drama Ad Machine
`;

const AGENT_MD = `---
name: sd2-qc-inspector
description: Grades frames.
tools: Read, Bash
---
You inspect frames.
`;

function zipOf(files: Record<string, string | Uint8Array>, options: Record<string, { attrs?: number; os?: number }> = {}): Uint8Array {
  const zippable: Zippable = {};
  for (const [path, body] of Object.entries(files)) {
    const bytes = typeof body === "string" ? strToU8(body) : body;
    zippable[path] = options[path] ? [bytes, options[path]!] : bytes;
  }
  return zipSync(zippable);
}

/** Rewrites the uncompressed size a zip's central directory declares for one
    entry: the field the bundle reader trusts, as a hostile archive would. */
function declareSize(zip: Uint8Array, name: string, size: number): void {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let eocd = zip.byteLength - 22;
  while (view.getUint32(eocd, true) !== 0x06054b50) eocd--;
  let at = view.getUint32(eocd + 16, true);
  for (let i = view.getUint16(eocd + 10, true); i > 0; i--) {
    const nameLength = view.getUint16(at + 28, true);
    const entry = new TextDecoder().decode(zip.subarray(at + 46, at + 46 + nameLength));
    if (entry === name) {
      view.setUint32(at + 24, size, true);
      return;
    }
    at += 46 + nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
  }
  throw new Error(`no entry ${name}`);
}

function folder(prefix: string): Record<string, string> {
  return {
    [`${prefix}SKILL.md`]: SKILL_MD,
    [`${prefix}engine/kie.py`]: "print('hi')\n",
    [`${prefix}agents/sd2-qc-inspector.md`]: AGENT_MD,
    [`${prefix}agents/nameless.md`]: "---\ndescription: no name here\n---\n",
  };
}

describe("inspectSkillBundle: a good bundle", () => {
  it("reads a zip of a folder, drops the folder and the junk, and keeps everything else where it was", () => {
    const bundle = inspectSkillBundle(
      zipOf({
        ...folder("drama-ad-machine/"),
        "__MACOSX/drama-ad-machine/._SKILL.md": "junk",
        "drama-ad-machine/.DS_Store": "junk",
      }),
      "drama-ad-machine.zip",
    );
    expect(bundle.problems).toEqual([]);
    expect(bundle).toMatchObject({
      name: "Drama Ad Machine",
      slug: "drama-ad-machine",
      description: "Takes a product and a script and produces takes, QC reports and an edit-ready folder.",
      version: "1.1",
      compatibility: "Python 3.10+, ffmpeg, Pillow and numpy",
      agents: ["nameless", "sd2-qc-inspector"],
      files: 4,
    });
    expect(bundle.sizeBytes).toBe(
      strToU8(SKILL_MD).byteLength + strToU8("print('hi')\n").byteLength + strToU8(AGENT_MD).byteLength + strToU8("---\ndescription: no name here\n---\n").byteLength,
    );
    const inside = unzipSync(bundle.zip!);
    expect(Object.keys(inside).sort()).toEqual(["SKILL.md", "agents/nameless.md", "agents/sd2-qc-inspector.md", "engine/kie.py"]);
    expect(new TextDecoder().decode(inside["engine/kie.py"])).toBe("print('hi')\n");
  });

  it("takes files at the root as they are, and re-zips the same bundle to the same bytes", () => {
    const first = inspectSkillBundle(zipOf(folder("")));
    const second = inspectSkillBundle(zipOf(folder("")));
    expect(first.problems).toEqual([]);
    expect(first.slug).toBe("drama-ad-machine");
    expect(Object.keys(unzipSync(first.zip!)).sort()).toEqual(["SKILL.md", "agents/nameless.md", "agents/sd2-qc-inspector.md", "engine/kie.py"]);
    expect(Buffer.from(first.zip!).equals(Buffer.from(second.zip!))).toBe(true);
  });

  it("reads a plain version and a nested metadata.version, preferring the plain one", () => {
    const plain = inspectSkillBundle(zipOf({ "SKILL.md": "---\nname: x\ndescription: y\nversion: 2.0\nmetadata:\n  version: 9\n---\n" }));
    expect(plain).toMatchObject({ version: "2.0", compatibility: null, agents: [], files: 1 });
    const nested = inspectSkillBundle(zipOf({ "SKILL.md": "---\nname: x\ndescription: y\nmetadata:\n  version: '3'\n---\n" }));
    expect(nested.version).toBe("3");
  });

  it("normalises Windows separators in entry names", () => {
    const bundle = inspectSkillBundle(zipOf({ "skill\\SKILL.md": SKILL_MD, "skill\\scripts\\run.py": "x" }));
    expect(bundle.problems).toEqual([]);
    expect(Object.keys(unzipSync(bundle.zip!)).sort()).toEqual(["SKILL.md", "scripts/run.py"]);
  });
});

describe("inspectSkillBundle: refusals", () => {
  it("refuses bytes that are not a zip, and an empty zip", () => {
    expect(inspectSkillBundle(strToU8("hello"), "notes.txt")).toMatchObject({
      name: "notes.txt",
      slug: "notes-txt",
      problems: ["Not a zip file"],
      zip: null,
    });
    expect(inspectSkillBundle(zipOf({ "a/": new Uint8Array() }), "empty.zip").problems).toEqual(["The zip is empty"]);
  });

  it("refuses a zip over the size limit before reading it", () => {
    const bundle = inspectSkillBundle(new Uint8Array(SKILL_ZIP_MAX_BYTES + 1), "big.zip");
    expect(bundle.problems).toEqual([`The zip is ${formatBytes(SKILL_ZIP_MAX_BYTES + 1)}; the limit is ${formatBytes(SKILL_ZIP_MAX_BYTES)}`]);
    expect(bundle.name).toBe("big");
  });

  it("refuses too many files", () => {
    const files: Record<string, string> = { "SKILL.md": SKILL_MD };
    for (let i = 0; i < SKILL_FILES_MAX; i++) files[`refs/${i}.md`] = "";
    expect(inspectSkillBundle(zipOf(files)).problems).toEqual([`The zip holds ${SKILL_FILES_MAX + 1} files; the limit is ${SKILL_FILES_MAX}`]);
  });

  it("refuses traversal, absolute paths and drive letters, naming the entries", () => {
    const bundle = inspectSkillBundle(
      zipOf({
        "SKILL.md": SKILL_MD,
        "../escape.py": "x",
        "/etc/passwd": "x",
        "C:/windows/system32/x.dll": "x",
        "fine/../still-fine.md": "x",
      }),
    );
    expect(bundle.problems).toEqual(['Unsafe path: "../escape.py", "/etc/passwd", "C:/windows/system32/x.dll", "fine/../still-fine.md"']);
    expect(bundle.zip).toBeNull();
  });

  it("refuses a symbolic link by its unix mode, and lists only the first few", () => {
    const files: Record<string, string> = { "SKILL.md": SKILL_MD };
    const options: Record<string, { attrs: number; os: number }> = {};
    for (let i = 0; i < 7; i++) {
      files[`link${i}`] = "/etc/passwd";
      options[`link${i}`] = { attrs: 0o120777 << 16, os: 3 };
    }
    files["regular.py"] = "x";
    options["regular.py"] = { attrs: 0o100755 << 16, os: 3 };
    const bundle = inspectSkillBundle(zipOf(files, options));
    expect(bundle.problems).toEqual(['Symbolic link: "link0", "link1", "link2", "link3", "link4" and 2 more']);
  });

  it("refuses a bundle that unpacks past the limit, by the size the directory declares", () => {
    /* The declared size is what counts, so a small zip whose directory claims
       three times the limit is refused before a byte is inflated. */
    const zip = zipOf({ "SKILL.md": SKILL_MD, "pad/zeros.bin": new Uint8Array(16) });
    declareSize(zip, "pad/zeros.bin", 3 * SKILL_UNPACKED_MAX_BYTES);
    const bundle = inspectSkillBundle(zip);
    expect(bundle.problems).toEqual([`The bundle unpacks to ${formatBytes(3 * SKILL_UNPACKED_MAX_BYTES + strToU8(SKILL_MD).byteLength)}; the limit is 200 MB`]);
    expect(bundle.zip).toBeNull();
  });

  it("refuses a zip without SKILL.md at the root or in one folder, and one with files outside the folder", () => {
    expect(inspectSkillBundle(zipOf({ "a/SKILL.md": SKILL_MD, "b/SKILL.md": SKILL_MD })).problems).toEqual(['Outside the skill folder "a": "b/SKILL.md"']);
    expect(inspectSkillBundle(zipOf({ "docs/readme.md": "x" })).problems).toEqual([
      "No SKILL.md at the bundle root or inside a single top-level folder",
    ]);
    expect(inspectSkillBundle(zipOf({ "a/SKILL.md": SKILL_MD, "b/stray.md": "x" })).problems).toEqual(['Outside the skill folder "a": "b/stray.md"']);
  });

  it("keeps a bundle whose SKILL.md lacks a name or a description, named after the file", () => {
    const bundle = inspectSkillBundle(zipOf({ "SKILL.md": "# No frontmatter\n", "run.py": "x" }), "My Skill (final).zip");
    expect(bundle).toMatchObject({
      name: "My Skill (final)",
      slug: "my-skill-final",
      description: "",
      files: 2,
      zip: null,
      problems: ["SKILL.md has no `name` in its frontmatter", "SKILL.md has no `description` in its frontmatter"],
    });
    const nameless = inspectSkillBundle(zipOf({ "SKILL.md": "---\nname: '***'\ndescription: fine\n---\n" }), "odd.zip");
    expect(nameless.problems).toEqual(['The name "***" leaves no letters or digits for a folder name']);
    expect(nameless.slug).toBe("odd");
  });
});

describe("parseFrontmatter", () => {
  it("reads scalars, quotes, comments, nesting and block scalars", () => {
    const out = parseFrontmatter(`---
name: "Quoted: \\"name\\""   # a comment
description: 'single # not a comment'
tools: Read, Write, Bash
metadata:
  version: "1.1"
  updated: 2026-10-01
folded: >
  one
  two
literal: |
  line a
  line b
after: done
---
# Body
name: not frontmatter
`);
    expect(out).toEqual({
      name: 'Quoted: "name"',
      description: "single # not a comment",
      tools: "Read, Write, Bash",
      "metadata.version": "1.1",
      "metadata.updated": "2026-10-01",
      folded: "one two",
      literal: "line a\nline b",
      after: "done",
    });
  });

  it("joins a plain value that wraps onto indented lines", () => {
    expect(parseFrontmatter("---\ndescription: a long\n  line that\n  wraps\nname: x\n---\n")).toEqual({
      description: "a long line that wraps",
      name: "x",
    });
  });

  it("answers nothing for a file without frontmatter, or with an unclosed block", () => {
    expect(parseFrontmatter("# Title\nname: x\n")).toEqual({});
    expect(parseFrontmatter("---\nname: x\n")).toEqual({});
    expect(parseFrontmatter("\uFEFF---\nname: bom\n---\n")).toEqual({ name: "bom" });
  });
});

describe("slugify", () => {
  it.each([
    ["Drama Ad Machine", "drama-ad-machine"],
    ["  seedance_dr-cartoon  ", "seedance-dr-cartoon"],
    ["Été 2026!", "t-2026"],
    ["***", ""],
  ])("%s → %s", (name, slug) => {
    expect(slugify(name)).toBe(slug);
  });

  it("caps at 64 characters", () => {
    expect(slugify("a".repeat(100))).toHaveLength(64);
  });
});

describe("formatBytes", () => {
  it.each([
    [512, "512 B"],
    [1536, "2 KB"],
    [156 * 1024, "156 KB"],
    [1.5 * 1024 * 1024, "1.5 MB"],
    [50 * 1024 * 1024, "50 MB"],
  ])("%d → %s", (bytes, text) => {
    expect(formatBytes(bytes)).toBe(text);
  });
});
