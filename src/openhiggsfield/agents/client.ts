"use client";

import type { Workspace } from "@/server/project-actions";
import type { ActionErrorCode } from "@/server/result";

/* The few browser-side helpers every agents panel reaches for: the bounce a
   dead session takes, and the names a run is filed under. */

/** A session that ended mid-work sends the visitor back through the gate. */
export function bounceIfSignedOut(code: ActionErrorCode | undefined): void {
  if (code === "unauthenticated") window.location.assign("/login");
}

/** "Product › Project" for a project id, or the id's absence as a dash. */
export function projectLabel(workspace: Workspace | null, projectId: string | null): string {
  if (!projectId) return "—";
  for (const product of workspace?.products ?? []) {
    const project = product.projects.find((entry) => entry.id === projectId);
    if (project) return `${product.name} › ${project.name}`;
  }
  return "—";
}

const WHEN = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const CLOCK = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit" });

/** When a run started, as the list shows it. */
export function whenLabel(at: number): string {
  return WHEN.format(new Date(at));
}

/** A time of day for a line in the stream. */
export function clockLabel(at: number): string {
  return CLOCK.format(new Date(at));
}

/** The file's own name, out of a workspace-relative path. */
export function baseName(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}
