import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/* Secrets at rest (the team's KIE key) are sealed with AES-256-GCM under
   APP_SECRET_KEY. Any string works as the setting; it is hashed to 32 bytes.
   A local checkout without one gets a fixed development key and a warning,
   so nothing sealed there is portable. */

const DEV_KEY = "openhiggsfield-dev-only-not-a-secret";

function keyBytes(): Buffer {
  const raw = process.env.APP_SECRET_KEY?.trim();
  if (!raw) {
    if (process.env.NODE_ENV === "production") throw new Error("APP_SECRET_KEY is not set");
    return createHash("sha256").update(DEV_KEY).digest();
  }
  return createHash("sha256").update(raw).digest();
}

/** base64(iv) . base64(ciphertext) . base64(tag) */
export function seal(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyBytes(), iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [iv, body, cipher.getAuthTag()].map((part) => part.toString("base64")).join(".");
}

export function unseal(sealed: string): string {
  const [iv, body, tag] = sealed.split(".").map((part) => Buffer.from(part, "base64"));
  if (!iv || !body || !tag) throw new Error("Malformed sealed value");
  const decipher = createDecipheriv("aes-256-gcm", keyBytes(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
}

export function last4(value: string): string {
  return value.slice(-4);
}
