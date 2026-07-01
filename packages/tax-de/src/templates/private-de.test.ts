import { describe, expect, it } from "vitest";
import { PRIVATE_DE_TEMPLATE } from "./private-de.js";

describe("PRIVATE_DE_TEMPLATE", () => {
  it("targets German private individuals", () => {
    expect(PRIVATE_DE_TEMPLATE.jurisdiction).toBe("DE");
    expect(PRIVATE_DE_TEMPLATE.audience).toBe("private_individual");
  });

  it("has stable, unique, non-empty section ids", () => {
    const ids = PRIVATE_DE_TEMPLATE.sections.map((s) => s.id);
    expect(ids.every((id) => id.length > 0)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(PRIVATE_DE_TEMPLATE.uncategorizedSectionId);
  });

  it("does not claim legal deductibility in any section", () => {
    const banned = ["deductible", "deduct", "guaranteed", "tax-free", "tax free", "write-off"];
    for (const section of PRIVATE_DE_TEMPLATE.sections) {
      const text = `${section.title} ${section.description}`.toLowerCase();
      for (const word of banned) {
        expect(text.includes(word), `${section.id} mentions "${word}"`).toBe(false);
      }
    }
  });
});
