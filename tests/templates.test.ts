import { describe, expect, it } from "vitest";

import {
  RESERVED_VARIABLES,
  STARTER_TEMPLATES,
  TEMPLATE_LIMITS,
  TEMPLATE_SURFACES,
  fillTemplate,
  insertIntoPrompt,
  isReservedVariable,
  isTemplateSurface,
  matchesTemplate,
  oneLine,
  parseTags,
  reservedValues,
  variableLabel,
  variablesOf,
} from "@/openhiggsfield/templates";

/* The composer fills a template in two steps — the product's reserved names
   first, then whatever is left through the fill form — and both steps, plus
   the starter pack, lean on these helpers. */

describe("variablesOf", () => {
  it("lists each variable once, in the order it first appears", () => {
    expect(variablesOf("{{product}} shot of {{product}} with {{feature}} for {{offer_url}}")).toEqual([
      "product",
      "feature",
      "offer_url",
    ]);
  });

  it("tolerates spaces inside the braces and ignores what is not a name", () => {
    expect(variablesOf("{{ product }} and {{ 2fast }} and {{}} and {{a-b}} and { single }")).toEqual(["product"]);
  });

  it("is empty for a body without variables", () => {
    expect(variablesOf("a plain prompt")).toEqual([]);
    expect(variablesOf("")).toEqual([]);
  });
});

describe("fillTemplate", () => {
  it("writes every known value in and leaves an unknown one exactly as typed", () => {
    const body = "{{product}} on {{ surface_kind }}, see {{offer_url}}";
    expect(fillTemplate(body, { product: "Acme Serum", offer_url: "https://acme.test/go" })).toBe(
      "Acme Serum on {{ surface_kind }}, see https://acme.test/go",
    );
  });

  it("treats null and undefined as no value, and an empty string as one", () => {
    expect(fillTemplate("{{a}}|{{b}}|{{c}}", { a: null, b: undefined, c: "" })).toBe("{{a}}|{{b}}|");
  });

  it("fills a repeated variable everywhere", () => {
    expect(fillTemplate("{{p}} and {{p}}", { p: "X" })).toBe("X and X");
  });
});

describe("reservedValues", () => {
  it("answers only the reserved names the product has a value for", () => {
    expect(reservedValues({ name: " Acme ", offerUrl: null, brandNotes: "  " })).toEqual({ product: "Acme" });
    expect(reservedValues({ name: "Acme", offerUrl: "https://a.test", brandNotes: "Warm, never clinical" })).toEqual({
      product: "Acme",
      offer_url: "https://a.test",
      brand_notes: "Warm, never clinical",
    });
  });

  it("is empty without a product", () => {
    expect(reservedValues(null)).toEqual({});
    expect(reservedValues(undefined)).toEqual({});
  });

  it("names exactly the three reserved variables", () => {
    expect(RESERVED_VARIABLES).toEqual(["product", "offer_url", "brand_notes"]);
    expect(isReservedVariable("offer_url")).toBe(true);
    expect(isReservedVariable("feature")).toBe(false);
  });
});

describe("insertIntoPrompt", () => {
  it("replaces the prompt unless asked to append", () => {
    expect(insertIntoPrompt("old words", "new body", false)).toBe("new body");
  });

  it("appends after a blank line, trimming the tail of what was there", () => {
    expect(insertIntoPrompt("old words  \n", "new body", true)).toBe("old words\n\nnew body");
  });

  it("appending to nothing is just the body", () => {
    expect(insertIntoPrompt("", "new body", true)).toBe("new body");
    expect(insertIntoPrompt("   \n", "new body", true)).toBe("new body");
  });
});

