import { afterEach, expect, it, vi } from "vitest";
import { readStudio } from "@/openhiggsfield/studio-read";

afterEach(() => vi.unstubAllGlobals());

it("preserves session-expired errors for the sign-in flow", async () => {
  vi.stubGlobal("fetch", async () => Response.json({ ok: false, error: "Sign in to continue", code: "unauthenticated" }, { status: 401 }));
  expect(await readStudio("workspace")).toEqual({ ok: false, error: "Sign in to continue", code: "unauthenticated" });
});

it("lets a cancelled gallery request abort instead of treating it as a connection error", async () => {
  vi.stubGlobal("fetch", (_input: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init.signal?.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError")));
  }));
  const controller = new AbortController();
  const pending = readStudio("gallery", { filter: { view: "image" } }, controller.signal);
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
});

it("finishes project loading while an earlier gallery read is still waiting", async () => {
  let release!: (response: Response) => void;
  const delayed = new Promise<Response>((resolve) => { release = resolve; });
  vi.stubGlobal("fetch", (input: string) => {
    if (input.startsWith("/api/studio/gallery")) return delayed;
    if (input === "/api/studio/workspace") return Promise.resolve(Response.json({ ok: true, data: { products: [], defaultProjectId: "inbox" } }));
    throw new Error(`Unexpected request: ${input}`);
  });
  let galleryDone = false;
  const gallery = readStudio("gallery", { filter: { view: "image" } }).then((result) => { galleryDone = true; return result; });
  const workspace = await readStudio("workspace");
  expect(workspace).toEqual({ ok: true, data: { products: [], defaultProjectId: "inbox" } });
  expect(galleryDone).toBe(false);
  release(Response.json({ ok: true, data: { items: [], nextCursor: null, at: 1000 } }));
  expect(await gallery).toEqual({ ok: true, data: { items: [], nextCursor: null, at: 1000 } });
});
