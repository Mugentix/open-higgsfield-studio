import { and, asc, desc, eq, gte, sql } from "drizzle-orm";

import { db, schema } from "./db/client";
import type { SpendDays } from "./spend-periods";
import type { TeamContext } from "./team";

/* Where the team's KIE credits went. Every settled run leaves one ledger row,
   attributed to who pressed Generate and to the product it was for; this sums
   those rows three ways over a window of whole UTC days ending today, so the
   totals, the tables and the day strip all agree on which rows are in. The
   windows themselves live in spend-periods.ts, which the client may import. */

export type SpendLine = { id: string; name: string; credits: number; runs: number };

export type SpendReport = {
  days: SpendDays;
  total: number;
  runs: number;
  /** Highest spend first. */
  byMember: SpendLine[];
  byProduct: SpendLine[];
  /** One entry per day of the window, oldest first; a day without spend is 0. */
  byDay: Array<{ day: string; credits: number }>;
};

const DAY_MS = 86_400_000;

/** The ledger summed over the last `days` whole UTC days, today included.
    `now` is a seam for tests; the action leaves it to the clock. */
export async function summarizeSpend(team: TeamContext, days: SpendDays, now = new Date()): Promise<SpendReport> {
  const ledger = schema.creditLedger;
  const start = windowStart(days, now);
  const inWindow = and(eq(ledger.teamId, team.teamId), gte(ledger.recordedAt, start));
  /* numeric comes back as a string from both drivers; every value is cast once. */
  const credits = sql<string | null>`sum(${ledger.credits})`;
  const runs = sql<number>`count(*)::int`;
  const day = sql<string>`to_char(${ledger.recordedAt} at time zone 'UTC', 'YYYY-MM-DD')`;

  const [totals, members, products, perDay] = await Promise.all([
    db.select({ credits, runs }).from(ledger).where(inWindow),
    db
      .select({ id: ledger.userId, name: schema.user.name, email: schema.user.email, credits, runs })
      .from(ledger)
      .leftJoin(schema.user, eq(ledger.userId, schema.user.id))
      .where(inWindow)
      .groupBy(ledger.userId, schema.user.name, schema.user.email)
      .orderBy(desc(credits), asc(schema.user.name)),
    db
      .select({ id: ledger.productId, name: schema.products.name, credits, runs })
      .from(ledger)
      .leftJoin(schema.products, eq(ledger.productId, schema.products.id))
      .where(inWindow)
      .groupBy(ledger.productId, schema.products.name)
      .orderBy(desc(credits), asc(schema.products.name)),
    db.select({ day, credits }).from(ledger).where(inWindow).groupBy(day),
  ]);

  const spent = new Map(perDay.map((row) => [row.day, round4(Number(row.credits ?? 0))]));
  return {
    days,
    total: round4(Number(totals[0]?.credits ?? 0)),
    runs: totals[0]?.runs ?? 0,
    /* A user row that is gone still has its runs; a member who merely left
       keeps a user row and so keeps their name. */
    byMember: members.map((row) => ({
      id: row.id ?? "",
      name: row.name || row.email || "Former member",
      credits: round4(Number(row.credits ?? 0)),
      runs: row.runs,
    })),
    byProduct: products.map((row) => ({
      id: row.id,
      name: row.name ?? "Removed product",
      credits: round4(Number(row.credits ?? 0)),
      runs: row.runs,
    })),
    byDay: dayKeys(start, days).map((key) => ({ day: key, credits: spent.get(key) ?? 0 })),
  };
}

/** Midnight UTC, `days - 1` days before now: the window is whole days ending today. */
function windowStart(days: number, now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (days - 1)));
}

function dayKeys(start: Date, days: number): string[] {
  return Array.from({ length: days }, (_, i) => new Date(start.getTime() + i * DAY_MS).toISOString().slice(0, 10));
}

function round4(value: number): number {
  return Math.round(value * 1e4) / 1e4;
}
