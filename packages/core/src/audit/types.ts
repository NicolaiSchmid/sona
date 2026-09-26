/**
 * Audit events record high-impact actions — credential changes, approvals,
 * exports, agent executions — so they can be reviewed later. They are
 * append-only: an event is never updated or deleted once written.
 */
import type { JsonValue } from "../util/hash";

export interface AuditEvent {
  id: string;
  workspaceId: string;
  /** Dotted action name, e.g. "ledger.transaction.superseded". */
  action: string;
  /** Who acted: a user id, "agent:<session>", "rule:<id>", or "system". */
  actor: string;
  /** Domain record type the action applies to, e.g. "ledger_transaction". */
  targetType?: string;
  targetId?: string;
  /** Redacted, JSON-shaped summary of the action — never credentials or full payloads. */
  metadata?: JsonValue;
  createdAt: string;
}
