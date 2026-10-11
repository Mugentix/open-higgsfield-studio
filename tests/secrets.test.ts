import { describe, expect, it } from "vitest";

import { last4, seal, unseal } from "@/server/secrets";

describe("sealed secrets", () => {
  it("round-trips and never repeats a ciphertext", () => {
    const a = seal("kie-key-1234567890abcdef");
    const b = seal("kie-key-1234567890abcdef");
    expect(a).not.toBe(b);
    expect(unseal(a)).toBe("kie-key-1234567890abcdef");
    expect(unseal(b)).toBe("kie-key-1234567890abcdef");
    expect(a).not.toContain("kie-key");
  });

  it("rejects a tampered value", () => {
    const sealed = seal("secret");
    const [iv, body, tag] = sealed.split(".");
    const flipped = Buffer.from(body!, "base64");
    flipped[0] = (flipped[0]! + 1) & 0xff;
    expect(() => unseal(`${iv}.${flipped.toString("base64")}.${tag}`)).toThrow();
  });

  it("shows only the tail", () => {
    expect(last4("abcdef123456")).toBe("3456");
  });
});
