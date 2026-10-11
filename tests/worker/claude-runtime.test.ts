import { strToU8, zipSync } from "fflate";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createLogger } from "../../worker/log";
import { Masker } from "../../worker/mask";
import { runAgent } from "../../worker/run";
import type { StudioHooks } from "../../worker/runtime";
import { homePaths } from "../../worker/home";
import { ALLOWED_TOOLS, ClaudeRuntime, EDIT_TOOLS, managedSettingsFor, refusedWrite, staleGatesPrompt } from "../../worker/runtimes/claude";
import { createStudioServer, studioToolDefinitions } from "../../worker/studio-tools";
import { MemoryMedia, MemoryWorkerStore, memoryReader, runRecord, skillRecord } from "./doubles";

/* The SDK runtime cannot run a model here (no key), but the pieces around
   the model can be held to account: the no-key guard fails the run with a
   message a person reads, the tool list leaves Bash, AskUserQuestion and the
   file tools to canUseTool, the policy tier pins what settings files cannot
   widen, a write under .claude/ is refused, and the studio's MCP server
   builds from zod schemas at runtime. */

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "ohf-claude-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("ClaudeRuntime", () => {
  it("fails a run with a clear error when the worker has no Anthropic credential", async () => {
    const media = new MemoryMedia();
    const store = new MemoryWorkerStore();
    const skill = skillRecord();
    await media.put(skill.storageKey, zipSync({ "SKILL.md": strToU8("---\nname: Drama Ad Machine\ndescription: x\n---\n") }), "application/zip");
    const run = runRecord();
    store.seed(run, skill);

    const end = await runAgent((await store.claimRun("w1"))!, {
      store,
      media,
      objects: memoryReader(media),
      runtime: new ClaudeRuntime(),
      homeRoot: root,
      workerId: "w1",
      credentials: async () => ({}),
      processEnv: { PATH: "/usr/bin" },
      signal: new AbortController().signal,
      log: createLogger(new Masker({}), { sink: () => undefined }),
      leaseRenewMs: 1_000,
      inboxPollMs: 20,
    });
    expect(end).toEqual({ status: "failed", error: expect.stringMatching(/no ANTHROPIC_API_KEY/) });
    const kinds = store.payloads(run.id).map((payload) => payload.kind);
    expect(kinds).toEqual(["user", "status", "error", "status"]);
    expect(store.run(run.id)).toMatchObject({ status: "failed", error: expect.stringMatching(/ANTHROPIC_API_KEY/) });
  });

  it("leaves Bash, AskUserQuestion and the file tools out of the auto-allowed tools so canUseTool sees them", () => {
    expect(ALLOWED_TOOLS).not.toContain("Bash");
    expect(ALLOWED_TOOLS).not.toContain("AskUserQuestion");
    for (const tool of EDIT_TOOLS) expect(ALLOWED_TOOLS).not.toContain(tool);
    expect(ALLOWED_TOOLS).toContain("Read");
    expect(ALLOWED_TOOLS).toContain("mcp__studio__publish");
    expect(ALLOWED_TOOLS).toContain("Task");
  });
});

describe("the policy tier and the .claude/ fence", () => {
  const home = homePaths("/srv/agent-homes", "team-1");
  const workspace = { dir: "/srv/agent-homes/team-1/runs/run-1" };

  it("pins Bash to ask, denies the file tools under both .claude/ by absolute path, and takes hooks from managed settings only", () => {
    const settings = managedSettingsFor(home, workspace);
    expect(settings.permissions?.ask).toEqual(["Bash"]);
    expect(settings.permissions?.allow).toBeUndefined();
    expect(settings.permissions?.deny).toEqual(
      expect.arrayContaining([
        "Write(//srv/agent-homes/team-1/.claude/**)",
        "Edit(//srv/agent-homes/team-1/.claude/**)",
        "MultiEdit(//srv/agent-homes/team-1/.claude/**)",
        "NotebookEdit(//srv/agent-homes/team-1/.claude/**)",
        "Write(//srv/agent-homes/team-1/runs/run-1/.claude/**)",
        "Edit(//srv/agent-homes/team-1/runs/run-1/.claude/**)",
      ]),
    );
    expect(settings.permissions?.deny).toHaveLength(EDIT_TOOLS.length * 2);
    expect(settings.allowManagedHooksOnly).toBe(true);
  });

  it("refuses a settings, hooks, agents or skills write in the agent's HOME, and a .claude/ write in the workspace", () => {
    const refused = (tool: string, file: string) => refusedWrite(home, workspace, tool, { file_path: file });
    expect(refused("Write", "/srv/agent-homes/team-1/.claude/settings.json")).toMatch(/not allowed/);
    expect(refused("Edit", "/srv/agent-homes/team-1/.claude/settings.local.json")).toMatch(/not allowed/);
    expect(refused("Write", "/srv/agent-homes/team-1/.claude/hooks/pre.sh")).toMatch(/not allowed/);
    expect(refused("MultiEdit", "/srv/agent-homes/team-1/.claude/agents/root.md")).toMatch(/not allowed/);
    expect(refused("Write", "/srv/agent-homes/team-1/.claude/skills/drama-ad-machine/SKILL.md")).toMatch(/not allowed/);
    expect(refused("Write", "~/.claude/settings.json")).toMatch(/not allowed/);
    expect(refused("Write", ".claude/settings.json")).toMatch(/not allowed/);
    expect(refused("Write", "outputs/../.claude/hooks.json")).toMatch(/not allowed/);
    expect(refusedWrite(home, workspace, "NotebookEdit", { notebook_path: "/srv/agent-homes/team-1/.claude/x.ipynb" })).toMatch(/not allowed/);
  });

  it("lets every other write and every other tool through", () => {
    const refused = (tool: string, file: string) => refusedWrite(home, workspace, tool, { file_path: file });
    expect(refused("Write", "outputs/plan.md")).toBeNull();
    expect(refused("Edit", "/srv/agent-homes/team-1/runs/run-1/scripts/qc.py")).toBeNull();
    expect(refused("Write", "/srv/agent-homes/team-1/Documents/drama/plan.md")).toBeNull();
    expect(refused("Write", "/srv/agent-homes/team-1/.claude-notes.md")).toBeNull();
    expect(refused("Read", "/srv/agent-homes/team-1/.claude/settings.json")).toBeNull();
    expect(refusedWrite(home, workspace, "Bash", { command: "cat ~/.claude/settings.json" })).toBeNull();
    expect(refusedWrite(home, workspace, "Write", {})).toBeNull();
  });
});

