import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { envForTests, resetStubs, seedTeam, useTestDatabase, type TestDb } from "./harness";

import * as schema from "@/server/db/schema";
import { summarizeSpend } from "@/server/spend";
import { getSpend } from "@/server/spend-actions";
import { requireTeam, type TeamContext } from "@/server/team";

/* The action reads the session through next/headers; here requireTeam is a
   mock that answers with the seeded team. The core takes the team directly. */
vi.mock("@/server/team", () => ({ requireTeam: vi.fn() }));

/* Every test boots its own PGlite, which takes a moment more than the default
   budget allows. */
vi.setConfig({ testTimeout: 30_000 });

/* The clock the core is asked about: a midday, so no row sits on a day edge
   by accident, and the 7-day window opens at 2026-09-09T00:00Z. */
const NOW = new Date("2026-09-15T12:00:00Z");
const at = (iso: string) => new Date(iso);

let db: TestDb;
let team: TeamContext;
let ada: string;
let ben: string;
let ghost: string;
let alpha: string;
let beta: string;

beforeEach(async () => {
  envForTests();
  db = await useTestDatabase();
  team = await seedTeam(db, { name: "Ada" });
  vi.mocked(requireTeam).mockReset();
  vi.mocked(requireTeam).mockResolvedValue(team);

  ada = team.userId;
  ben = await addMember(team, "Ben");
  /* Runs by someone whose user row is gone: attributed, but nameless. */
  ghost = randomUUID();
  alpha = await addProduct(team, "Alpha");
  beta = await addProduct(team, "Beta");

  await settle(team, ada, alpha, "4.5", at("2026-09-15T12:00:00Z"));
  await settle(team, ben, alpha, "10", at("2026-09-15T12:00:00Z"));
  await settle(team, ghost, beta, "1", at("2026-09-14T12:00:00Z"));
  await settle(team, ada, beta, "2.25", at("2026-09-13T12:00:00Z"));
  await settle(team, ben, beta, "0.0001", at("2026-09-13T12:00:00Z"));
  /* The first second of the 7-day window is in; the second before it is not. */
  await settle(team, ben, alpha, "5", at("2026-09-09T00:00:00Z"));
  await settle(team, ada, alpha, "20", at("2026-09-08T23:59:59Z"));
  /* Forty-five days back: only the 90-day window reaches it. */
  await settle(team, ada, alpha, "100", at("2026-08-01T12:00:00Z"));

  const other = await seedTeam(db, { name: "Other Team" });
  await settle(other, other.userId, await addProduct(other, "Theirs"), "99", at("2026-09-15T12:00:00Z"));
});

afterEach(() => resetStubs());

async function addMember(owner: TeamContext, name: string): Promise<string> {
  const userId = randomUUID();
  await db.insert(schema.user).values({ id: userId, name, email: `${userId.slice(0, 8)}@example.com`, emailVerified: true });
  await db.insert(schema.member).values({ id: randomUUID(), organizationId: owner.teamId, userId, role: "member", createdAt: new Date() });
  return userId;
}

async function addProduct(owner: TeamContext, name: string): Promise<string> {
  const id = randomUUID();
  await db.insert(schema.products).values({ id, teamId: owner.teamId, name, slug: name.toLowerCase(), createdBy: owner.userId });
  return id;
}

async function settle(owner: TeamContext, userId: string | null, productId: string, credits: string, recordedAt: Date) {
  await db.insert(schema.creditLedger).values({
    id: randomUUID(),
    teamId: owner.teamId,
    runId: randomUUID(),
    projectId: randomUUID(),
    productId,
    userId,
    credits,
    recordedAt,
  });
}

