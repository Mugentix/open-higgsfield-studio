import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import type { TemplateSurface } from "@/openhiggsfield/templates";

import { db, schema } from "./db/client";
import type { TeamContext } from "./team";

/* The team's library of prompts: hooks, product shots, end cards. A row is
   team-wide or scoped to one product, and the composer reads the union for
   the product it is in, newest first. The pure half — what a variable is,
   the starter pack — lives in src/openhiggsfield/templates.ts, which this
   module and the composer both read. */

export type PromptTemplate = {
  id: string;
  /** Null: any product. */
  productId: string | null;
  title: string;
  body: string;
  tags: string[];
  surface: TemplateSurface;
  /** Times the body was inserted into a prompt. */
  uses: number;
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
};

export type TemplateInput = {
  title: string;
  body: string;
  tags: string[];
  surface: TemplateSurface;
  productId: string | null;
};

type Row = typeof schema.promptTemplates.$inferSelect;

/* Raised by name: result.ts folds an error into its code by the name it
   carries, and the core imports only types from team.ts, as gallery.ts and
   spend.ts do — so the class is not borrowed from there. */
class TemplateForbiddenError extends Error {
  constructor() {
    super("Only who saved a template, or an admin, can change it");
    this.name = "ForbiddenError";
  }
}

function templateOf(row: Row): PromptTemplate {
  return {
    id: row.id,
    productId: row.productId,
    title: row.title,
    body: row.body,
    tags: row.tags,
    surface: row.surface as TemplateSurface,
    uses: row.uses,
    createdBy: row.createdBy,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}

/** The team-wide templates plus the product's, newest first; without a
    product, the team-wide ones alone. */
export async function templatesFor(team: TeamContext, productId?: string): Promise<PromptTemplate[]> {
  const t = schema.promptTemplates;
  const scope = productId ? or(isNull(t.productId), eq(t.productId, productId))! : isNull(t.productId);
  const rows = await db
    .select()
    .from(t)
    .where(and(eq(t.teamId, team.teamId), scope))
    .orderBy(desc(t.createdAt), desc(t.id));
  return rows.map(templateOf);
}

/** A template is scoped to a product of the team or to none at all; another
    team's product is as good as no product. */
async function checkProduct(team: TeamContext, productId: string | null): Promise<void> {
  if (productId === null) return;
  const product = await db.query.products.findFirst({
    where: and(eq(schema.products.id, productId), eq(schema.products.teamId, team.teamId)),
    columns: { id: true },
  });
  if (!product) throw new Error("No such product");
}

export async function saveTemplate(team: TeamContext, input: TemplateInput): Promise<PromptTemplate> {
  await checkProduct(team, input.productId);
  const [row] = await db
    .insert(schema.promptTemplates)
    .values({
      id: randomUUID(),
      teamId: team.teamId,
      productId: input.productId,
      title: input.title,
      body: input.body,
      tags: input.tags,
      surface: input.surface,
      createdBy: team.userId,
    })
    .returning();
  return templateOf(row!);
}

/** Who saved a template changes or removes it; owners and admins may too. */
export function canEditTemplate(team: TeamContext, template: { createdBy: string | null }): boolean {
  return team.role !== "member" || template.createdBy === team.userId;
}

/** The team's row, once the asker is allowed to touch it. */
async function ownedTemplate(team: TeamContext, id: string): Promise<Row> {
  const row = await db.query.promptTemplates.findFirst({
    where: and(eq(schema.promptTemplates.id, id), eq(schema.promptTemplates.teamId, team.teamId)),
  });
  if (!row) throw new Error("No such template");
  if (!canEditTemplate(team, row)) throw new TemplateForbiddenError();
  return row;
}

export async function editTemplate(team: TeamContext, id: string, patch: Partial<TemplateInput>): Promise<PromptTemplate> {
  await ownedTemplate(team, id);
  if (patch.productId !== undefined) await checkProduct(team, patch.productId);
  const [row] = await db
    .update(schema.promptTemplates)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(schema.promptTemplates.id, id), eq(schema.promptTemplates.teamId, team.teamId)))
    .returning();
  return templateOf(row!);
}

export async function removeTemplate(team: TeamContext, id: string): Promise<null> {
  await ownedTemplate(team, id);
  await db
    .delete(schema.promptTemplates)
    .where(and(eq(schema.promptTemplates.id, id), eq(schema.promptTemplates.teamId, team.teamId)));
  return null;
}

/** The body, and one more use on the counter. Using is not editing, so
    updated_at stands. */
export async function countTemplateUse(team: TeamContext, id: string): Promise<string> {
  const t = schema.promptTemplates;
  const [row] = await db
    .update(t)
    .set({ uses: sql`${t.uses} + 1` })
    .where(and(eq(t.id, id), eq(t.teamId, team.teamId)))
    .returning();
  if (!row) throw new Error("No such template");
  return row.body;
}
