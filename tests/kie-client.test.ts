import { afterEach, describe, expect, it, vi } from "vitest";

import { createKieClient, parseRecord } from "@/generation/kie/client";
import { toStatus } from "@/generation/platform";

afterEach(() => vi.useRealTimers());

it("releases a worker when a KIE status request never answers", async () => {
  vi.useFakeTimers();
  const client = createKieClient({ apiKey: "test", fetch: async (_input, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
  }) });
  let failure: unknown;
  const waiting = client.recordInfo("existing-task").catch((error) => { failure = error; });
  await vi.advanceTimersByTimeAsync(15_000);
  expect(failure).toMatchObject({ name: "TimeoutError" });
  await waiting;
});

describe("recordInfo parsing", () => {
  it("reads resultJson as a JSON string and folds success into completed", () => {
    const record = parseRecord({
      taskId: "t1",
      model: "nano-banana-pro",
      state: "success",
      resultJson: JSON.stringify({ resultUrls: ["https://tempfile.example/a.png"] }),
      failCode: "",
      failMsg: "",
      creditsConsumed: 8,
    });
    expect(record.resultUrls).toEqual(["https://tempfile.example/a.png"]);
    expect(toStatus(record)).toEqual({
      requestId: "t1",
      status: "completed",
      images: [{ url: "https://tempfile.example/a.png" }],
      creditsConsumed: 8,
    });
  });

  it("sorts a video model's result under video", () => {
    const record = parseRecord({
      taskId: "t2",
      model: "bytedance/seedance-2-fast",
      state: "success",
      resultJson: '{"resultUrls":["https://tempfile.example/a.mp4"],"lastFrameUrl":["https://tempfile.example/l.jpg"]}',
    });
    expect(record.lastFrameUrls).toEqual(["https://tempfile.example/l.jpg"]);
    expect(toStatus(record)).toMatchObject({ status: "completed", video: { url: "https://tempfile.example/a.mp4" } });
  });

  it("keeps waiting/queuing/generating as running and fail as failed with the reason", () => {
    for (const state of ["waiting", "queuing", "generating"]) {
      expect(toStatus(parseRecord({ taskId: "t", state })).status).toBe("running");
    }
    const failed = toStatus(
      parseRecord({ taskId: "t", state: "fail", failCode: "GENERATION_FAILED", failMsg: "The generation task failed." }),
    );
    expect(failed).toEqual({ requestId: "t", status: "failed", error: "The generation task failed. (GENERATION_FAILED)" });
  });

  it("treats a success without urls as a failure rather than an empty tile", () => {
    expect(toStatus(parseRecord({ taskId: "t", state: "success", resultJson: "{}" })).status).toBe("failed");
  });
});