describe("summarizeSpend: the 30-day window", () => {
  it("sums the team's rows, and only the team's", async () => {
    const report = await summarizeSpend(team, 30, NOW);
    expect(report.days).toBe(30);
    expect(report.total).toBe(42.7501);
    expect(report.runs).toBe(7);
  });

  it("splits by member, highest first, naming a vanished user 'Former member'", async () => {
    const { byMember } = await summarizeSpend(team, 30, NOW);
    expect(byMember).toEqual([
      { id: ada, name: "Ada", credits: 26.75, runs: 3 },
      { id: ben, name: "Ben", credits: 15.0001, runs: 3 },
      { id: ghost, name: "Former member", credits: 1, runs: 1 },
    ]);
  });

  it("splits by product, highest first, with the product's name", async () => {
    const { byProduct } = await summarizeSpend(team, 30, NOW);
    expect(byProduct).toEqual([
      { id: alpha, name: "Alpha", credits: 39.5, runs: 4 },
      { id: beta, name: "Beta", credits: 3.2501, runs: 3 },
    ]);
  });

  it("buckets by UTC day over the whole window, oldest first, zero where nothing settled", async () => {
    const { byDay, total } = await summarizeSpend(team, 30, NOW);
    expect(byDay).toHaveLength(30);
    expect(byDay[0]?.day).toBe("2026-08-17");
    expect(byDay[29]?.day).toBe("2026-09-15");
    const spent = Object.fromEntries(byDay.filter((d) => d.credits > 0).map((d) => [d.day, d.credits]));
    expect(spent).toEqual({
      "2026-09-15": 14.5,
      "2026-09-14": 1,
      "2026-09-13": 2.2501,
      "2026-09-09": 5,
      "2026-09-08": 20,
    });
    expect(byDay.reduce((sum, d) => sum + d.credits, 0)).toBeCloseTo(total, 4);
  });
});

describe("summarizeSpend: other windows", () => {
  it("the 7-day window opens at midnight UTC six days back and leaves older rows out", async () => {
    const report = await summarizeSpend(team, 7, NOW);
    expect(report.days).toBe(7);
    expect(report.total).toBe(22.7501);
    expect(report.runs).toBe(6);
    expect(report.byDay).toHaveLength(7);
    expect(report.byDay[0]).toEqual({ day: "2026-09-09", credits: 5 });
    expect(report.byDay.at(-1)?.day).toBe("2026-09-15");
    /* Without the 20-credit run from the 8th, Ben outspends Ada. */
    expect(report.byMember.map((m) => [m.name, m.credits, m.runs])).toEqual([
      ["Ben", 15.0001, 3],
      ["Ada", 6.75, 2],
      ["Former member", 1, 1],
    ]);
    expect(report.byProduct.map((p) => [p.name, p.credits])).toEqual([
      ["Alpha", 19.5],
      ["Beta", 3.2501],
    ]);
  });

  it("the 90-day window reaches the run from August", async () => {
    const report = await summarizeSpend(team, 90, NOW);
    expect(report.total).toBe(142.7501);
    expect(report.runs).toBe(8);
    expect(report.byDay).toHaveLength(90);
    expect(report.byDay.find((d) => d.day === "2026-08-01")?.credits).toBe(100);
  });

  it("answers zeros and empty tables for a team that has not spent", async () => {
    const fresh = await seedTeam(db, { name: "Fresh" });
    const report = await summarizeSpend(fresh, 30, NOW);
    expect(report).toMatchObject({ days: 30, total: 0, runs: 0, byMember: [], byProduct: [] });
    expect(report.byDay).toHaveLength(30);
    expect(report.byDay.every((d) => d.credits === 0)).toBe(true);
  });
});

describe("getSpend", () => {
  it("answers the asked-for window for the signed-in team", async () => {
    const out = await getSpend({ days: 7 });
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error(out.error);
    expect(out.data.days).toBe(7);
    expect(out.data.byDay).toHaveLength(7);
    expect(out.data.byDay.at(-1)?.day).toBe(new Date().toISOString().slice(0, 10));
  });

  it("falls back to 30 days for a missing or unknown period", async () => {
    for (const data of [undefined, null, {}, { days: 45 }, { days: "7" }, "30"]) {
      const out = await getSpend(data);
      if (!out.ok) throw new Error(out.error);
      expect(out.data.days).toBe(30);
      expect(out.data.byDay).toHaveLength(30);
    }
  });

  it("folds a failed sign-in into a coded failure", async () => {
    vi.mocked(requireTeam).mockRejectedValue(Object.assign(new Error("Sign in to continue"), { name: "UnauthenticatedError" }));
    expect(await getSpend({ days: 7 })).toEqual({ ok: false, error: "Sign in to continue", code: "unauthenticated" });
  });
});