describe("oneLine, variableLabel, parseTags", () => {
  it("folds line breaks and runs of spaces into one space", () => {
    expect(oneLine("  a\n\n  b   c\t d ")).toBe("a b c d");
  });

  it("reads a variable name as a label", () => {
    expect(variableLabel("offer_url")).toBe("Offer url");
    expect(variableLabel("brand__notes")).toBe("Brand notes");
    expect(variableLabel("feature")).toBe("Feature");
  });

  it("splits tags on commas, lower-cases, and drops empties and repeats", () => {
    expect(parseTags(" UGC, hook ,, ugc, Hook, before-after ")).toEqual(["ugc", "hook", "before-after"]);
    expect(parseTags("")).toEqual([]);
  });
});

describe("matchesTemplate", () => {
  const template = { title: "Us vs them split", body: "Left: the old way. Right: {{product}}.", tags: ["comparison"] };

  it("matches on title, body or tag, whatever the case", () => {
    expect(matchesTemplate(template, "SPLIT")).toBe(true);
    expect(matchesTemplate(template, "old way")).toBe(true);
    expect(matchesTemplate(template, "compar")).toBe(true);
    expect(matchesTemplate(template, "unboxing")).toBe(false);
  });

  it("matches everything on an empty or blank query", () => {
    expect(matchesTemplate(template, "")).toBe(true);
    expect(matchesTemplate(template, "   ")).toBe(true);
  });
});

describe("surfaces", () => {
  it("knows image, video and any, and nothing else", () => {
    expect(TEMPLATE_SURFACES).toEqual(["image", "video", "any"]);
    expect(isTemplateSurface("any")).toBe(true);
    expect(isTemplateSurface("audio")).toBe(false);
    expect(isTemplateSurface(undefined)).toBe(false);
  });
});

describe("STARTER_TEMPLATES", () => {
  it("is about a dozen shapes with distinct titles, each fitting a surface", () => {
    expect(STARTER_TEMPLATES.length).toBeGreaterThanOrEqual(11);
    expect(STARTER_TEMPLATES.length).toBeLessThanOrEqual(14);
    expect(new Set(STARTER_TEMPLATES.map((s) => s.title)).size).toBe(STARTER_TEMPLATES.length);
    for (const starter of STARTER_TEMPLATES) expect(isTemplateSurface(starter.surface)).toBe(true);
  });

  it("keeps every body short, within the server's limits, with lower-case tags", () => {
    for (const starter of STARTER_TEMPLATES) {
      expect(starter.title.length).toBeLessThanOrEqual(TEMPLATE_LIMITS.title);
      expect(starter.body.length).toBeGreaterThan(20);
      expect(starter.body.length).toBeLessThanOrEqual(400);
      expect(starter.tags.length).toBeLessThanOrEqual(TEMPLATE_LIMITS.tags);
      for (const tag of starter.tags) {
        expect(tag).toBe(tag.toLowerCase());
        expect(tag.length).toBeLessThanOrEqual(TEMPLATE_LIMITS.tag);
      }
    }
  });

  it("leans on the product and asks for at most two details of its own", () => {
    for (const starter of STARTER_TEMPLATES) {
      const names = variablesOf(starter.body);
      const own = names.filter((name) => !isReservedVariable(name));
      expect(own.length).toBeLessThanOrEqual(2);
      for (const name of names) expect(name).toMatch(/^[a-z_]+$/);
    }
    /* Every reserved name is exercised somewhere, so the product brief is
       worth filling in. */
    const used = new Set(STARTER_TEMPLATES.flatMap((s) => variablesOf(s.body)));
    for (const name of RESERVED_VARIABLES) expect(used.has(name)).toBe(true);
  });

  it("fills with a product brief and leaves only the shape's own questions", () => {
    const brief = { name: "Acme Serum", offerUrl: "https://acme.test/go", brandNotes: "Warm, direct" };
    const values = reservedValues(brief);
    for (const starter of STARTER_TEMPLATES) {
      const filled = fillTemplate(starter.body, values);
      expect(variablesOf(filled).every((name) => !isReservedVariable(name))).toBe(true);
      expect(filled).not.toContain("{{product}}");
    }
  });
});
