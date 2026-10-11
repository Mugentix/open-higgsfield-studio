import {
  DeleteObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Readable } from "node:stream";

import type { MediaStore, PresignedPut } from "./index";

const IMMUTABLE = "public, max-age=31536000, immutable";
const PRESIGN_SECONDS = 15 * 60;

export class R2Store implements MediaStore {
  readonly kind = "r2" as const;
  readonly public = true;
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly publicBaseUrl: string;

  constructor(options: {
    accountId: string;
    accessKeyId: string;
    secretAccessKey: string;
    bucket: string;
    publicBaseUrl: string;
  }) {
    this.client = new S3Client({
      region: "auto",
      endpoint: `https://${options.accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey },
    });
    this.bucket = options.bucket;
    this.publicBaseUrl = options.publicBaseUrl.replace(/\/$/, "");
  }

  async put(key: string, body: ReadableStream<Uint8Array> | Uint8Array, contentType: string) {
    let bytes = 0;
    const counted =
      body instanceof Uint8Array
        ? ((bytes = body.byteLength), body)
        : Readable.fromWeb(
            body.pipeThrough(
              new TransformStream<Uint8Array, Uint8Array>({
                transform(chunk, controller) {
                  bytes += chunk.byteLength;
                  controller.enqueue(chunk);
                },
              }),
            ) as import("node:stream/web").ReadableStream<Uint8Array>,
          );
    /* Multipart handles bodies of unknown length; KIE does not always say. */
    const upload = new Upload({
      client: this.client,
      params: { Bucket: this.bucket, Key: key, Body: counted, ContentType: contentType, CacheControl: IMMUTABLE },
      partSize: 8 * 1024 * 1024,
      queueSize: 4,
    });
    await upload.done();
    return { bytes };
  }

  async presignPut(key: string, contentType: string, contentLength: number): Promise<PresignedPut> {
    const url = await getSignedUrl(
      this.client,
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: contentType,
        ContentLength: contentLength,
        CacheControl: IMMUTABLE,
      }),
      /* The type is part of what is signed, so the object cannot be stored as
         something else and served as such from the media domain. */
      { expiresIn: PRESIGN_SECONDS, signableHeaders: new Set(["content-type"]) },
    );
    return {
      url,
      headers: { "Content-Type": contentType, "Cache-Control": IMMUTABLE },
      expiresAt: Date.now() + PRESIGN_SECONDS * 1000,
    };
  }

  async head(key: string) {
    try {
      const out = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { bytes: out.ContentLength ?? 0, contentType: out.ContentType ?? "application/octet-stream" };
    } catch {
      return null;
    }
  }

  async remove(key: string) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  publicUrl(key: string): string {
    return `${this.publicBaseUrl}/${key}`;
  }
}
