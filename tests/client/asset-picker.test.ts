// @vitest-environment jsdom
import { createElement } from "react";
import { Blob, File } from "node:buffer";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

import { AssetPicker } from "@/openhiggsfield/asset-picker";
import { makeQueryClient } from "@/openhiggsfield/gallery-data";
import { getModel } from "@/generation/catalog";
import { createRun } from "@/server/runs";
import { schema } from "@/server/db/client";
import { requireTeam } from "@/server/team";
import { envForTests, resetStubs, seedTeam, stubKie, useMemoryStore, useTestDatabase } from "../server/harness";

// Replace only session lookup; the picker reads the real database through its action.
vi.mock("@/server/team", () => ({ requireTeam: vi.fn() }));
vi.setConfig({ testTimeout: 30_000 });
afterEach(() => { cleanup(); resetStubs(); });

it("attaches a generated image to a video without relying on the visible gallery", async () => {
  envForTests();
  // PGlite needs arrayBuffer(), which jsdom's browser Blob does not supply.
  vi.stubGlobal("Blob", Blob);
  vi.stubGlobal("File", File);
  const db = await useTestDatabase();
  useMemoryStore();
  stubKie();
  const team = await seedTeam(db);
  vi.mocked(requireTeam).mockResolvedValue(team);
  const run = await createRun(team, {
    idempotencyKey: "reference",
    plane: { model: "nano-banana-pro", prompt: { text: "Saved reference" }, media: {}, settings: {} },
  });
  const url = "https://media.test/reference.png";
  await db.update(schema.results).set({ status: "completed", url }).where(eq(schema.results.id, run.resultIds[0]!));
  const onApply = vi.fn();
  const client = makeQueryClient();
  render(createElement(QueryClientProvider, { client }, createElement(AssetPicker, {
    model: getModel("kling-2.5"), items: [], uploads: [], staged: [], stagedRole: null,
    uploading: false, progress: null, note: null, blocked: {}, productId: null,
    onUpload: vi.fn(), onDrop: vi.fn(), onApply, onPin: vi.fn(), onClose: vi.fn(),
  })));
  fireEvent.click(screen.getByRole("tab", { name: /Generations/ }));
  fireEvent.click(await screen.findByRole("button", { name: "Saved reference" }));
  expect(onApply.mock.calls[0]?.slice(0, 2)).toEqual(["start", [url]]);
  expect(onApply.mock.calls[0]?.[2](url)).toEqual({ resultId: run.resultIds[0] });
  client.clear();
});
