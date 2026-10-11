import { afterEach, expect, it, vi } from "vitest";
import { enqueue } from "@/server/jobs/queue";
import { kickJobs } from "@/server/jobs/runner";
import { envForTests, resetStubs, useMemoryStore, useTestDatabase } from "./harness";

// The hosting boundary retains only callbacks registered before the response.
const host = vi.hoisted(() => ({ callbacks: [] as Array<() => Promise<unknown>> }));
vi.mock("next/server", () => ({ after: (callback: () => Promise<unknown>) => { host.callbacks.push(callback); } }));
afterEach(() => { resetStubs(); vi.unstubAllEnvs(); host.callbacks = []; });

it("registers background work before the serverless response closes", async () => {
  envForTests();
  vi.stubEnv("NODE_ENV", "production");
  await useTestDatabase();
  const store = useMemoryStore();
  await store.put("t/probe.png", new Uint8Array([1]), "image/png");
  await enqueue("purge_media", "t/probe.png", { key: "t/probe.png" });
  kickJobs();
  const retained = host.callbacks.slice();
  await Promise.all(retained.map((callback) => callback()));
  expect(await store.head("t/probe.png")).toBeNull();
});
