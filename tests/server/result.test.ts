import { describe, expect, it, vi } from "vitest";

import { messageOf } from "@/server/result";

/* The words that reach the composer's error line are the server's own; a
   driver's failed statement is logged and replaced. */
describe("messageOf", () => {
  it("speaks the server's own errors", () => {
    expect(messageOf(new Error("An attached file is not in this team"))).toBe("An attached file is not in this team");
    const kie = Object.assign(new Error("KIE error 429"), { name: "KieError" });
    expect(messageOf(kie)).toBe("KIE error 429");
  });

  it("keeps a failed statement's SQL off the line", () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const failed = Object.assign(new Error("Failed query: select * from prompt_templates\nparams: "), {
      query: "select * from prompt_templates",
      params: [],
    });
    expect(messageOf(failed)).toBe("Something went wrong on the server; try again");
    expect(quiet).toHaveBeenCalledOnce();
    quiet.mockRestore();
  });

  it("replaces a library's error and passes a plain string through", () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(messageOf(Object.assign(new Error("boom"), { name: "TypeError" }))).toBe("Something went wrong on the server; try again");
    expect(messageOf("Pick a project first.")).toBe("Pick a project first.");
    quiet.mockRestore();
  });
});
