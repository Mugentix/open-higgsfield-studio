import type { KieRequest } from "../catalog/types";

export const KIE_API_BASE_URL = "https://api.kie.ai";
/* The upload service answers on its own host. The docs' OpenAPI blocks say
   api.kie.ai while every worked example says this one; keep it its own setting. */
export const KIE_UPLOAD_BASE_URL = "https://kieai.redpandaai.co";

export type KieState = "waiting" | "queuing" | "generating" | "success" | "fail";

export type KieRecord = {
  taskId: string;
  model: string;
  state: KieState;
  resultUrls: string[];
  /** Seedance 2 / 2 Fast with return_last_frame: one entry per result. */
  firstFrameUrls: string[];
  lastFrameUrls: string[];
  failCode: string;
  failMsg: string;
  creditsConsumed?: number;
  /** Raw from KIE: documented as milliseconds in recordInfo and seconds in callbacks. */
  costTime?: number;
  createTime?: number;
  completeTime?: number;
};

/** Body codes KIE answers with; HTTP status is not always aligned with them. */
const RETRYABLE = new Set([429, 455, 500, 502, 503, 504]);

export class KieError extends Error {
  readonly status: number;
  readonly code: number;
  readonly retryable: boolean;

  constructor(status: number, code: number, msg: string) {
    super(msg);
    this.name = "KieError";
    this.status = status;
    this.code = code;
    this.retryable = RETRYABLE.has(code) || RETRYABLE.has(status);
  }
}

export type KieClientOptions = {
  apiKey: string;
  baseUrl?: string;
  uploadBaseUrl?: string;
  fetch?: typeof fetch;
};

export type KieClient = ReturnType<typeof createKieClient>;

export function createKieClient(options: KieClientOptions) {
  const baseUrl = (options.baseUrl ?? KIE_API_BASE_URL).replace(/\/$/, "");
  const uploadBaseUrl = (options.uploadBaseUrl ?? KIE_UPLOAD_BASE_URL).replace(/\/$/, "");
  const fetchImpl = options.fetch ?? fetch;
  const auth = `Bearer ${options.apiKey}`;

  async function call(
    method: "GET" | "POST",
    url: string,
    body?: BodyInit,
    contentType?: string,
  ): Promise<Record<string, unknown>> {
    const response = await fetchImpl(url, {
      method,
      headers: {
        Authorization: auth,
        ...(contentType ? { "Content-Type": contentType } : {}),
      },
      ...(body !== undefined ? { body } : {}),
    });
    const payload = await readJson(response);
    const envelope = asRecord(payload);
    const code = typeof envelope.code === "number" ? envelope.code : response.status;
    const ok = response.ok && (code === 200 || envelope.success === true);
    console.info("[kie]", method, new URL(url).pathname, response.status, code);
    if (!ok) {
      const msg =
        typeof envelope.msg === "string" && envelope.msg
          ? envelope.msg
          : `KIE request failed (${response.status})`;
      throw new KieError(response.status, code, msg);
    }
    return envelope;
  }

  return {
    /** Queues a task. HTTP 200 means created, never finished. */
    async createTask(request: KieRequest & { callBackUrl?: string }): Promise<{ taskId: string }> {
      const envelope = await call(
        "POST",
        `${baseUrl}/api/v1/jobs/createTask`,
        JSON.stringify(request),
        "application/json",
      );
      const taskId = asRecord(envelope.data).taskId;
      if (typeof taskId !== "string" || !taskId) {
        throw new KieError(502, 502, "KIE answered without a taskId");
      }
      return { taskId };
    },

    async recordInfo(taskId: string): Promise<KieRecord> {
      const envelope = await call(
        "GET",
        `${baseUrl}/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`,
      );
      return parseRecord(asRecord(envelope.data), taskId);
    },

    /** Remaining credits on the account the key belongs to. */
    async credits(): Promise<number> {
      const envelope = await call("GET", `${baseUrl}/api/v1/chat/credit`);
      return typeof envelope.data === "number" ? envelope.data : Number(envelope.data);
    },

    /** A 20-minute link for a KIE-generated file whose public URL went stale. */
    async downloadUrl(url: string): Promise<string> {
      const envelope = await call(
        "POST",
        `${baseUrl}/api/v1/common/download-url`,
        JSON.stringify({ url }),
        "application/json",
      );
      if (typeof envelope.data !== "string") throw new KieError(502, 502, "KIE answered without a link");
      return envelope.data;
    },

    /** KIE's own scratch storage: free, public, and gone within about a day. */
    async uploadStream(file: Blob, fileName: string, uploadPath: string): Promise<{ url: string }> {
      const form = new FormData();
      form.append("file", file, fileName);
      form.append("uploadPath", uploadPath);
      form.append("fileName", fileName);
      const envelope = await call("POST", `${uploadBaseUrl}/api/file-stream-upload`, form);
      const data = asRecord(envelope.data);
      const url = data.downloadUrl ?? data.fileUrl;
      if (typeof url !== "string" || !url) throw new KieError(502, 502, "Upload answered without a URL");
      return { url };
    },
  };
}

/** resultJson is a JSON string inside the JSON; failCode/failMsg are "" on
    success in recordInfo and null in callbacks. */
export function parseRecord(data: Record<string, unknown>, fallbackTaskId = ""): KieRecord {
  const result = parseResultJson(data.resultJson);
  const state = stringOf(data.state) as KieState;
  return {
    taskId: stringOf(data.taskId) || stringOf(data.task_id) || fallbackTaskId,
    model: stringOf(data.model),
    state: STATES.has(state) ? state : "waiting",
    resultUrls: urlList(result.resultUrls),
    firstFrameUrls: urlList(result.firstFrameUrl),
    lastFrameUrls: urlList(result.lastFrameUrl),
    failCode: stringOf(data.failCode),
    failMsg: stringOf(data.failMsg),
    ...(typeof data.creditsConsumed === "number" ? { creditsConsumed: data.creditsConsumed } : {}),
    ...(typeof data.costTime === "number" ? { costTime: data.costTime } : {}),
    ...(typeof data.createTime === "number" ? { createTime: data.createTime } : {}),
    ...(typeof data.completeTime === "number" ? { completeTime: data.completeTime } : {}),
  };
}

const STATES = new Set<string>(["waiting", "queuing", "generating", "success", "fail"]);

function parseResultJson(value: unknown): Record<string, unknown> {
  if (typeof value !== "string" || !value) return asRecord(value);
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return {};
  }
}

function urlList(value: unknown): string[] {
  if (typeof value === "string") return value ? [value] : [];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

function stringOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { msg: text.slice(0, 200) };
  }
}
