import { kieSurface } from "./catalog";
import type { KieRequest } from "./catalog/types";
import { KieError, createKieClient, type KieRecord } from "./kie/client";

export { KieError as PlatformError };

/** KIE's five states folded into the three the grid draws, and the result
    urls sorted into the kind the model produces. */
export type GenerationStatus = {
  status: "running" | "completed" | "failed";
  requestId: string;
  images?: Array<{ url: string }>;
  video?: { url: string };
  error?: string;
  creditsConsumed?: number;
};

export type PlatformClientOptions = {
  apiKey: string;
  baseUrl?: string;
  uploadBaseUrl?: string;
  fetch?: typeof fetch;
};

/** A thin, session-free client: the probe script and the key check use it;
    the studio's runs go through src/server/runs.ts. */
export function createPlatformClient(options: PlatformClientOptions) {
  const kie = createKieClient(options);
  return {
    async submit(request: KieRequest): Promise<{ requestId: string }> {
      const { taskId } = await kie.createTask(request);
      return { requestId: taskId };
    },
    async status(requestId: string): Promise<GenerationStatus> {
      if (!requestId) throw new KieError(400, 400, "Missing task id");
      return toStatus(await kie.recordInfo(requestId));
    },
    credits: kie.credits,
    uploadStream: kie.uploadStream,
  };
}

const VIDEO_EXT = /\.(mp4|mov|webm|m4v)(\?|#|$)/i;

export function toStatus(record: KieRecord): GenerationStatus {
  const base = { requestId: record.taskId };
  if (record.state === "fail") {
    const why = record.failMsg || "the platform reported a failure";
    return {
      ...base,
      status: "failed",
      error: record.failCode && !why.includes(record.failCode) ? `${why} (${record.failCode})` : why,
    };
  }
  if (record.state !== "success") return { ...base, status: "running" };
  const urls = record.resultUrls;
  if (urls.length === 0) {
    return { ...base, status: "failed", error: "the platform finished without a result" };
  }
  const surface = kieSurface(record.model) ?? (VIDEO_EXT.test(urls[0]!) ? "video" : "image");
  return {
    ...base,
    status: "completed",
    ...(surface === "video" ? { video: { url: urls[0]! } } : { images: urls.map((url) => ({ url })) }),
    ...(record.creditsConsumed !== undefined ? { creditsConsumed: record.creditsConsumed } : {}),
  };
}
