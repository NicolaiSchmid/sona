import { describe, expect, it } from "vitest";
import {
  accountKindForRoot,
  DEFAULT_ACCOUNTS,
  isValidAccountPath,
  SUSPENSE_ACCOUNTS,
  validateAccountPath,
} from "./accounts";

describe("validateAccountPath", () => {
  it("accepts a normal nested path and infers the kind", () => {
    const result = validateAccountPath("Assets:Bank:DKB:Giro");
    expect(result.valid).toBe(true);
    expect(result.segments).toEqual(["Assets", "Bank", "DKB", "Giro"]);
    expect(result.kind).toBe("asset");
  });

  it("rejects empty segments", () => {
    expect(isValidAccountPath("Assets::Giro")).toBe(false);
    expect(isValidAccountPath(":Assets")).toBe(false);
    expect(isValidAccountPath("Assets:")).toBe(false);
    expect(isValidAccountPath("")).toBe(false);
  });

  it("rejects segments with invalid characters", () => {
    expect(isValidAccountPath("Assets:Bank/DKB")).toBe(false);
    expect(isValidAccountPath("Assets: Bank")).toBe(false); // leading space
  });

  it("rejects segments with leading or trailing whitespace", () => {
    expect(isValidAccountPath("Assets:Bank ")).toBe(false); // trailing space
    expect(isValidAccountPath("Assets:Giro\t")).toBe(false);
  });

  it("allows spaces, underscores and hyphens within a segment", () => {
    expect(isValidAccountPath("Assets:Bank Account_1-eur")).toBe(true);
  });

  it("treats the default suspense accounts as valid", () => {
    expect(isValidAccountPath(SUSPENSE_ACCOUNTS.unclassified)).toBe(true);
    expect(isValidAccountPath(SUSPENSE_ACCOUNTS.needsReceipt)).toBe(true);
    expect(validateAccountPath(SUSPENSE_ACCOUNTS.unclassified).kind).toBe("suspense");
  });

  it("maps known roots to kinds and unknown roots to undefined", () => {
    expect(accountKindForRoot("Expenses")).toBe("expense");
    expect(accountKindForRoot("Income")).toBe("income");
    expect(accountKindForRoot("Mystery")).toBeUndefined();
  });
});

describe("DEFAULT_ACCOUNTS", () => {
  it("are all structurally valid with a kind matching their root", () => {
    for (const account of DEFAULT_ACCOUNTS) {
      const result = validateAccountPath(account.path);
      expect(result.valid, account.path).toBe(true);
      expect(result.kind, account.path).toBe(account.kind);
    }
  });

  it("require receipts for tax-sensitive expense accounts", () => {
    const byPath = new Map(DEFAULT_ACCOUNTS.map((a) => [a.path, a]));
    expect(byPath.get("Expenses:TaxAdvice")?.receiptRequired).toBe(true);
    expect(byPath.get("Expenses:RealEstate:Maintenance")?.receiptRequired).toBe(true);
    // The needs-receipt suspense bucket must itself be receipt-gated.
    expect(byPath.get("Suspense:NeedsReceipt")?.receiptRequired).toBe(true);
    expect(byPath.get("Suspense:Unclassified")?.receiptRequired).toBe(false);
  });
});
