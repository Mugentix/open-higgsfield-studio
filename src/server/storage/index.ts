import { LocalStore } from "./local";
import { R2Store } from "./r2";

export type PresignedPut = {
  url: string;
  headers: Record<string, string>;
  expiresAt: number;
};

export type MediaStore = {
  readonly kind: "r2" | "local";
  /** Objects are reachable by anyone with the url; KIE can fetch them as inputs. */
  readonly public: boolean;
  put(key: string, body: ReadableStream<Uint8Array> | Uint8Array, contentType: string): Promise<{ bytes: number }>;
  presignPut(key: string, contentType: string, contentLength: number): Promise<PresignedPut>;
  head(key: string): Promise<{ bytes: number; contentType: string } | null>;
  remove(key: string): Promise<void>;
  publicUrl(key: string): string;
  /** The object's SHA-256 (hex) where the store can read it back cheaply;
      null where it cannot (a bucket), in which case the browser's word stands. */
  sha256?(key: string): Promise<string | null>;
};

declare global {
  // eslint-disable-next-line no-var
  var __ohfStore: MediaStore | undefined;
}

/** Cloudflare R2 when the deployment has credentials, otherwise the local
    filesystem under .data/media, served by the app itself. */
export function mediaStore(): MediaStore {
  return (globalThis.__ohfStore ??= open());
}

function open(): MediaStore {
  const accountId = process.env.R2_ACCOUNT_ID?.trim();
  const accessKeyId = process.env.R2_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY?.trim();
  const bucket = process.env.R2_BUCKET?.trim() || process.env.R2_BUCKET_NAME?.trim();
  const publicBaseUrl = process.env.R2_PUBLIC_BASE_URL?.trim();
  if (accountId && accessKeyId && secretAccessKey && bucket && publicBaseUrl) {
    return new R2Store({ accountId, accessKeyId, secretAccessKey, bucket, publicBaseUrl });
  }
  if (process.env.NODE_ENV === "production" && process.env.ALLOW_LOCAL_MEDIA_STORE !== "1") {
    throw new Error("R2 is not configured (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, R2_PUBLIC_BASE_URL)");
  }
  return new LocalStore();
}

export { extensionFor, frameKey, isSafeKey, mimeForKey, resultKey, uploadKey } from "./keys";
