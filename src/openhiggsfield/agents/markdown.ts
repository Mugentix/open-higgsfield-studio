/* The agent speaks Markdown — headings, lists, a fenced command, a table of
   takes — and the stream has to show it without ever handing the agent's
   words to the browser as markup. This renderer escapes every character of
   text and of every attribute before it builds a tag, lets a link through on
   http, https and mailto alone, and knows nothing else: no raw HTML passes,
   no image is fetched, no script can be smuggled in a title. Small on
   purpose, and pinned by tests/agents-ui.test.ts.

   Covered: paragraphs with soft breaks, # headings, fenced code, bullet and
   numbered lists nested by indent, > quotes, --- rules, pipe tables, and the
   inline marks — `code`, **strong**, *em*, ~~struck~~, [links](url), bare
   urls and \escapes. Headings step down two levels: the stream sits under
   the run's own h1 and the pane's h2. */

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ESCAPES[char]!);
}

/** The Markdown as HTML, every text node and attribute escaped. */
export function renderMarkdown(source: string): string {
  const lines = source
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/^[ \t]+/, (ws) => ws.replace(/\t/g, "    ")));
  return renderBlocks(lines);
}

/* ---------- blocks ---------- */

const FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*([^\s`]*)[ \t]*$/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*(?:[ \t]#+)?[ \t]*$/;
const RULE = /^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const QUOTE = /^ {0,3}> ?(.*)$/;
const ITEM = /^( {0,})([-*+]|\d{1,9}[.)])(?:([ \t]+)(.*)|[ \t]*)$/;
const CELL_RULE = /^:?-+:?$/;

function isBlank(line: string): boolean {
  return line.trim() === "";
}

function leadingSpaces(line: string): number {
  return line.length - line.trimStart().length;
}

type Item = {
  indent: number;
  marker: string;
  /** The text after the marker, on the first line. */
  content: string;
  /** The column the item's body starts at; a deeper line belongs to it. */
  contentIndent: number;
  ordered: boolean;
  /** What kind of marker: "-", "*", "+" for bullets, "." or ")" for numbers.
      One list, one kind — a change of marker starts a new list. */
  type: string;
};

function itemOf(line: string): Item | null {
  const match = ITEM.exec(line);
  if (!match) return null;
  const indent = match[1]!.length;
  const marker = match[2]!;
  const gap = match[3] ?? "";
  const content = match[4] ?? "";
  const ordered = /^\d/.test(marker);
  /* Five or more spaces after the marker make the first space the gap and
     the rest part of the content, as CommonMark reads it. */
  const wide = gap.length > 4;
  return {
    indent,
    marker,
    content: wide ? " ".repeat(gap.length - 1) + content : content,
    contentIndent: indent + marker.length + (content === "" || wide ? 1 : gap.length),
    ordered,
    type: ordered ? marker[marker.length - 1]! : marker,
  };
}

/** Whether a line opens a block of its own — what ends a paragraph or a list
    item's lazy continuation. Inside a paragraph a numbered item interrupts
    only when it starts at 1, and an empty item never does. */
function startsBlock(line: string, inParagraph: boolean): boolean {
  if (FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line)) return true;
  const item = itemOf(line);
  if (!item) return false;
  if (!inParagraph) return true;
  if (item.content === "") return false;
  return !item.ordered || /^1[.)]$/.test(item.marker);
}

function closesFence(line: string, marker: string): boolean {
  const match = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
  return match !== null && match[1]![0] === marker[0] && match[1]!.length >= marker.length;
}

function codeBlock(body: string, lang: string): string {
  const cls = /^[A-Za-z0-9_+.#-]{1,30}$/.test(lang) ? ` class="language-${escapeHtml(lang)}"` : "";
  return `<pre><code${cls}>${escapeHtml(body)}</code></pre>`;
}

function renderBlocks(lines: string[]): string {
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (isBlank(line)) {
      i++;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1]!;
      const body: string[] = [];
      i++;
      while (i < lines.length && !closesFence(lines[i]!, marker)) {
        body.push(lines[i]!);
        i++;
      }
      i++;
      out.push(codeBlock(body.join("\n"), fence[2] ?? ""));
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      const level = Math.min(6, heading[1]!.length + 2);
      out.push(`<h${level}>${renderInline(heading[2] ?? "")}</h${level}>`);
      i++;
      continue;
    }

    if (RULE.test(line)) {
      out.push("<hr>");
      i++;
      continue;
    }

    if (QUOTE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length) {
        const quoted = QUOTE.exec(lines[i]!);
        if (quoted) {
          inner.push(quoted[1]!);
          i++;
          continue;
        }
        /* A line without the mark continues the quote's paragraph, as long
           as the quote's last line was one. */
        const last = inner[inner.length - 1];
        if (last !== undefined && !isBlank(last) && !isBlank(lines[i]!) && !startsBlock(lines[i]!, true)) {
          inner.push(lines[i]!);
          i++;
          continue;
        }
        break;
      }
      out.push(`<blockquote>${renderBlocks(inner)}</blockquote>`);
      continue;
    }

    if (itemOf(line)) {
      const list = parseList(lines, i);
      out.push(list.html);
      i = list.next;
      continue;
    }

    if (line.includes("|") && i + 1 < lines.length) {
      const table = parseTable(lines, i);
      if (table) {
        out.push(table.html);
        i = table.next;
        continue;
      }
    }

    const paragraph = [line];
    i++;
    while (i < lines.length && !isBlank(lines[i]!) && !startsBlock(lines[i]!, true)) {
      paragraph.push(lines[i]!);
      i++;
    }
    out.push(`<p>${renderInline(paragraph.join("\n"))}</p>`);
  }
  return out.join("");
}

/** One list from the item at `start`: every sibling with the same marker
    kind, each item's body dedented to its own column and rendered as blocks
    again — which is what makes a deeper-indented list nest. */
function parseList(lines: string[], start: number): { html: string; next: number } {
  const first = itemOf(lines[start]!)!;
  const isSibling = (item: Item | null): item is Item =>
    item !== null &&
    item.ordered === first.ordered &&
    item.type === first.type &&
    item.indent >= first.indent &&
    item.indent <= first.indent + 3;

  const items: string[][] = [];
  let i = start;
  while (i < lines.length) {
    const item = itemOf(lines[i]!);
    if (!isSibling(item)) break;
    const body: string[] = [item.content];
    i++;
    while (i < lines.length) {
      const line = lines[i]!;
      if (isBlank(line)) {
        let j = i;
        while (j < lines.length && isBlank(lines[j]!)) j++;
        /* Blank lines, then a line still inside the item's column: the item
           goes on, loose. Anything else ends it. */
        if (j < lines.length && leadingSpaces(lines[j]!) >= item.contentIndent && !isBlank(lines[j]!)) {
          for (; i < j; i++) body.push("");
          continue;
        }
        break;
      }
      if (leadingSpaces(line) >= item.contentIndent) {
        body.push(line.slice(item.contentIndent));
        i++;
        continue;
      }
      if (itemOf(line) || startsBlock(line, true)) break;
      /* A plain line under an item continues its paragraph. */
      const last = body[body.length - 1];
      if (last !== undefined && !isBlank(last)) {
        body.push(line.trim());
        i++;
        continue;
      }
      break;
    }
    items.push(body);
    /* Blank lines between two items keep the list going; the item test on
       the far side decides. */
    let j = i;
    while (j < lines.length && isBlank(lines[j]!)) j++;
    if (j < lines.length && isSibling(itemOf(lines[j]!))) i = j;
    else break;
  }

  const tag = first.ordered ? "ol" : "ul";
  const startNumber = first.ordered ? parseInt(first.marker, 10) : 1;
  const attr = first.ordered && startNumber !== 1 ? ` start="${startNumber}"` : "";
  const inner = items.map((body) => `<li>${renderItem(body)}</li>`).join("");
  return { html: `<${tag}${attr}>${inner}</${tag}>`, next: i };
}

/** A tight item — no blank line inside it — is its text alone, with any
    nested list following straight on; a loose one keeps its paragraphs. */
function renderItem(body: string[]): string {
  const html = renderBlocks(body);
  if (body.some(isBlank)) return html;
  return html.replace(/^<p>([\s\S]*?)<\/p>/, "$1");
}

function splitRow(line: string): string[] {
  let row = line.trim();
  if (row.startsWith("|")) row = row.slice(1);
  if (row.endsWith("|") && !row.endsWith("\\|")) row = row.slice(0, -1);
  const cells: string[] = [];
  let cell = "";
  for (let k = 0; k < row.length; k++) {
    const char = row[k]!;
    if (char === "\\" && row[k + 1] === "|") {
      cell += "|";
      k++;
      continue;
    }
    if (char === "|") {
      cells.push(cell.trim());
      cell = "";
      continue;
    }
    cell += char;
  }
  cells.push(cell.trim());
  return cells;
}

/** A pipe table: a header row, the rule row that makes it one, then every
    row until a blank line or a line with no pipe in it. */
function parseTable(lines: string[], start: number): { html: string; next: number } | null {
  const rule = lines[start + 1]!;
  if (!rule.includes("-")) return null;
  const header = splitRow(lines[start]!);
  const marks = splitRow(rule);
  if (header.length < 1 || header.length !== marks.length || !marks.every((mark) => CELL_RULE.test(mark))) return null;
  const aligns = marks.map((mark) =>
    mark.startsWith(":") && mark.endsWith(":") ? "center" : mark.endsWith(":") ? "right" : mark.startsWith(":") ? "left" : null,
  );
  const rows: string[][] = [];
  let i = start + 2;
  while (i < lines.length && !isBlank(lines[i]!) && lines[i]!.includes("|")) {
    rows.push(splitRow(lines[i]!));
    i++;
  }
  const cell = (tag: "th" | "td", text: string, index: number) => {
    const align = aligns[index];
    return `<${tag}${align ? ` data-align="${align}"` : ""}>${renderInline(text)}</${tag}>`;
  };
  const head = `<thead><tr>${header.map((text, index) => cell("th", text, index)).join("")}</tr></thead>`;
  const body = rows.length
    ? `<tbody>${rows
        .map((row) => `<tr>${header.map((_, index) => cell("td", row[index] ?? "", index)).join("")}</tr>`)
        .join("")}</tbody>`
    : "";
  return { html: `<table>${head}${body}</table>`, next: i };
}

/* ---------- inline ---------- */

const PUNCTUATION = new Set("!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~");
const WORD = /[\p{L}\p{N}_]/u;

/** A link's destination, or null when it is not one the stream will follow:
    only an absolute http, https or mailto url, with no whitespace or control
    character in it. */
export function safeUrl(url: string): string | null {
  let candidate = url.trim();
  if (candidate.startsWith("<") && candidate.endsWith(">")) candidate = candidate.slice(1, -1);
  if (!/^(?:https?:\/\/|mailto:)[^\s\u0000-\u001f<>]+$/i.test(candidate)) return null;
  return candidate;
}

function anchor(url: string, inner: string, title?: string): string {
  const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
  return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer"${titleAttr}>${inner}</a>`;
}

/** Punctuation a sentence ends with is not part of a bare url. */
function trimUrlTail(url: string): string {
  let end = url.length;
  while (end > 0 && /[.,;:!?'"]/.test(url[end - 1]!)) end--;
  /* A closing paren belongs to the url only when it closes one inside it. */
  while (end > 0 && url[end - 1] === ")") {
    const inner = url.slice(0, end);
    const opens = (inner.match(/\(/g) ?? []).length;
    const closes = (inner.match(/\)/g) ?? []).length;
    if (closes <= opens) break;
    end--;
  }
  return url.slice(0, end);
}

type Link = { text: string; url: string; title: string | undefined; end: number };

/** `[text](url "title")` starting at the "[" at `start`, or null. The text
    may nest brackets; the url may be `<…>` or run to the first space, with
    balanced parens inside it. */
function parseLink(text: string, start: number): Link | null {
  let depth = 0;
  let close = -1;
  for (let k = start; k < text.length; k++) {
    const char = text[k]!;
    if (char === "\\") {
      k++;
      continue;
    }
    if (char === "`") {
      const run = codeRun(text, k);
      const end = findCodeClose(text, k + run, run);
      if (end >= 0) {
        k = end + run - 1;
        continue;
      }
    }
    if (char === "[") depth++;
    else if (char === "]") {
      depth--;
      if (depth === 0) {
        close = k;
        break;
      }
    }
  }
  if (close < 0 || text[close + 1] !== "(") return null;
  let k = close + 2;
  while (k < text.length && (text[k] === " " || text[k] === "\n")) k++;
  let url = "";
  if (text[k] === "<") {
    const end = text.indexOf(">", k + 1);
    if (end < 0 || text.slice(k + 1, end).includes("\n")) return null;
    url = text.slice(k + 1, end);
    k = end + 1;
  } else {
    let parens = 0;
    while (k < text.length) {
      const char = text[k]!;
      if (char === " " || char === "\n") break;
      if (char === "\\" && k + 1 < text.length) {
        url += text[k + 1];
        k += 2;
        continue;
      }
      if (char === "(") parens++;
      if (char === ")") {
        if (parens === 0) break;
        parens--;
      }
      url += char;
      k++;
    }
  }
  while (k < text.length && (text[k] === " " || text[k] === "\n")) k++;
  let title: string | undefined;
  const quote = text[k];
  if (quote === '"' || quote === "'") {
    let value = "";
    let end = -1;
    for (let m = k + 1; m < text.length; m++) {
      const char = text[m]!;
      if (char === "\\" && m + 1 < text.length && PUNCTUATION.has(text[m + 1]!)) {
        value += text[m + 1];
        m++;
        continue;
      }
      if (char === quote) {
        end = m;
        break;
      }
      value += char;
    }
    if (end < 0) return null;
    title = value;
    k = end + 1;
    while (k < text.length && (text[k] === " " || text[k] === "\n")) k++;
  }
  if (text[k] !== ")") return null;
  return { text: text.slice(start + 1, close), url, title, end: k + 1 };
}

function codeRun(text: string, at: number): number {
  let run = 0;
  while (text[at + run] === "`") run++;
  return run;
}

/** Where a backtick run of exactly `run` closes, from `from`; -1 when none. */
function findCodeClose(text: string, from: number, run: number): number {
  let k = from;
  while (k < text.length) {
    if (text[k] !== "`") {
      k++;
      continue;
    }
    const length = codeRun(text, k);
    if (length === run) return k;
    k += length;
  }
  return -1;
}

type Emphasis = { tag: "strong" | "em" | "del"; inner: string; end: number };

/** The emphasis opened by the delimiter run at `start`, or null when it
    does not close. Content never starts or ends with a space; underscores
    only mark whole words, so snake_case_names stay whole. */
function parseEmphasis(text: string, start: number): Emphasis | null {
  const char = text[start]!;
  let run = 0;
  while (text[start + run] === char) run++;
  if (char === "~" && run !== 2) return null;
  if (run > 2) run = 2;
  const tag: Emphasis["tag"] = char === "~" ? "del" : run === 2 ? "strong" : "em";
  const before = start > 0 ? text[start - 1]! : "";
  if (char === "_" && before !== "" && WORD.test(before)) return null;
  const first = text[start + run];
  if (first === undefined || first === " " || first === "\n") return null;

  let k = start + run;
  while (k < text.length) {
    const current = text[k]!;
    if (current === "\\") {
      k += 2;
      continue;
    }
    if (current === "`") {
      const length = codeRun(text, k);
      const end = findCodeClose(text, k + length, length);
      if (end >= 0) {
        k = end + length;
        continue;
      }
    }
    if (current === char) {
      let length = 0;
      while (text[k + length] === char) length++;
      const previous = text[k - 1]!;
      const after = text[k + length] ?? "";
      const closes =
        length >= run &&
        previous !== " " &&
        previous !== "\n" &&
        k > start + run &&
        (char !== "_" || after === "" || !WORD.test(after));
      /* A single star closes a single star only when the run is exactly
         one: `*a**` leaves the double for whatever opened it. */
      if (closes && (run === 2 || length === 1 || length > 2)) {
        return { tag, inner: text.slice(start + run, k), end: k + run };
      }
      k += length;
      continue;
    }
    k++;
  }
  return null;
}

function renderInline(text: string, links = true): string {
  let out = "";
  let plain = "";
  const flush = () => {
    if (plain) {
      out += escapeHtml(plain);
      plain = "";
    }
  };
  let i = 0;
  while (i < text.length) {
    const char = text[i]!;

    if (char === "\\" && i + 1 < text.length && PUNCTUATION.has(text[i + 1]!)) {
      plain += text[i + 1];
      i += 2;
      continue;
    }

    if (char === "\n") {
      flush();
      out += "<br>";
      i++;
      continue;
    }

    if (char === "`") {
      const run = codeRun(text, i);
      const close = findCodeClose(text, i + run, run);
      if (close >= 0) {
        let code = text.slice(i + run, close).replace(/\n/g, " ");
        if (code.length >= 2 && code.startsWith(" ") && code.endsWith(" ") && code.trim() !== "") code = code.slice(1, -1);
        flush();
        out += `<code>${escapeHtml(code)}</code>`;
        i = close + run;
        continue;
      }
      plain += text.slice(i, i + run);
      i += run;
      continue;
    }

    if (links && char === "!" && text[i + 1] === "[") {
      const link = parseLink(text, i + 1);
      if (link) {
        flush();
        out += renderLink(link, true);
        i = link.end;
        continue;
      }
    }

    if (links && char === "[") {
      const link = parseLink(text, i);
      if (link) {
        flush();
        out += renderLink(link, false);
        i = link.end;
        continue;
      }
    }

    if (links && char === "<") {
      const auto = /^<((?:https?:\/\/|mailto:)[^\s<>]+)>/i.exec(text.slice(i));
      if (auto) {
        flush();
        out += anchor(auto[1]!, escapeHtml(auto[1]!));
        i += auto[0].length;
        continue;
      }
    }

    if (links && (char === "h" || char === "H") && /^https?:\/\/[^\s<>]/i.test(text.slice(i, i + 9))) {
      const before = i > 0 ? text[i - 1]! : "";
      if (before === "" || !WORD.test(before)) {
        const url = trimUrlTail(/^https?:\/\/[^\s<>]+/i.exec(text.slice(i))![0]);
        flush();
        out += anchor(url, escapeHtml(url));
        i += url.length;
        continue;
      }
    }

    if (char === "*" || char === "_" || char === "~") {
      const emphasis = parseEmphasis(text, i);
      if (emphasis) {
        flush();
        out += `<${emphasis.tag}>${renderInline(emphasis.inner, links)}</${emphasis.tag}>`;
        i = emphasis.end;
        continue;
      }
    }

    plain += char;
    i++;
  }
  flush();
  return out;
}

/** A link the stream will follow is an anchor that opens in a new tab; one
    it will not — a relative path, another scheme — stays as its words with
    the destination beside them, since a path into the workspace is still
    something the reader wants to see. An image is a link to the file: the
    stream fetches nothing on the agent's say-so. */
function renderLink(link: Link, image: boolean): string {
  const url = safeUrl(link.url);
  const label = image ? escapeHtml(link.text || link.url) : renderInline(link.text, false);
  if (url) return anchor(url, label, link.title);
  const destination = link.url.trim();
  return destination ? `${label} (${escapeHtml(destination)})` : label;
}
