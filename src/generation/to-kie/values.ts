/** Value coercions for a catalog entry's `kie.values`. Each returns a function
    the shared mapper applies to the parsed setting before it goes on the wire. */

/** "1k" → "1K", "720p" → "720P". */
export const upper = (value: unknown): unknown => String(value).toUpperCase();

/** 5 → "5": for models that type a number as a string. */
export const asString = (value: unknown): unknown => String(value);

/** Snap a number to the nearest value KIE allows. Ties round up, so a 4–10
    range asked for 7 lands on 10 for a 5|10 model. */
export function snapTo(allowed: readonly number[]): (value: unknown) => number {
  return (value) => {
    const n = Number(value);
    let best = allowed[0]!;
    for (const candidate of allowed) {
      const better =
        Math.abs(candidate - n) < Math.abs(best - n) ||
        (Math.abs(candidate - n) === Math.abs(best - n) && candidate > best);
      if (better) best = candidate;
    }
    return best;
  };
}

/** snapTo, then String(): for string-typed duration enums like "5" | "10". */
export function snapToString(allowed: readonly number[]): (value: unknown) => string {
  const snap = snapTo(allowed);
  return (value) => String(snap(value));
}

/** Rewrite the values a table names and pass everything else through. */
export function mapValues(table: Record<string, unknown>): (value: unknown) => unknown {
  return (value) => (String(value) in table ? table[String(value)] : value);
}
