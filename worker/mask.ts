/* Nothing the worker writes to the event stream or the log may carry a key.
   The team's KIE key and the worker's own env secrets are known values and
   are replaced wherever they appear; anything shaped like a token (`sk-…`,
   a Bearer header) is caught by pattern in case a script echoes one the
   worker never saw. */

export const MASK = "•••";

/** Env keys whose values are secrets whatever their shape. */
const SECRET_ENV = /(_KEY|_SECRET|_TOKEN|PASSWORD|_PASS|CREDENTIALS)$/i;

/** Tokens by shape: Anthropic/OpenAI style `sk-…`, KIE/HF style long hex or
    base64 after a Bearer, and `KEY=value` lines in a dumped .env. */
const PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{8,}\b/g,
  /\bhf_[A-Za-z0-9]{8,}\b/g,
  /\b(Bearer)\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /\b([A-Z][A-Z0-9_]*(?:_KEY|_SECRET|_TOKEN|PASSWORD))\s*=\s*["']?([^\s"'#]{6,})["']?/g,
];

export class Masker {
  private readonly secrets: string[];

  /** Every value from `env` whose key looks secret, plus any explicit values. */
  constructor(env: Record<string, string | undefined> = {}, extra: string[] = []) {
    const values = new Set<string>();
    for (const [key, value] of Object.entries(env)) {
      if (value && value.length >= 6 && SECRET_ENV.test(key)) values.add(value);
    }
    for (const value of extra) if (value && value.length >= 6) values.add(value);
    /* Longest first so a key that contains another is replaced whole. */
    this.secrets = [...values].sort((a, b) => b.length - a.length);
  }

  text(input: string): string {
    let out = input;
    for (const secret of this.secrets) out = out.split(secret).join(MASK);
    out = out.replace(PATTERNS[0]!, MASK).replace(PATTERNS[1]!, MASK);
    out = out.replace(PATTERNS[2]!, (_m, word: string) => `${word} ${MASK}`);
    out = out.replace(PATTERNS[3]!, (_m, name: string) => `${name}=${MASK}`);
    return out;
  }

  /** Walks a JSON-ish value; strings are masked, everything else is kept. */
  value<T>(input: T): T {
    if (typeof input === "string") return this.text(input) as T;
    if (Array.isArray(input)) return input.map((entry) => this.value(entry)) as T;
    if (input && typeof input === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(input as Record<string, unknown>)) {
        out[key] = SECRET_ENV.test(key) && typeof entry === "string" && entry ? MASK : this.value(entry);
      }
      return out as T;
    }
    return input;
  }
}
