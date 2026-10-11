import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GET } from "@/app/api/studio/[resource]/route";
import { requireTeam, UnauthenticatedError } from "@/server/team";
import { createProduct, getWorkspace, updateProduct } from "@/server/project-actions";
import { envForTests, resetStubs, seedTeam, useMemoryStore, useTestDatabase, type TestDb } from "./harness";

vi.mock("@/server/team", async (original) => ({
  ...await original<typeof import("@/server/team")>(), requireTeam: vi.fn(),
}));
let db: TestDb;
beforeEach(async () => {
  envForTests();
  db = await useTestDatabase();
  useMemoryStore();
  vi.mocked(requireTeam).mockReset();
});
afterEach(resetStubs);

it("keeps the existing Inbox while reading current workspace names", async () => {
  const team = await seedTeam(db);
  vi.mocked(requireTeam).mockResolvedValue(team);
  const initial = await getWorkspace();
  if (!initial.ok) throw new Error(initial.error);
  const general = initial.data.products.find((product) => product.slug === "general")!;
  await updateProduct({ productId: general.id, name: "My workspace" });
  const response = await GET(new Request("http://localhost/api/studio/workspace"), { params: Promise.resolve({ resource: "workspace" }) });
  const result = await response.json();
  expect(result.data.defaultProjectId).toBe(initial.data.defaultProjectId);
  expect(result.data.products).toEqual([expect.objectContaining({ id: general.id, name: "My workspace", projects: [expect.objectContaining({ id: initial.data.defaultProjectId })] })]);
});

it.each(["workspace", "gallery", "changes", "facets", "assets", "key-status", "team", "templates", "spend", "credits"])("requires a signed-in team for %s reads", async (resource) => {
  vi.mocked(requireTeam).mockRejectedValue(new UnauthenticatedError());
  const response = await GET(new Request(`http://localhost/api/studio/${resource}`), { params: Promise.resolve({ resource }) });
  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({ ok: false, error: "Sign in to continue", code: "unauthenticated" });
});

it.each(["createProduct", "__proto__", "constructor"])("does not expose %s as a read operation", async (resource) => {
  const response = await GET(new Request(`http://localhost/api/studio/${resource}`), { params: Promise.resolve({ resource }) });
  expect(response.status).toBe(404);
});

it("rejects malformed JSON parameters", async () => {
  const response = await GET(new Request("http://localhost/api/studio/gallery?input=%7B"), { params: Promise.resolve({ resource: "gallery" }) });
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ ok: false, code: "invalid" });
});

it("loads only the signed-in team's projects through the independent read endpoint", async () => {
  const ours = await seedTeam(db);
  const theirs = await seedTeam(db);
  vi.mocked(requireTeam).mockResolvedValue(theirs);
  await createProduct({ name: "Other team's product" });
  vi.mocked(requireTeam).mockResolvedValue(ours);
  await createProduct({ name: "Our product" });

  const response = await GET(new Request("http://localhost/api/studio/workspace"), { params: Promise.resolve({ resource: "workspace" }) });
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toContain("no-store");
  const body = await response.json();
  expect(body.ok).toBe(true);
  const names = body.data.products.map((product: { name: string }) => product.name);
  expect(names).toContain("Our product");
  expect(names).not.toContain("Other team's product");
  expect(body.data.products.flatMap((product: { projects: { id: string }[] }) => product.projects).map((project: { id: string }) => project.id)).toContain(body.data.defaultProjectId);
});
