import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { envForTests, resetStubs, seedTeam, useTestDatabase, type TestDb } from "./harness";

import * as schema from "@/server/db/schema";
import { STARTER_TEMPLATES } from "@/openhiggsfield/templates";
import { requireTeam, type TeamContext } from "@/server/team";
import { createTemplate, deleteTemplate, listTemplates, updateTemplate, useTemplate } from "@/server/template-actions";
import {
  canEditTemplate,
  countTemplateUse,
  editTemplate,
  removeTemplate,
  saveTemplate,
  templatesFor,
  type TemplateInput,
} from "@/server/templates";

/* The actions read the session through next/headers; here requireTeam is a
   mock that answers with the seeded team. The core takes the team directly. */
vi.mock("@/server/team", () => ({ requireTeam: vi.fn() }));

/* Every test boots its own PGlite, which takes a moment more than the default
   budget allows. */
vi.setConfig({ testTimeout: 30_000 });

let db: TestDb;
let team: TeamContext;
let acme: string;
let glow: string;

beforeEach(async () => {
  envForTests();
  db = await useTestDatabase();
  team = await seedTeam(db, { name: "Ada" });
  vi.mocked(requireTeam).mockReset();
  vi.mocked(requireTeam).mockResolvedValue(team);
  acme = await addProduct(team, "Acme Serum");
  glow = await addProduct(team, "Glow");
});

afterEach(() => resetStubs());

async function addProduct(owner: TeamContext, name: string): Promise<string> {
  const id = randomUUID();
  await db.insert(schema.products).values({ id, teamId: owner.teamId, name, slug: name.toLowerCase().replace(/\s+/g, "-"), createdBy: owner.userId });
  return id;
}

async function addMember(owner: TeamContext, name: string, role: "admin" | "member"): Promise<TeamContext> {
  const userId = randomUUID();
  await db.insert(schema.user).values({ id: userId, name, email: `${userId.slice(0, 8)}@example.com`, emailVerified: true });
  await db.insert(schema.member).values({ id: randomUUID(), organizationId: owner.teamId, userId, role, createdAt: new Date() });
  return { ...owner, userId, userName: name, role };
}

/** Two saves can land in the same millisecond; the order under test is the
    column's, so the rows are stamped by hand. */
async function stamp(id: string, iso: string) {
  await db.update(schema.promptTemplates).set({ createdAt: new Date(iso) }).where(eq(schema.promptTemplates.id, id));
}

const input = (over: Partial<TemplateInput> = {}): TemplateInput => ({
  title: "Hero",
  body: "{{product}} on a clean surface",
  tags: ["hero"],
  surface: "image",
  productId: null,
  ...over,
});

describe("templatesFor", () => {
  it("lists the team-wide templates and the product's, newest first, and never another team's", async () => {
    const wide = await saveTemplate(team, input({ title: "Wide" }));
    const forAcme = await saveTemplate(team, input({ title: "Acme only", productId: acme }));
    const forGlow = await saveTemplate(team, input({ title: "Glow only", productId: glow }));
    await stamp(wide.id, "2026-09-01T00:00:00Z");
    await stamp(forAcme.id, "2026-09-02T00:00:00Z");
    await stamp(forGlow.id, "2026-09-03T00:00:00Z");
    const other = await seedTeam(db, { name: "Other" });
    await saveTemplate(other, input({ title: "Theirs" }));

    expect((await templatesFor(team, acme)).map((t) => t.title)).toEqual(["Acme only", "Wide"]);
    expect((await templatesFor(team, glow)).map((t) => t.title)).toEqual(["Glow only", "Wide"]);
    expect((await templatesFor(team)).map((t) => t.title)).toEqual(["Wide"]);
    expect((await templatesFor(other)).map((t) => t.title)).toEqual(["Theirs"]);
  });

  it("answers the row as saved: tags, surface, zero uses, who saved it", async () => {
    const saved = await saveTemplate(team, input({ tags: ["hero", "packshot"], surface: "image", productId: acme }));
    expect(saved).toMatchObject({
      productId: acme,
      title: "Hero",
      body: "{{product}} on a clean surface",
      tags: ["hero", "packshot"],
      surface: "image",
      uses: 0,
      createdBy: team.userId,
    });
    expect(Number.isInteger(saved.createdAt)).toBe(true);
    expect(await templatesFor(team, acme)).toEqual([saved]);
  });

  it("refuses a product of another team, or one that does not exist", async () => {
    const other = await seedTeam(db);
    const theirs = await addProduct(other, "Theirs");
    await expect(saveTemplate(team, input({ productId: theirs }))).rejects.toThrow("No such product");
    await expect(saveTemplate(team, input({ productId: randomUUID() }))).rejects.toThrow("No such product");
    expect(await templatesFor(team, theirs)).toEqual([]);
  });
});

