/**
 * Ledger account paths and the default private-tax-oriented account tree.
 *
 * ## Account path policy
 *
 * Account paths are colon-separated segments, e.g. `Assets:Bank:DKB:Giro`.
 *
 * - At least one segment is required.
 * - No empty segments (so no leading/trailing colon and no `::`).
 * - Each segment matches `^[A-Za-z0-9][A-Za-z0-9 _-]*$`: it starts with an
 *   alphanumeric and may then contain alphanumerics, spaces, underscores, or
 *   hyphens. No leading/trailing whitespace.
 * - PascalCase roots are conventional but not enforced beyond the charset.
 * - The first segment ("root") SHOULD map to an {@link AccountKind} via
 *   {@link accountKindForRoot}; unknown roots validate structurally but have no
 *   inferred kind.
 */
import type { AccountKind } from "./types";

const SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9 _-]*$/;

/** Maps a conventional root segment to an account kind. */
const ROOT_KINDS = {
  Assets: "asset",
  Liabilities: "liability",
  Equity: "equity",
  Income: "income",
  Expenses: "expense",
  Suspense: "suspense",
} as const satisfies Record<string, AccountKind>;

export type AccountRoot = keyof typeof ROOT_KINDS;

export function accountKindForRoot(root: string): AccountKind | undefined {
  return (ROOT_KINDS as Record<string, AccountKind>)[root];
}

export interface AccountPathValidation {
  valid: boolean;
  segments: string[];
  /** Inferred kind from the root segment, if recognized. */
  kind: AccountKind | undefined;
  errors: string[];
}

/** Validates an account path against the policy documented above. */
export function validateAccountPath(path: string): AccountPathValidation {
  const errors: string[] = [];
  const segments = path.split(":");

  if (path.length === 0 || segments.length === 0) {
    errors.push("Account path must have at least one segment");
  }

  for (const [index, segment] of segments.entries()) {
    if (segment.length === 0) {
      errors.push(`Empty segment at position ${index} in "${path}"`);
    } else if (segment.trim() !== segment || !SEGMENT_RE.test(segment)) {
      errors.push(`Invalid segment "${segment}" at position ${index} in "${path}"`);
    }
  }

  const root = segments[0];
  const kind = root !== undefined ? accountKindForRoot(root) : undefined;

  return { valid: errors.length === 0, segments, kind, errors };
}

/** Returns true if the path is structurally valid. */
export function isValidAccountPath(path: string): boolean {
  return validateAccountPath(path).valid;
}

export interface DefaultAccount {
  path: string;
  kind: AccountKind;
  /** Whether postings to this account require substantiating evidence by default. */
  receiptRequired: boolean;
}

/**
 * Default private-tax-oriented account tree (from `docs/data-model.md`).
 * These are sensible defaults, not hardcoded personal finances — workspaces
 * may extend or override them.
 */
export const DEFAULT_ACCOUNTS = [
  { path: "Assets:Bank", kind: "asset", receiptRequired: false },
  { path: "Assets:Broker", kind: "asset", receiptRequired: false },
  { path: "Assets:RealEstate", kind: "asset", receiptRequired: false },
  { path: "Liabilities:Mortgage", kind: "liability", receiptRequired: false },
  { path: "Income:Salary", kind: "income", receiptRequired: false },
  { path: "Income:Interest", kind: "income", receiptRequired: false },
  { path: "Income:Dividends", kind: "income", receiptRequired: false },
  { path: "Income:Rental", kind: "income", receiptRequired: false },
  { path: "Expenses:RealEstate:Interest", kind: "expense", receiptRequired: true },
  { path: "Expenses:RealEstate:Maintenance", kind: "expense", receiptRequired: true },
  { path: "Expenses:RealEstate:Depreciation", kind: "expense", receiptRequired: true },
  { path: "Expenses:Insurance", kind: "expense", receiptRequired: false },
  { path: "Expenses:TaxAdvice", kind: "expense", receiptRequired: true },
  { path: "Expenses:WorkRelated", kind: "expense", receiptRequired: false },
  { path: "Expenses:Donations", kind: "expense", receiptRequired: true },
  { path: "Suspense:Unclassified", kind: "suspense", receiptRequired: false },
  // Postings parked here are explicitly waiting on evidence, so gate them.
  { path: "Suspense:NeedsReceipt", kind: "suspense", receiptRequired: true },
  { path: "Equity:OpeningBalances", kind: "equity", receiptRequired: false },
] as const satisfies readonly DefaultAccount[];

/** Default suspense accounts used when a counter-account is unknown. */
export const SUSPENSE_ACCOUNTS = {
  unclassified: "Suspense:Unclassified",
  needsReceipt: "Suspense:NeedsReceipt",
} as const;
