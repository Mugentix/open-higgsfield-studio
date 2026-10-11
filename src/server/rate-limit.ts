import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";

import { rows } from "./db/sql";

/* KIE allows 20 task creations per 10 seconds per account, rejected not
   queued. One token bucket per key, refilled continuously, taken from
   atomically in a single statement so every process shares it. A bucket
   admits capacity + refill * window in any window, so 8 + 1.0 * 10 = 18 in
   ten seconds keeps under the limit and leaves room for a second tool on
   the same account. */
export const BUCKET_CAPACITY = 8;
export const BUCKET_REFILL_PER_SECOND = 1.0;

export function bucketKeyFor(apiKey: string): string {
  return `kie:${createHash("sha256").update(apiKey).digest("hex").slice(0, 16)}`;
}

export async function takeToken(
  key: string,
  capacity = BUCKET_CAPACITY,
  refillPerSecond = BUCKET_REFILL_PER_SECOND,
): Promise<{ granted: boolean; retryAfterMs: number }> {
  const taken = await rows<{ tokens: string }>(sql`
    INSERT INTO rate_buckets (key, tokens, updated_at)
    VALUES (${key}, ${capacity - 1}, now())
    ON CONFLICT (key) DO UPDATE SET
      tokens = LEAST(${capacity}::numeric, rate_buckets.tokens + EXTRACT(EPOCH FROM (now() - rate_buckets.updated_at)) * ${refillPerSecond}) - 1,
      updated_at = now()
    WHERE LEAST(${capacity}::numeric, rate_buckets.tokens + EXTRACT(EPOCH FROM (now() - rate_buckets.updated_at)) * ${refillPerSecond}) >= 1
    RETURNING tokens
  `);
  if (taken.length > 0) return { granted: true, retryAfterMs: 0 };
  const current = await rows<{ tokens: string; age: string }>(sql`
    SELECT tokens, EXTRACT(EPOCH FROM (now() - updated_at)) AS age FROM rate_buckets WHERE key = ${key}
  `);
  const have = current[0] ? Math.min(capacity, Number(current[0].tokens) + Number(current[0].age) * refillPerSecond) : 0;
  const wait = Math.max(0, (1 - have) / refillPerSecond);
  return { granted: false, retryAfterMs: Math.ceil(wait * 1000) + 100 };
}
