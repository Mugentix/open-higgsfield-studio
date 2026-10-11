import { afterEach, expect, it, vi } from "vitest";
import { R2Store } from "@/server/storage/r2";
import { mediaStore } from "@/server/storage";

afterEach(() => { vi.unstubAllEnvs(); globalThis.__ohfStore = undefined; });

it("uses an absolute HTTPS media URL when the configured domain omits its scheme", () => {
  const store = new R2Store({ accountId: "test", accessKeyId: "test", secretAccessKey: "test", bucket: "test", publicBaseUrl: "storage.example.com/" });
  expect(store.publicUrl("t/team/result.png")).toBe("https://storage.example.com/t/team/result.png");
});

it("accepts R2_BUCKET_NAME for the configured cloud store", () => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("R2_ACCOUNT_ID", "test");
  vi.stubEnv("R2_ACCESS_KEY_ID", "test");
  vi.stubEnv("R2_SECRET_ACCESS_KEY", "test");
  vi.stubEnv("R2_BUCKET", "");
  vi.stubEnv("R2_BUCKET_NAME", "automation");
  vi.stubEnv("R2_PUBLIC_BASE_URL", "https://media.example.com");
  expect(mediaStore().publicUrl("t/team/result.png")).toBe("https://media.example.com/t/team/result.png");
});
