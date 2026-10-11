import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { extensionFor, frameKey, isSafeKey, mimeForKey, resultKey, uploadKey } from "@/server/storage/keys";

/* keys.ts is pure and imported up front. local.ts pins LOCAL_MEDIA_DIR to
   process.cwd() at load, so the process moves into a scratch directory
   before that module (and the two routes built on it) is imported; nothing
   here touches the checkout's .data. */

type LocalModule = typeof import("@/server/storage/local");
type PutRoute = typeof import("@/app/api/media/put/route");
type MediaRoute = typeof import("@/app/media/[...key]/route");

let local: LocalModule;
let putRoute: PutRoute;
let mediaRoute: MediaRoute;
let scratch: string;
const originalCwd = process.cwd();
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ["BETTER_AUTH_URL", "APP_URL", "APP_SECRET_KEY"] as const;

beforeAll(async () => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  scratch = await mkdtemp(path.join(os.tmpdir(), "ohf-storage-"));
  process.chdir(scratch);
  local = await import("@/server/storage/local");
  putRoute = await import("@/app/api/media/put/route");
  mediaRoute = await import("@/app/media/[...key]/route");
});

afterAll(async () => {
  process.chdir(originalCwd);
  await rm(scratch, { recursive: true, force: true });
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

const PNG = new Uint8Array([137, 80, 78, 71]);
const TEAM = "11111111-2222-4333-8444-555555555555";
const PROJECT = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const RUN = "99999999-8888-4777-8666-555555555555";

describe("keys: extensionFor", () => {
  it.each([
    ["image/png", undefined, "png"],
    ["image/jpeg", undefined, "jpg"],
    ["video/mp4", undefined, "mp4"],
    ["video/quicktime", undefined, "mov"],
    ["audio/x-wav", undefined, "wav"],
    ["IMAGE/PNG", undefined, "png"],
    ["image/jpeg; charset=binary", undefined, "jpg"],
  ])("maps %s to .%s", (mime, url, ext) => {
    expect(extensionFor(mime, url)).toBe(ext);
  });

  it("falls back to a known extension in the url when the content type does not help", () => {
    expect(extensionFor(null, "https://tempfile.test/out/1.jpg")).toBe("jpg");
    expect(extensionFor("application/octet-stream", "https://tempfile.test/out/1.jpg?sig=abc#frag")).toBe("jpg");
    expect(extensionFor(undefined, "https://tempfile.test/out/1.JPG")).toBe("jpg");
    expect(extensionFor("", "https://tempfile.test/out/clip.mp4")).toBe("mp4");
  });

  it("prefers the content type over the url when both are known", () => {
    expect(extensionFor("image/webp", "https://tempfile.test/out/1.jpg")).toBe("webp");
  });

  it("answers bin for anything it does not know", () => {
    expect(extensionFor("text/plain", "https://tempfile.test/out/readme")).toBe("bin");
    expect(extensionFor(undefined, "https://tempfile.test/out/tool.exe")).toBe("bin");
    expect(extensionFor(null, undefined)).toBe("bin");
    expect(extensionFor("image/svg+xml", "https://tempfile.test/out/x.svg")).toBe("bin");
  });
});

describe("keys: mimeForKey", () => {
  it("reads the mime back off the key's extension", () => {
    expect(mimeForKey(`t/${TEAM}/p/${PROJECT}/r/${RUN}/0.png`)).toBe("image/png");
    expect(mimeForKey("t/x/u/2026/09/a.MP4")).toBe("video/mp4");
    expect(mimeForKey("t/x/u/2026/09/a.jpg")).toBe("image/jpeg");
  });

  it("answers octet-stream for a bare or unknown extension", () => {
    expect(mimeForKey("t/x/u/2026/09/a")).toBe("application/octet-stream");
    expect(mimeForKey("t/x/u/2026/09/a.bin")).toBe("application/octet-stream");
  });
});

describe("keys: isSafeKey", () => {
  it("accepts the keys this app mints", () => {
    expect(isSafeKey(resultKey(TEAM, PROJECT, RUN, 0, "png"))).toBe(true);
    expect(isSafeKey(uploadKey(TEAM, RUN, "jpg"))).toBe(true);
    expect(isSafeKey(frameKey(TEAM, PROJECT, RUN, 2, "last"))).toBe(true);
    expect(isSafeKey("t/a-b_c.d/e.png")).toBe(true);
  });

  it.each([
    ["t/../../etc/passwd"],
    ["t/x/..%2Fetc"],
    ["../t/x.png"],
    ["t/x/.."],
    ["/t/x.png"],
    ["t/x y.png"],
    [" t/x.png"],
    ["t/x.png "],
    ["t/x.png\n"],
    ["t/x.png?x=1"],
    ["t/x\\y.png"],
    ["t/ünïcode.png"],
    ["ab"],
    [""],
  ])("rejects %j", (key) => {
    expect(isSafeKey(key)).toBe(false);
  });

  it("rejects a key longer than 400 characters", () => {
    expect(isSafeKey(`t/${"a".repeat(398)}`)).toBe(true);
    expect(isSafeKey(`t/${"a".repeat(399)}`)).toBe(false);
  });
});

describe("keys: shapes", () => {
  it("resultKey and frameKey nest team, project and run with the index and extension", () => {
    expect(resultKey(TEAM, PROJECT, RUN, 0, "png")).toBe(`t/${TEAM}/p/${PROJECT}/r/${RUN}/0.png`);
    expect(resultKey(TEAM, PROJECT, RUN, 3, "mp4")).toBe(`t/${TEAM}/p/${PROJECT}/r/${RUN}/3.mp4`);
    expect(frameKey(TEAM, PROJECT, RUN, 1, "first")).toBe(`t/${TEAM}/p/${PROJECT}/r/${RUN}/1.first.jpg`);
    expect(frameKey(TEAM, PROJECT, RUN, 1, "last")).toBe(`t/${TEAM}/p/${PROJECT}/r/${RUN}/1.last.jpg`);
  });

  it("uploadKey files the asset under the current UTC year and month", () => {
    const now = new Date();
    const yyyy = now.getUTCFullYear();
    const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
    expect(uploadKey(TEAM, RUN, "jpg")).toBe(`t/${TEAM}/u/${yyyy}/${mm}/${RUN}.jpg`);
  });
});

describe("local: signPut / verifyPut", () => {
  const key = `t/${TEAM}/u/2026/09/asset.png`;

  it("round-trips a signature made for the same key, type, size and expiry", () => {
    const exp = Date.now() + 60_000;
    const sig = local.signPut(key, "image/png", 4, exp);
    expect(sig).toMatch(/^[a-f0-9]{64}$/);
    expect(local.signPut(key, "image/png", 4, exp)).toBe(sig);
    expect(local.verifyPut(key, "image/png", 4, exp, sig)).toBe(true);
  });

  it("fails when the size, type, key or expiry is not what was signed", () => {
    const exp = Date.now() + 60_000;
    const sig = local.signPut(key, "image/png", 4, exp);
    expect(local.verifyPut(key, "image/png", 5, exp, sig)).toBe(false);
    expect(local.verifyPut(key, "image/jpeg", 4, exp, sig)).toBe(false);
    expect(local.verifyPut(`t/${TEAM}/u/2026/09/other.png`, "image/png", 4, exp, sig)).toBe(false);
    expect(local.verifyPut(key, "image/png", 4, exp + 1, sig)).toBe(false);
  });

  it("fails once the expiry has passed, even with the right signature", () => {
    const exp = Date.now() - 1;
    const sig = local.signPut(key, "image/png", 4, exp);
    expect(local.verifyPut(key, "image/png", 4, exp, sig)).toBe(false);
  });

  it("fails on a malformed expiry or signature without throwing", () => {
    const exp = Date.now() + 60_000;
    expect(local.verifyPut(key, "image/png", 4, Number.NaN, local.signPut(key, "image/png", 4, Number.NaN))).toBe(false);
    expect(local.verifyPut(key, "image/png", 4, exp, "")).toBe(false);
    expect(local.verifyPut(key, "image/png", 4, exp, "deadbeef")).toBe(false);
    expect(local.verifyPut(key, "image/png", 4, exp, "z".repeat(64))).toBe(false);
  });

  it("is bound to APP_SECRET_KEY: a signature from the dev key fails under a real one", () => {
    const exp = Date.now() + 60_000;
    const devSig = local.signPut(key, "image/png", 4, exp);
    process.env.APP_SECRET_KEY = "a-real-secret";
    expect(local.signPut(key, "image/png", 4, exp)).not.toBe(devSig);
    expect(local.verifyPut(key, "image/png", 4, exp, devSig)).toBe(false);
    expect(local.verifyPut(key, "image/png", 4, exp, local.signPut(key, "image/png", 4, exp))).toBe(true);
  });
});

describe("local: LocalStore", () => {
  it("lives under <cwd>/.data/media, which here is the scratch directory", () => {
    expect(local.LOCAL_MEDIA_DIR).toBe(path.join(scratch, ".data", "media"));
    expect(local.LOCAL_MEDIA_DIR.startsWith(originalCwd)).toBe(false);
  });

  it("puts bytes, heads them back and removes them", async () => {
    const store = new local.LocalStore();
    const key = `t/${TEAM}/u/2026/09/roundtrip.png`;
    expect(store.kind).toBe("local");
    expect(store.public).toBe(false);

    const put = await store.put(key, PNG, "image/png");
    expect(put).toEqual({ bytes: 4 });
    expect(await readFile(path.join(scratch, ".data", "media", key))).toEqual(Buffer.from(PNG));

    expect(await store.head(key)).toEqual({ bytes: 4, contentType: "image/png" });

    await store.remove(key);
    expect(await store.head(key)).toBeNull();
    await expect(stat(path.join(scratch, ".data", "media", key))).rejects.toThrow();
  });

  it("counts the bytes of a streamed body across chunks", async () => {
    const store = new local.LocalStore();
    const key = `t/${TEAM}/p/${PROJECT}/r/${RUN}/0.mp4`;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.enqueue(new Uint8Array([4, 5]));
        controller.enqueue(new Uint8Array([6]));
        controller.close();
      },
    });
    expect(await store.put(key, body, "video/mp4")).toEqual({ bytes: 6 });
    expect(await store.head(key)).toEqual({ bytes: 6, contentType: "video/mp4" });
    expect(await readFile(path.join(scratch, ".data", "media", key))).toEqual(Buffer.from([1, 2, 3, 4, 5, 6]));
  });

  it("refuses an unsafe key before touching the filesystem", async () => {
    const store = new local.LocalStore();
    await expect(store.put("../escape.png", PNG, "image/png")).rejects.toThrow("Unsafe media key");
    expect(() => local.localPath("/abs.png")).toThrow("Unsafe media key");
    expect(await store.head("../escape.png")).toBeNull();
    await expect(stat(path.join(scratch, ".data", "escape.png"))).rejects.toThrow();
  });

  it("removing a key that was never put is not an error", async () => {
    await expect(new local.LocalStore().remove(`t/${TEAM}/u/2026/09/missing.png`)).resolves.toBeUndefined();
  });

  it("presigns a PUT to the app's own route whose signature verifies", async () => {
    const store = new local.LocalStore();
    const key = `t/${TEAM}/u/2026/09/presigned.png`;
    const before = Date.now();
    const ticket = await store.presignPut(key, "image/png", 4);
    const url = new URL(ticket.url);
    expect(url.origin).toBe("http://localhost:3000");
    expect(url.pathname).toBe("/api/media/put");
    expect(url.searchParams.get("key")).toBe(key);
    expect(url.searchParams.get("type")).toBe("image/png");
    expect(url.searchParams.get("size")).toBe("4");
    expect(Number(url.searchParams.get("exp"))).toBe(ticket.expiresAt);
    expect(ticket.expiresAt).toBeGreaterThanOrEqual(before + 15 * 60_000);
    expect(ticket.expiresAt).toBeLessThanOrEqual(Date.now() + 15 * 60_000);
    expect(ticket.headers).toEqual({ "Content-Type": "image/png" });
    expect(local.verifyPut(key, "image/png", 4, ticket.expiresAt, url.searchParams.get("sig") ?? "")).toBe(true);
  });

  it("serves public urls from the app origin, honouring APP_URL without a trailing slash", async () => {
    const key = `t/${TEAM}/u/2026/09/served.png`;
    expect(new local.LocalStore().publicUrl(key)).toBe(`http://localhost:3000/media/${key}`);
    process.env.APP_URL = "https://studio.example.com/";
    expect(new local.LocalStore().publicUrl(key)).toBe(`https://studio.example.com/media/${key}`);
    expect(new URL((await new local.LocalStore().presignPut(key, "image/png", 4)).url).origin).toBe("https://studio.example.com");
    process.env.BETTER_AUTH_URL = "https://auth.example.com";
    expect(new local.LocalStore().publicUrl(key)).toBe(`https://auth.example.com/media/${key}`);
  });
});