describe("countTemplateUse", () => {
  it("answers the body and counts one more use each time", async () => {
    const saved = await saveTemplate(team, input());
    expect(await countTemplateUse(team, saved.id)).toBe(saved.body);
    expect(await countTemplateUse(team, saved.id)).toBe(saved.body);
    const [row] = await templatesFor(team);
    expect(row?.uses).toBe(2);
    /* Using is not editing. */
    expect(row?.updatedAt).toBe(saved.updatedAt);
  });

  it("does not count, or answer, for another team", async () => {
    const saved = await saveTemplate(team, input());
    const other = await seedTeam(db);
    await expect(countTemplateUse(other, saved.id)).rejects.toThrow("No such template");
    expect((await templatesFor(team))[0]?.uses).toBe(0);
  });
});

describe("removeTemplate", () => {
  it("lets who saved it, an admin and the owner remove; keeps a member off a teammate's", async () => {
    const ben = await addMember(team, "Ben", "member");
    const cat = await addMember(team, "Cat", "admin");
    const adas = await saveTemplate(team, input({ title: "Ada's" }));
    const bens = await saveTemplate(ben, input({ title: "Ben's" }));
    const bensSecond = await saveTemplate(ben, input({ title: "Ben's second" }));

    expect(canEditTemplate(ben, adas)).toBe(false);
    expect(canEditTemplate(ben, bens)).toBe(true);
    expect(canEditTemplate(cat, bens)).toBe(true);
    await expect(removeTemplate(ben, adas.id)).rejects.toMatchObject({
      name: "ForbiddenError",
      message: "Only who saved a template, or an admin, can change it",
    });
    expect((await templatesFor(team)).map((t) => t.title).sort()).toEqual(["Ada's", "Ben's", "Ben's second"]);

    expect(await removeTemplate(ben, bens.id)).toBeNull();
    expect(await removeTemplate(cat, bensSecond.id)).toBeNull();
    expect(await removeTemplate(team, adas.id)).toBeNull();
    expect(await templatesFor(team)).toEqual([]);
  });

  it("does not find another team's template to remove", async () => {
    const saved = await saveTemplate(team, input());
    const other = await seedTeam(db);
    await expect(removeTemplate(other, saved.id)).rejects.toThrow("No such template");
    expect(await templatesFor(team)).toHaveLength(1);
  });
});

describe("editTemplate", () => {
  it("changes the fields given, stamps updated_at, and can re-scope to a product of the team", async () => {
    const saved = await saveTemplate(team, input());
    const edited = await editTemplate(team, saved.id, { title: "Hero v2", productId: acme, tags: [] });
    expect(edited).toMatchObject({ id: saved.id, title: "Hero v2", body: saved.body, productId: acme, tags: [], surface: "image" });
    expect(edited.updatedAt).toBeGreaterThanOrEqual(saved.updatedAt);
    expect((await templatesFor(team, acme)).map((t) => t.title)).toEqual(["Hero v2"]);
    expect(await templatesFor(team)).toEqual([]);
  });

  it("holds the same guard as removing", async () => {
    const ben = await addMember(team, "Ben", "member");
    const adas = await saveTemplate(team, input());
    await expect(editTemplate(ben, adas.id, { title: "Mine now" })).rejects.toMatchObject({ name: "ForbiddenError" });
    const other = await seedTeam(db);
    const theirs = await addProduct(other, "Theirs");
    await expect(editTemplate(team, adas.id, { productId: theirs })).rejects.toThrow("No such product");
    expect((await templatesFor(team))[0]?.title).toBe("Hero");
  });
});

