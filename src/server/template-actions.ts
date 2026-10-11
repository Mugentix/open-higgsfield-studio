"use server";

import { TEMPLATE_LIMITS, isTemplateSurface, parseTags, type TemplateSurface } from "@/openhiggsfield/templates";

import { guarded, type ActionResult } from "./result";
import { requireTeam } from "./team";
import {
  countTemplateUse,
  editTemplate,
  removeTemplate,
  saveTemplate,
  templatesFor,
  type PromptTemplate,
  type TemplateInput,
} from "./templates";

/** The team-wide templates and, given a product, that product's too. */
export async function listTemplates(data: unknown): Promise<ActionResult<PromptTemplate[]>> {
  return guarded(async () => {
    const team = await requireTeam();
    const record = asObject(data);
    return templatesFor(team, typeof record.productId === "string" && record.productId ? record.productId : undefined);
  });
}

export async function createTemplate(data: unknown): Promise<ActionResult<PromptTemplate>> {
  return guarded(async () => {
    const team = await requireTeam();
    const record = asObject(data);
    return saveTemplate(team, {
      title: readTitle(record.title),
      body: readBody(record.body),
      tags: readTags(record.tags),
      surface: readSurface(record.surface),
      productId: readProductId(record.productId),
    });
  });
}

/** Changes only the fields given; who saved the template, or an admin. */
export async function updateTemplate(data: unknown): Promise<ActionResult<PromptTemplate>> {
  return guarded(async () => {
    const team = await requireTeam();
    const record = asObject(data);
    const patch: Partial<TemplateInput> = {};
    if (record.title !== undefined) patch.title = readTitle(record.title);
    if (record.body !== undefined) patch.body = readBody(record.body);
    if (record.tags !== undefined) patch.tags = readTags(record.tags);
    if (record.surface !== undefined) patch.surface = readSurface(record.surface);
    if (record.productId !== undefined) patch.productId = readProductId(record.productId);
    return editTemplate(team, readId(record.id), patch);
  });
}

/** Who saved the template, or an admin. */
export async function deleteTemplate(data: unknown): Promise<ActionResult<null>> {
  return guarded(async () => {
    const team = await requireTeam();
    return removeTemplate(team, readId(asObject(data).id));
  });
}

/** The body to insert, with one more use counted against the template. */
export async function useTemplate(data: unknown): Promise<ActionResult<string>> {
  return guarded(async () => {
    const team = await requireTeam();
    return countTemplateUse(team, readId(asObject(data).id));
  });
}

function readTitle(value: unknown): string {
  if (typeof value !== "string" || value.trim().length < 1) throw new Error("Give the template a title");
  return value.trim().slice(0, TEMPLATE_LIMITS.title);
}

function readBody(value: unknown): string {
  if (typeof value !== "string" || value.trim().length < 1) throw new Error("A template needs a prompt");
  return value.trim().slice(0, TEMPLATE_LIMITS.body);
}

/** Tags arrive as a list; anything in it that is not a word is dropped, and
    the rest is normalised the way the form's field would have typed it. */
function readTags(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("Tags come as a list");
  const words = value.filter((v): v is string => typeof v === "string").join(",");
  return parseTags(words)
    .slice(0, TEMPLATE_LIMITS.tags)
    .map((tag) => tag.slice(0, TEMPLATE_LIMITS.tag));
}

function readSurface(value: unknown): TemplateSurface {
  if (value === undefined) return "any";
  if (!isTemplateSurface(value)) throw new Error("Pick image, video or any");
  return value;
}

/** Absent or null both mean team-wide. */
function readProductId(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length < 1 || value.length > 100) throw new Error("No such product");
  return value;
}

function readId(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 100) throw new Error("No such template");
  return value;
}

function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
