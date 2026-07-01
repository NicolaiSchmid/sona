/**
 * Read-only action policy for portal automation task DEFINITIONS.
 *
 * This is a definition-time guard that rejects tasks whose declared actions
 * imply mutation (buying, cancelling, changing payment/profile, transferring,
 * etc.). It does NOT replace execution-time safeguards — the runner and the
 * browser layer must independently refuse forbidden actions — but it catches
 * unsafe task definitions early.
 */

/** Single-word action verbs that always imply a state-changing operation. */
const FORBIDDEN_TOKENS = new Set([
  "purchase",
  "buy",
  "checkout",
  "cancel",
  "refund",
  "transfer",
  "pay",
  "delete",
  "remove",
  "subscribe",
  "unsubscribe",
  "update",
  "edit",
  "modify",
  "add",
  "create",
  "submit",
  "send",
  "place",
  "initiate",
  "reset",
  "post",
  "upload",
  "confirm",
]);

/**
 * Multi-word forbidden concepts matched against the normalized action. Kept as
 * phrases so benign actions like `search_orders` are not tripped by a bare
 * `order` token. Covers payment/address/password/profile changes under any verb
 * (e.g. `update_payment_method`, `add_payment_method`, `edit_address`).
 */
const FORBIDDEN_PHRASES = [
  "place_order",
  "payment_method",
  "change_payment",
  "change_address",
  "change_password",
  "update_profile",
  "initiate_payment",
  "submit_tax",
  "send_message",
] as const;

function normalize(action: string): string {
  return action
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** Returns the forbidden concept an action violates, or `undefined` if safe. */
export function forbiddenConceptFor(action: string): string | undefined {
  const normalized = normalize(action);
  const tokens = normalized.split("_");
  for (const token of tokens) {
    if (FORBIDDEN_TOKENS.has(token)) {
      return token;
    }
  }
  return FORBIDDEN_PHRASES.find((phrase) => normalized.includes(phrase));
}

export interface PolicyViolation {
  action: string;
  concept: string;
}

export interface ReadOnlyPolicyResult {
  valid: boolean;
  violations: PolicyViolation[];
}

/** Validates that none of the provided actions imply a mutation. */
export function validateReadOnlyActions(actions: readonly string[]): ReadOnlyPolicyResult {
  const violations: PolicyViolation[] = [];
  for (const action of actions) {
    const concept = forbiddenConceptFor(action);
    if (concept !== undefined) {
      violations.push({ action, concept });
    }
  }
  return { valid: violations.length === 0, violations };
}
