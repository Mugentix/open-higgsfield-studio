"use client";

import { useMemo } from "react";

import { renderMarkdown } from "./markdown";

/* The one place the agents pages set innerHTML, and only with the renderer's
   own output: every character of the agent's words has been escaped before
   a tag was built around it (see markdown.ts). */
export function Markdown({ source, className }: { source: string; className?: string }) {
  const html = useMemo(() => renderMarkdown(source), [source]);
  return <div className={`ohf-md${className ? ` ${className}` : ""}`} dangerouslySetInnerHTML={{ __html: html }} />;
}