describe("staleGatesPrompt", () => {
  it("says nothing when nothing was settled", () => {
    expect(staleGatesPrompt({ kind: "gates", answers: [], approvals: [] })).toBeNull();
  });

  it("tells the resumed session what the team answered and that an approved command never ran", () => {
    const prompt = staleGatesPrompt({
      kind: "gates",
      answers: [{ questionId: "q1", answers: { "Which angle?": "Pain", Formats: ["9:16", "1:1"] }, by: "Ada" }],
      approvals: [
        { approvalId: "a1", decision: "approved", by: "Ada" },
        { approvalId: "a2", decision: "denied", by: null },
      ],
    });
    expect(prompt).toContain("resumed after a worker restart");
    expect(prompt).toContain("- Answered by Ada: Which angle? → Pain; Formats → 9:16, 1:1");
    expect(prompt).toContain("- Approved by Ada the command that was held for approval. It did not run");
    expect(prompt).toContain("- Declined the command that was held for approval.");
    expect(prompt?.endsWith("Continue from there.")).toBe(true);
  });
});

describe("studio tools", () => {
  const calls: string[] = [];
  const hooks: StudioHooks = {
    publish: async (file, title) => (calls.push(`publish ${file} ${title}`), { url: "https://media.test/x.png" }),
    note: async (text) => void calls.push(`note ${text}`),
    reportCredits: async (credits) => void calls.push(`credits ${credits}`),
    settleQuestion: async () => undefined,
    settleApproval: async () => undefined,
  };

  it("builds an in-process MCP server named studio with the three tools", () => {
    const server = createStudioServer(hooks);
    expect(server).toMatchObject({ type: "sdk", name: "studio" });
    expect(server.instance).toBeTruthy();
    expect(studioToolDefinitions(hooks).map((definition) => definition.name)).toEqual(["publish", "note", "report_credits"]);
  });

  /** The definitions as the MCP server calls them: by name, with whatever the schema passed. */
  type Loose = { name: string; handler: (args: Record<string, unknown>, extra: unknown) => Promise<unknown> };
  const loose = (definitions: ReturnType<typeof studioToolDefinitions>) => definitions as unknown as Loose[];

  it("answers through the hooks and turns a failed publish into a tool error", async () => {
    const [publish, note, credits] = loose(studioToolDefinitions(hooks));
    expect(await publish!.handler({ path: "outputs/a.png", title: "Board" }, {})).toEqual({ content: [{ type: "text", text: "Published outputs/a.png → https://media.test/x.png" }] });
    expect(await note!.handler({ text: "kept the 9:16" }, {})).toEqual({ content: [{ type: "text", text: "Noted." }] });
    expect(await credits!.handler({ credits: 12 }, {})).toEqual({ content: [{ type: "text", text: "Recorded 12 credits." }] });
    expect(calls).toEqual(["publish outputs/a.png Board", "note kept the 9:16", "credits 12"]);

    const failing = loose(studioToolDefinitions({ ...hooks, publish: async () => Promise.reject(new Error("No file at nope.png inside the run's working directory")) }));
    expect(await failing[0]!.handler({ path: "nope.png" }, {})).toEqual({
      content: [{ type: "text", text: "Could not publish nope.png: No file at nope.png inside the run's working directory" }],
      isError: true,
    });
  });
});
