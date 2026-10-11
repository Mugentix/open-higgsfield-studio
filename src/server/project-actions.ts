"use server";

import { randomUUID } from "node:crypto";
import { and, asc, eq, isNull } from "drizzle-orm";

import { db, schema } from "./db/client";
import { guarded, type ActionResult } from "./result";
import { ensureDefaultProject } from "./runs";
import { requireTeam } from "./team";

export type ProjectSummary = {
  id: string;
  productId: string;
  name: string;
  slug: string;
  brief: string | null;
  status: string;
  lastUsedAt: number;
};

export type ProductSummary = {
  id: string;
  name: string;
  slug: string;
  offerUrl: string | null;
  brandNotes: string | null;
  projects: ProjectSummary[];
};

export type Workspace = {
  products: ProductSummary[];
  defaultProjectId: string;
};

/** Every product with its open projects, and the project a fresh session
    should open on. */
export async function getWorkspace(): Promise<ActionResult<Workspace>> {
  return guarded(async () => {
    const team = await requireTeam();
    const readProducts = () => db.query.products.findMany({
      where: and(eq(schema.products.teamId, team.teamId), isNull(schema.products.archivedAt)),
      with: { projects: { where: eq(schema.projects.status, "active"), orderBy: asc(schema.projects.name) } },
      orderBy: asc(schema.products.name),
    });
    let products = await readProducts();
    let defaultProjectId = products.find((product) => product.slug === "general")?.projects.find((project) => project.slug === "inbox")?.id;
    // Existing workspaces already include the default project in this read.
    // Only first use needs the creation path and a fresh list afterward.
    if (!defaultProjectId) {
      const { project } = await ensureDefaultProject(team);
      defaultProjectId = project.id;
      products = await readProducts();
    }
    return {
      products: products.map((product) => ({
        id: product.id,
        name: product.name,
        slug: product.slug,
        offerUrl: product.offerUrl,
        brandNotes: product.brandNotes,
        projects: product.projects.map((p) => ({
          id: p.id,
          productId: p.productId,
          name: p.name,
          slug: p.slug,
          brief: p.brief,
          status: p.status,
          lastUsedAt: p.lastUsedAt.getTime(),
        })),
      })),
      defaultProjectId,
    };
  });
}

export async function createProduct(data: unknown): Promise<ActionResult<ProductSummary>> {
  return guarded(async () => {
    const team = await requireTeam();
    const record = asObject(data);
    const name = readName(record.name, "Give the product a name");
    const offerUrl = typeof record.offerUrl === "string" && record.offerUrl.trim() ? record.offerUrl.trim().slice(0, 500) : null;
    const id = randomUUID();
    const slug = await uniqueSlug(name, (candidate) =>
      db.query.products.findFirst({ where: and(eq(schema.products.teamId, team.teamId), eq(schema.products.slug, candidate)) }),
    );
    await db.insert(schema.products).values({ id, teamId: team.teamId, name, slug, offerUrl, createdBy: team.userId });
    /* A product without a project cannot hold a run; the first one is made with it. */
    const projectId = randomUUID();
    await db.insert(schema.projects).values({
      id: projectId,
      teamId: team.teamId,
      productId: id,
      name: "General",
      slug: "general",
      createdBy: team.userId,
    });
    return {
      id,
      name,
      slug,
      offerUrl,
      brandNotes: null,
      projects: [{ id: projectId, productId: id, name: "General", slug: "general", brief: null, status: "active", lastUsedAt: Date.now() }],
    };
  });
}

/** The product's brief — name, offer url, brand notes — as any member may
    keep it. Templates fill {{product}}, {{offer_url}} and {{brand_notes}}
    from these three, so an empty one is a variable the composer has to ask
    for. The slug stays: it is the product's handle, not its name. */
export async function updateProduct(data: unknown): Promise<ActionResult<null>> {
  return guarded(async () => {
    const team = await requireTeam();
    const record = asObject(data);
    if (typeof record.productId !== "string") throw new Error("No such product");
    const patch: Partial<typeof schema.products.$inferInsert> = { updatedAt: new Date() };
    if (typeof record.name === "string") patch.name = readName(record.name, "Give the product a name");
    if (typeof record.offerUrl === "string") patch.offerUrl = record.offerUrl.trim().slice(0, 500) || null;
    if (typeof record.brandNotes === "string") patch.brandNotes = record.brandNotes.trim().slice(0, 4000) || null;
    await db
      .update(schema.products)
      .set(patch)
      .where(and(eq(schema.products.id, record.productId), eq(schema.products.teamId, team.teamId)));
    return null;
  });
}

export async function createProject(data: unknown): Promise<ActionResult<ProjectSummary>> {
  return guarded(async () => {
    const team = await requireTeam();
    const record = asObject(data);
    const name = readName(record.name, "Give the project a name");
    const brief = typeof record.brief === "string" && record.brief.trim() ? record.brief.trim().slice(0, 4000) : null;
    if (typeof record.productId !== "string") throw new Error("Pick a product");
    const product = await db.query.products.findFirst({
      where: and(eq(schema.products.id, record.productId), eq(schema.products.teamId, team.teamId)),
    });
    if (!product) throw new Error("No such product");
    const id = randomUUID();
    const slug = await uniqueSlug(name, (candidate) =>
      db.query.projects.findFirst({ where: and(eq(schema.projects.productId, product.id), eq(schema.projects.slug, candidate)) }),
    );
    await db.insert(schema.projects).values({ id, teamId: team.teamId, productId: product.id, name, slug, brief, createdBy: team.userId });
    return { id, productId: product.id, name, slug, brief, status: "active", lastUsedAt: Date.now() };
  });
}

export async function archiveProject(projectId: unknown): Promise<ActionResult<null>> {
  return guarded(async () => {
    const team = await requireTeam({ role: ["owner", "admin"] });
    if (typeof projectId !== "string") throw new Error("No such project");
    const { project: fallback } = await ensureDefaultProject(team);
    if (projectId === fallback.id) throw new Error("The Inbox stays");
    await db
      .update(schema.projects)
      .set({ status: "archived", updatedAt: new Date() })
      .where(and(eq(schema.projects.id, projectId), eq(schema.projects.teamId, team.teamId)));
    return null;
  });
}

export async function renameProject(data: unknown): Promise<ActionResult<null>> {
  return guarded(async () => {
    const team = await requireTeam();
    const record = asObject(data);
    if (typeof record.projectId !== "string") throw new Error("No such project");
    const patch: Partial<typeof schema.projects.$inferInsert> = { updatedAt: new Date() };
    if (typeof record.name === "string") patch.name = readName(record.name, "Give the project a name");
    if (typeof record.brief === "string") patch.brief = record.brief.trim().slice(0, 4000) || null;
    await db
      .update(schema.projects)
      .set(patch)
      .where(and(eq(schema.projects.id, record.projectId), eq(schema.projects.teamId, team.teamId)));
    return null;
  });
}

async function uniqueSlug(name: string, exists: (slug: string) => Promise<unknown>): Promise<string> {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "item";
  let slug = base;
  for (let n = 2; await exists(slug); n++) slug = `${base}-${n}`;
  return slug;
}

function readName(value: unknown, message: string): string {
  if (typeof value !== "string" || value.trim().length < 1) throw new Error(message);
  return value.trim().slice(0, 80);
}

function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
