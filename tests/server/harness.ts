import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { vi } from "vitest";

import * as schema from "@/server/db/schema";
import type { MediaStore, PresignedPut } from "@/server/storage";
import type { TeamContext } from "@/server/team";

/* Everything the server core reaches for, swapped for in-memory doubles: the
   database (a fresh PGlite with the real migrations), the media store, KIE's
   HTTP API, and the signed-in team. Install before importing modules that
   query, and always through these helpers so each test file starts clean. */

export type TestDb = ReturnType<typeof drizzle<typeof schema>>;

export async function useTestDatabase(): Promise<TestDb> {
  const client = new PGlite();
  const db = drizzle({ client, schema });
  await migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
  globalThis.__ohfDb = { db, ready: Promise.resolve(), kind: "pglite" };
  return db;
}

export class MemoryStore implements MediaStore {
  readonly kind = "local" as const;
  public = true;
  readonly objects = new Map<string, { bytes: Uint8Array; contentType: string }>();

  async put(key: string, body: ReadableStream<Uint8Array> | Uint8Array, contentType: string) {
    const bytes = body instanceof Uint8Array ? body : new Uint8Array(await new Response(body).arrayBuffer());
    this.objects.set(key, { bytes, contentType });
    return { bytes: bytes.byteLength };
  }
  async presignPut(key: string, contentType: string, contentLength: number): Promise<PresignedPut> {
    return { url: `memory://put/${key}?size=${contentLength}`, headers: { "Content-Type": contentType }, expiresAt: Date.now() + 60_000 };
  }
  async head(key: string) {
    const object = this.objects.get(key);
    return object ? { bytes: object.bytes.byteLength, contentType: object.contentType } : null;
  }
  async remove(key: string) {
    this.objects.delete(key);
  }
  async sha256(key: string): Promise<string | null> {
    const object = this.objects.get(key);
    return object ? createHash("sha256").update(object.bytes).digest("hex") : null;
  }
  publicUrl(key: string): string {
    return `https://media.test/${key}`;
  }
}

export function useMemoryStore(options: { public?: boolean } = {}): MemoryStore {
  const store = new MemoryStore();
  store.public = options.public ?? true;
  globalThis.__ohfStore = store;
  return store;
}

/** A user, a team and a membership, straight into the tables Better Auth owns. */
export async function seedTeam(
  db: TestDb,
  options: { name?: string; email?: string; role?: "owner" | "admin" | "member" } = {},
): Promise<TeamContext> {
  const userId = randomUUID();
  const teamId = randomUUID();
  const email = options.email ?? `${userId.slice(0, 8)}@example.com`;
  await db.insert(schema.user).values({ id: userId, name: options.name ?? "Tester", email, emailVerified: true });
  await db.insert(schema.organization).values({ id: teamId, name: options.name ?? "Test Team", slug: `team-${teamId.slice(0, 8)}`, createdAt: new Date() });
  await db.insert(schema.member).values({ id: randomUUID(), organizationId: teamId, userId, role: options.role ?? "owner", createdAt: new Date() });
  return { userId, userName: options.name ?? "Tester", userEmail: email, teamId, teamName: options.name ?? "Test Team", role: options.role ?? "owner" };
}

export type FakeKie = {
  tasks: Array<{ body: Record<string, unknown> }>;
  /** What recordInfo answers next, per task id (or for every task). */
  records: Map<string, Record<string, unknown>>;
  defaultRecord: Record<string, unknown>;
  createStatus: number;
  createBody: Record<string, unknown> | null;
  /** Bytes served for any url under https://tempfile.test/ */
  files: Map<string, { bytes: Uint8Array; contentType: string; status?: number }>;
  calls: string[];
};

/** Stubs global fetch for KIE's hosts and a fake file host; every other url
    is refused so a test never leaves the process. */
export function stubKie(): FakeKie {
  const fake: FakeKie = {
    tasks: [],
    records: new Map(),
    defaultRecord: { state: "generating" },
    createStatus: 200,
    createBody: null,
    files: new Map(),
    calls: [],
  };
  let counter = 0;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    fake.calls.push(url);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.startsWith("https://api.kie.ai/api/v1/jobs/createTask")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      fake.tasks.push({ body });
      if (fake.createBody) return json(fake.createBody, fake.createStatus);
      if (fake.createStatus !== 200) return json({ code: fake.createStatus, msg: `KIE error ${fake.createStatus}`, data: null }, fake.createStatus);
      return json({ code: 200, msg: "success", data: { taskId: `task_${++counter}` } });
    }
    if (url.startsWith("https://api.kie.ai/api/v1/jobs/recordInfo")) {
      const taskId = new URL(url).searchParams.get("taskId") ?? "";
      const record = fake.records.get(taskId) ?? fake.defaultRecord;
      return json({ code: 200, msg: "success", data: { taskId, model: "nano-banana-pro", ...record } });
    }
    if (url.startsWith("https://api.kie.ai/api/v1/chat/credit")) return json({ code: 200, msg: "success", data: 100 });
    if (url.startsWith("https://api.kie.ai/api/v1/common/download-url")) {
      const { url: stale } = JSON.parse(String(init?.body ?? "{}")) as { url: string };
      return json({ code: 200, msg: "success", data: `${stale}?fresh=1` });
    }
    if (url.startsWith("https://kieai.redpandaai.co/api/file-stream-upload")) {
      return json({ success: true, code: 200, msg: "ok", data: { downloadUrl: `https://tempfile.test/uploads/${++counter}.png` } });
    }
    if (url.startsWith("https://tempfile.test/") || url.startsWith("https://media.test/")) {
      const key = url.split("?")[0]!;
      const file = fake.files.get(key);
      if (!file) return new Response(null, { status: 404 });
      if (file.status && file.status !== 200) return new Response(null, { status: file.status });
      return new Response(file.bytes as unknown as BodyInit, { status: 200, headers: { "content-type": file.contentType } });
    }
    throw new Error(`Unexpected fetch in test: ${url}`);
  });
  return fake;
}

export function resetStubs(): void {
  vi.unstubAllGlobals();
  globalThis.__ohfDb = undefined;
  globalThis.__ohfStore = undefined;
  globalThis.__ohfJobsRunning = false;
}

export function envForTests(): void {
  process.env.KIE_API_KEY = "test-key-0123456789abcdef";
  delete process.env.APP_PUBLIC_URL;
  delete process.env.KIE_WEBHOOK_HMAC_KEY;
  delete process.env.DATABASE_URL;
}