describe("the actions", () => {
  it("creates, lists, uses and deletes for the signed-in team", async () => {
    const created = await createTemplate({ title: "Hook", body: "Open on {{product}}", tags: ["hook"], surface: "video", productId: acme });
    if (!created.ok) throw new Error(created.error);
    expect(created.data).toMatchObject({ title: "Hook", productId: acme, surface: "video", tags: ["hook"], uses: 0 });

    const listed = await listTemplates({ productId: acme });
    if (!listed.ok) throw new Error(listed.error);
    expect(listed.data.map((t) => t.id)).toEqual([created.data.id]);
    expect(await listTemplates({})).toEqual({ ok: true, data: [] });
    expect(await listTemplates(undefined)).toEqual({ ok: true, data: [] });

    expect(await useTemplate({ id: created.data.id })).toEqual({ ok: true, data: "Open on {{product}}" });
    const again = await listTemplates({ productId: acme });
    if (!again.ok) throw new Error(again.error);
    expect(again.data[0]?.uses).toBe(1);

    const updated = await updateTemplate({ id: created.data.id, surface: "any", productId: null });
    if (!updated.ok) throw new Error(updated.error);
    expect(updated.data).toMatchObject({ surface: "any", productId: null, title: "Hook" });

    expect(await deleteTemplate({ id: created.data.id })).toEqual({ ok: true, data: null });
    expect(await listTemplates({ productId: acme })).toEqual({ ok: true, data: [] });
    expect(await useTemplate({ id: created.data.id })).toEqual({ ok: false, error: "No such template" });
  });

  it("validates the title, the body, the surface, the tags and the product", async () => {
    expect(await createTemplate({ body: "x" })).toEqual({ ok: false, error: "Give the template a title" });
    expect(await createTemplate({ title: "T", body: "   " })).toEqual({ ok: false, error: "A template needs a prompt" });
    expect(await createTemplate({ title: "T", body: "b", surface: "audio" })).toEqual({ ok: false, error: "Pick image, video or any" });
    expect(await createTemplate({ title: "T", body: "b", tags: "hook" })).toEqual({ ok: false, error: "Tags come as a list" });
    expect(await createTemplate({ title: "T", body: "b", productId: randomUUID() })).toEqual({ ok: false, error: "No such product" });
    expect(await deleteTemplate({})).toEqual({ ok: false, error: "No such template" });

    const ok = await createTemplate({ title: "  T ", body: " b ", tags: ["UGC", " ugc", "", 4, "Hook"] });
    if (!ok.ok) throw new Error(ok.error);
    expect(ok.data).toMatchObject({ title: "T", body: "b", tags: ["ugc", "hook"], surface: "any", productId: null });
  });

  it("folds a member's refusal into a forbidden code", async () => {
    const saved = await saveTemplate(team, input());
    vi.mocked(requireTeam).mockResolvedValue(await addMember(team, "Ben", "member"));
    expect(await deleteTemplate({ id: saved.id })).toEqual({
      ok: false,
      error: "Only who saved a template, or an admin, can change it",
      code: "forbidden",
    });
    expect(await updateTemplate({ id: saved.id, title: "Mine" })).toMatchObject({ ok: false, code: "forbidden" });
    expect(await templatesFor(team)).toHaveLength(1);
  });

  it("copies the starter pack in as team-wide templates, as the panel does", async () => {
    for (const starter of STARTER_TEMPLATES) {
      const result = await createTemplate({ ...starter, productId: null });
      expect(result.ok).toBe(true);
    }
    const listed = await listTemplates({ productId: acme });
    if (!listed.ok) throw new Error(listed.error);
    expect(listed.data).toHaveLength(STARTER_TEMPLATES.length);
    expect(listed.data.every((t) => t.productId === null)).toBe(true);
  });

  it("folds a failed sign-in into a coded failure", async () => {
    vi.mocked(requireTeam).mockRejectedValue(Object.assign(new Error("Sign in to continue"), { name: "UnauthenticatedError" }));
    expect(await listTemplates({})).toEqual({ ok: false, error: "Sign in to continue", code: "unauthenticated" });
  });
});
