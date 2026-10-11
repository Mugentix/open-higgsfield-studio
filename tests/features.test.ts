import { afterEach, describe, expect, it, vi } from "vitest";

/* The Agents surface is built but off until NEXT_PUBLIC_AGENTS=1. Off, the
   upload route answers as if it did not exist, whatever the caller sends. */
describe("the Agents surface", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("is off unless the flag is exactly 1", async () => {
    vi.stubEnv("NEXT_PUBLIC_AGENTS", "");
    vi.resetModules();
    expect((await import("@/features")).AGENTS_ENABLED).toBe(false);
    vi.stubEnv("NEXT_PUBLIC_AGENTS", "true");
    vi.resetModules();
    expect((await import("@/features")).AGENTS_ENABLED).toBe(false);
    vi.stubEnv("NEXT_PUBLIC_AGENTS", "1");
    vi.resetModules();
    expect((await import("@/features")).AGENTS_ENABLED).toBe(true);
  });

  it("answers 404 from the upload route while off, before any sign-in check", async () => {
    vi.stubEnv("NEXT_PUBLIC_AGENTS", "");
    vi.resetModules();
    const { POST } = await import("@/app/api/skills/route");
    const response = await POST(new Request("http://localhost/api/skills", { method: "POST", body: new FormData() }));
    expect(response.status).toBe(404);
  });
});
