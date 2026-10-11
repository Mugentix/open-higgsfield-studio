import type { Masker } from "./mask";

/* One JSON line per entry, so journald and a log shipper read the same
   thing. Every string field goes through the masker: the worker's env holds
   the Anthropic key and the teams' KIE keys, and a careless field (a command,
   an error with a header in it) must not leak them. */

export type Level = "debug" | "info" | "warn" | "error";

export type Logger = {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  /** The same sink with fields every line carries (worker id, run id). */
  child(fields: Record<string, unknown>): Logger;
};

export type LogSink = (line: string) => void;

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger(
  mask: Masker,
  options: { level?: Level; sink?: LogSink; fields?: Record<string, unknown>; now?: () => Date } = {},
): Logger {
  const level = options.level ?? "info";
  const sink = options.sink ?? ((line) => process.stdout.write(`${line}\n`));
  const base = options.fields ?? {};
  const now = options.now ?? (() => new Date());
  const write = (entryLevel: Level, message: string, fields?: Record<string, unknown>) => {
    if (ORDER[entryLevel] < ORDER[level]) return;
    const entry = { ts: now().toISOString(), level: entryLevel, msg: message, ...base, ...(fields ?? {}) };
    sink(JSON.stringify(mask.value(plain(entry))));
  };
  return {
    debug: (message, fields) => write("debug", message, fields),
    info: (message, fields) => write("info", message, fields),
    warn: (message, fields) => write("warn", message, fields),
    error: (message, fields) => write("error", message, fields),
    child: (fields) => createLogger(mask, { level, sink, fields: { ...base, ...fields }, now }),
  };
}

/** Errors do not JSON.stringify to anything useful; the message does. */
function plain(value: unknown): unknown {
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (Array.isArray(value)) return value.map(plain);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, plain(entry)]));
  }
  return value;
}

export function levelFromEnv(raw: string | undefined): Level {
  return raw === "debug" || raw === "info" || raw === "warn" || raw === "error" ? raw : "info";
}
