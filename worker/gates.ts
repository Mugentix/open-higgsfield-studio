/* The paid gate. The skills were written for a person at a terminal who sees
   every command before it runs; in the studio the worker holds the ones that
   spend money and asks the team. Everything else — reads, writes, ffmpeg,
   Whisper, the free KIE queries — runs without a stop.

   The rules are by command shape, not by intent: a `--confirm-paid` flag, the
   known paid entry points of the owner's pipelines, a KIE createTask call,
   or the Higgsfield client. A new skill with a new paid script should name
   its command here (or use `--confirm-paid`, which the owner's scripts do).

   A shape check is an early stop, not a fence: a paid call inside a script
   the agent wrote itself, or behind an interpreter's `-c`, matches no rule.
   The fence that closes that is enforcing at the key — a loopback proxy that
   holds KIE's createTask for approval and keeps the key out of the shell —
   and is still to be built. Until then the runtime pins Bash to `ask` in the
   policy tier, so every command at least reaches this gate, and the rules
   read the token wherever it sits: quoted, assigned to a variable, or with
   the host split from the path. */

export type GateMatch = { reason: string };

const RULES: Array<{ pattern: RegExp; reason: string }> = [
  /* The flag anywhere in the command — `'--confirm-paid'`, `F=--confirm-paid` — but not `--confirm-paid-later`. */
  { pattern: /(^|[^\w-])--confirm-paid(?![\w-])/, reason: "runs a paid step (--confirm-paid)" },
  { pattern: /engine\/(batch|make_take|make_images|cast_soul)\.py\b/, reason: "a drama-ad engine step that generates on KIE" },
  /* The subcommand may be quoted. */
  { pattern: /\bkie\.py\s+["']?(watch|submit)\b/, reason: "submits KIE jobs" },
  /* The path alone: the host may sit in a variable. */
  { pattern: /\bcreateTask\b/i, reason: "calls KIE createTask directly" },
  { pattern: /\bhiggsfield_client\b/, reason: "calls the Higgsfield API" },
];

/** The first paid rule a Bash command matches, or null. Checks every line
    of a multi-line command, so a paid call hidden after a `cd &&` is seen. */
export function paidGate(command: string): GateMatch | null {
  for (const rule of RULES) {
    if (rule.pattern.test(command)) return { reason: rule.reason };
  }
  return null;
}

/** One line for the approval card: the first non-empty line of the command,
    cut so a pasted heredoc does not become the headline. */
export function commandHeadline(command: string, max = 160): string {
  const line = command.split("\n").map((part) => part.trim()).find(Boolean) ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