describe("routes: PUT /api/media/put", () => {
  async function signedUrl(key: string, type: string, size: number): Promise<string> {
    return (await new local.LocalStore().presignPut(key, type, size)).url;
  }

  it("stores the body when the signature and size match", async () => {
    const key = `t/${TEAM}/u/2026/09/route-ok.png`;
    const res = await putRoute.PUT(new Request(await signedUrl(key, "image/png", 4), { method: "PUT", body: PNG }));
    expect(res.status).toBe(200);
    expect(await new local.LocalStore().head(key)).toEqual({ bytes: 4, contentType: "image/png" });
  });

  it("refuses a tampered or missing signature with 403 and writes nothing", async () => {
    const key = `t/${TEAM}/u/2026/09/route-tamper.png`;
    const url = new URL(await signedUrl(key, "image/png", 4));
    url.searchParams.set("size", "400000000");
    const res = await putRoute.PUT(new Request(url, { method: "PUT", body: PNG }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Bad or expired upload signature" });
    expect(await new local.LocalStore().head(key)).toBeNull();

    const bare = new URL(await signedUrl(key, "image/png", 4));
    bare.searchParams.delete("sig");
    expect((await putRoute.PUT(new Request(bare, { method: "PUT", body: PNG }))).status).toBe(403);
  });

  it("refuses an unsafe key even when it was signed", async () => {
    const key = "t/../escape.png";
    const exp = Date.now() + 60_000;
    const params = new URLSearchParams({ key, type: "image/png", size: "4", exp: String(exp), sig: local.signPut(key, "image/png", 4, exp) });
    const res = await putRoute.PUT(new Request(`http://localhost:3000/api/media/put?${params}`, { method: "PUT", body: PNG }));
    expect(res.status).toBe(403);
    await expect(stat(path.join(scratch, ".data", "escape.png"))).rejects.toThrow();
  });

  it("refuses an empty body with 400", async () => {
    const key = `t/${TEAM}/u/2026/09/route-empty.png`;
    const res = await putRoute.PUT(new Request(await signedUrl(key, "image/png", 4), { method: "PUT" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Empty body" });
  });

  it("removes the object and answers 400 when fewer bytes arrive than were signed", async () => {
    const key = `t/${TEAM}/u/2026/09/route-short.png`;
    const res = await putRoute.PUT(new Request(await signedUrl(key, "image/png", 4), { method: "PUT", body: PNG.slice(0, 3) }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Expected 4 bytes, received 3" });
    expect(await new local.LocalStore().head(key)).toBeNull();
  });
});

describe("routes: GET /media/[...key]", () => {
  function get(parts: string[]) {
    return mediaRoute.GET(new Request(`http://localhost:3000/media/${parts.join("/")}`), { params: Promise.resolve({ key: parts }) });
  }

  it("serves a stored object with its mime, length and immutable caching", async () => {
    const key = `t/${TEAM}/p/${PROJECT}/r/${RUN}/0.png`;
    await new local.LocalStore().put(key, PNG, "image/png");
    const res = await get(key.split("/"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("content-length")).toBe("4");
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);
  });

  it("answers 404 for an object that was never stored", async () => {
    expect((await get(["t", TEAM, "u", "2026", "09", "nope.png"])).status).toBe(404);
  });

  it("answers 404 for a directory rather than listing it", async () => {
    const key = `t/${TEAM}/p/${PROJECT}/r/${RUN}/1.png`;
    await new local.LocalStore().put(key, PNG, "image/png");
    expect((await get(["t", TEAM, "p", PROJECT, "r", RUN])).status).toBe(404);
  });

  it("answers 400 for a key with a traversal or an odd character", async () => {
    expect((await get(["t", "..", "..", "etc", "passwd"])).status).toBe(400);
    expect((await get(["t", "x y.png"])).status).toBe(400);
  });
});
