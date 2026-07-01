import { describe, expect, it } from "vitest";
import { forbiddenConceptFor, validateReadOnlyActions } from "./policy.js";

describe("read-only action policy", () => {
  it("allows read-only fetch actions", () => {
    const result = validateReadOnlyActions([
      "navigate",
      "click",
      "search_orders",
      "download_invoice_pdf",
    ]);
    expect(result.valid).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it("rejects mutating actions", () => {
    expect(validateReadOnlyActions(["purchase"]).valid).toBe(false);
    expect(validateReadOnlyActions(["change_payment_method"]).valid).toBe(false);
    expect(validateReadOnlyActions(["cancel_order"]).valid).toBe(false);
  });

  it("rejects alternate-verb payment/address mutations", () => {
    expect(validateReadOnlyActions(["update_payment_method"]).valid).toBe(false);
    expect(validateReadOnlyActions(["add_payment_method"]).valid).toBe(false);
    expect(validateReadOnlyActions(["edit_address"]).valid).toBe(false);
  });

  it("is case-insensitive", () => {
    const result = validateReadOnlyActions(["PURCHASE", "Cancel-Order"]);
    expect(result.valid).toBe(false);
    expect(result.violations).toHaveLength(2);
  });

  it("does not flag benign actions that merely contain a keyword substring", () => {
    // "search_orders" / "order_history" must not trip a bare `order` match.
    expect(forbiddenConceptFor("search_orders")).toBeUndefined();
    expect(forbiddenConceptFor("order_history")).toBeUndefined();
    expect(forbiddenConceptFor("download_invoice_pdf")).toBeUndefined();
  });

  it("flags place_order and change_* phrases", () => {
    expect(forbiddenConceptFor("place_order")).toBeDefined();
    expect(forbiddenConceptFor("change_address_line1")).toBe("change_address");
  });
});
