import { describe, expect, it } from "vitest";

import { MASK, Masker } from "../../worker/mask";

describe("Masker", () => {
  const mask = new Masker({ KIE_API_KEY: "kie-0123456789abcdef", ANTHROPIC_API_KEY: "sk-ant-api03-verysecretvalue", PATH: "/usr/bin", SHORT_KEY: "abc" }, ["extra-secret-value"]);

  it("replaces every known secret value wherever it appears", () => {
    expect(mask.text("curl -H 'Authorization: Bearer kie-0123456789abcdef' https://api.kie.ai")).toBe(`curl -H 'Authorization: Bearer ${MASK}' https://api.kie.ai`);
    expect(mask.text("key=extra-secret-value;again extra-secret-value")).toBe(`key=${MASK};again ${MASK}`);
    expect(mask.text("sk-ant-api03-verysecretvalue")).toBe(MASK);
  });

  it("leaves non-secret env values and short values alone", () => {
    expect(mask.text("PATH is /usr/bin and abc stays")).toBe("PATH is /usr/bin and abc stays");
  });

  it("catches tokens by shape it was never told about", () => {
    expect(mask.text("export OPENAI=sk-proj-abcdefghijklmnop")).toBe(`export OPENAI=${MASK}`);
    expect(mask.text("token hf_AbCdEfGhIjKlMnOp here")).toBe(`token ${MASK} here`);
    expect(mask.text("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig")).toBe(`Authorization: Bearer ${MASK}`);
    expect(mask.text("ELEVENLABS_API_KEY=abcdef123456\nHF_KEY='zzzzzz9999'\nMODE=fast")).toBe(`ELEVENLABS_API_KEY=${MASK}\nHF_KEY=${MASK}\nMODE=fast`);
  });

  it("walks objects, masking strings and blanking secret-named keys", () => {
    const out = mask.value({
      command: "python3 run.py --key kie-0123456789abcdef",
      nested: ["ok", "sk-live-abcdefghijk"],
      api_key: "whatever-this-is",
      count: 3,
      flag: true,
    });
    expect(out).toEqual({
      command: `python3 run.py --key ${MASK}`,
      nested: ["ok", MASK],
      api_key: MASK,
      count: 3,
      flag: true,
    });
  });

  it("replaces the longer of two overlapping secrets whole", () => {
    const nested = new Masker({ A_KEY: "abcdefgh", B_KEY: "abcdefgh-ijklmnop" });
    expect(nested.text("x abcdefgh-ijklmnop y")).toBe(`x ${MASK} y`);
  });
});
