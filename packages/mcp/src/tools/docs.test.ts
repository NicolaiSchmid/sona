import { describe, expect, it } from "vitest";
import { getDocs } from "./docs";

describe("getDocs", () => {
  it("states the product boundary and lists families", () => {
    const docs = getDocs();
    expect(docs.productBoundary.toLowerCase()).toContain("personal tax backoffice");
    expect(docs.families).toContain("tax");
    expect(docs.text).toContain("sona.tax.*");
  });

  it("includes the key safety rules", () => {
    const docs = getDocs();
    const joined = docs.safetyRules.join(" ").toLowerCase();
    expect(joined).toContain("no automatic elster submission");
    expect(joined).toContain("no payment initiation");
  });
});
