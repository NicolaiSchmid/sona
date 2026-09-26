/**
 * SQLite-backed accountant share links. Every state change (creation,
 * download, denial, revocation) lands together with an append-only audit
 * event in one transaction, so the access history of a shared package can
 * always be reconstructed. The bearer token is never stored — only its hash.
 */
import type { AuditEvent, JsonValue } from "@sona/core";
import {
  type AccountantShareLink,
  evaluateShareLinkAccess,
  hashShareToken,
  SHARE_LINK_AUDIT_ACTIONS,
  type ShareLinkDenialReason,
} from "@sona/tax-de";
import type { DbClient } from "../runner.js";
import { SqliteAuditEventRepository } from "./audit-events.js";
import {
  optionalString,
  type Row,
  requiredNumber,
  requiredString,
  row,
  rows,
  withTransactionAsync,
} from "./helpers.js";

/** Who performs the action and which audit event id to record it under. */
export interface ShareLinkActor {
  /** A user id, "agent:<session>", or for anonymous downloads "share_link:<id>". */
  actor: string;
  eventId: string;
}

export interface ShareLinkDownloadRequest extends ShareLinkActor {
  /** Plaintext token presented by the recipient. */
  token: string;
  /** ISO-8601 time of the request. */
  now: string;
}

export type ShareLinkDownloadResult =
  | { allowed: true; link: AccountantShareLink }
  | { allowed: false; reason: ShareLinkDenialReason | "unknown_link" };

const LINK_SELECT =
  "SELECT id, workspace_id, package_document_id, package_sha256, tax_year, token_hash, created_by, created_at, expires_at, max_downloads, download_count, revoked_at FROM accountant_share_links";

export class SqliteAccountantShareLinkRepository {
  readonly #db: DbClient;
  readonly #audit: SqliteAuditEventRepository;

  constructor(db: DbClient) {
    this.#db = db;
    this.#audit = new SqliteAuditEventRepository(db);
  }

  async create(link: AccountantShareLink, by: ShareLinkActor): Promise<void> {
    if (link.downloadCount !== 0 || link.revokedAt !== undefined) {
      throw new Error("a new share link must start unused and unrevoked");
    }
    await withTransactionAsync(this.#db, async () => {
      this.#db
        .prepare(
          "INSERT INTO accountant_share_links (id, workspace_id, package_document_id, package_sha256, tax_year, token_hash, created_by, created_at, expires_at, max_downloads, download_count, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL)",
        )
        .run(
          link.id,
          link.workspaceId,
          link.packageDocumentId,
          link.packageSha256,
          link.taxYear,
          link.tokenHash,
          link.createdBy,
          link.createdAt,
          link.expiresAt,
          link.maxDownloads,
        );
      await this.#audit.append(
        auditEvent(link, by, SHARE_LINK_AUDIT_ACTIONS.created, link.createdAt, {
          taxYear: link.taxYear,
          packageSha256: link.packageSha256,
          expiresAt: link.expiresAt,
          maxDownloads: link.maxDownloads,
        }),
      );
    });
  }

  async getById(workspaceId: string, id: string): Promise<AccountantShareLink | undefined> {
    const result = row(
      this.#db.prepare(`${LINK_SELECT} WHERE workspace_id = ? AND id = ?`).get(workspaceId, id),
    );
    return result === undefined ? undefined : linkFromRow(result);
  }

  async list(workspaceId: string): Promise<AccountantShareLink[]> {
    return rows(
      this.#db
        .prepare(`${LINK_SELECT} WHERE workspace_id = ? ORDER BY created_at, id`)
        .all(workspaceId),
    ).map(linkFromRow);
  }

  /**
   * Decides whether a presented token may download right now and, if so,
   * consumes one download. Evaluation and the counter increment happen in one
   * transaction, so concurrent requests cannot exceed the cap. Every decision
   * on a known link is audited; an unknown token has no workspace to audit
   * against and is simply refused.
   */
  async authorizeDownload(request: ShareLinkDownloadRequest): Promise<ShareLinkDownloadResult> {
    return withTransactionAsync(this.#db, async () => {
      const result = row(
        this.#db.prepare(`${LINK_SELECT} WHERE token_hash = ?`).get(hashShareToken(request.token)),
      );
      if (result === undefined) {
        return { allowed: false, reason: "unknown_link" };
      }
      const link = linkFromRow(result);
      const access = evaluateShareLinkAccess(link, { token: request.token, now: request.now });
      if (!access.allowed) {
        await this.#audit.append(
          auditEvent(link, request, SHARE_LINK_AUDIT_ACTIONS.denied, request.now, {
            reason: access.reason,
          }),
        );
        return access;
      }
      const updated: AccountantShareLink = { ...link, downloadCount: link.downloadCount + 1 };
      this.#db
        .prepare(
          "UPDATE accountant_share_links SET download_count = ? WHERE workspace_id = ? AND id = ? AND download_count = ?",
        )
        .run(updated.downloadCount, link.workspaceId, link.id, link.downloadCount);
      await this.#audit.append(
        auditEvent(link, request, SHARE_LINK_AUDIT_ACTIONS.downloaded, request.now, {
          downloadCount: updated.downloadCount,
          maxDownloads: link.maxDownloads,
        }),
      );
      return { allowed: true, link: updated };
    });
  }

  /** Revokes the link; a second revocation is a no-op and is not audited again. */
  async revoke(
    workspaceId: string,
    id: string,
    by: ShareLinkActor & { now: string },
  ): Promise<AccountantShareLink> {
    return withTransactionAsync(this.#db, async () => {
      const link = await this.getById(workspaceId, id);
      if (link === undefined) {
        throw new Error("share link not found in workspace");
      }
      if (link.revokedAt !== undefined) {
        return link;
      }
      this.#db
        .prepare(
          "UPDATE accountant_share_links SET revoked_at = ? WHERE workspace_id = ? AND id = ? AND revoked_at IS NULL",
        )
        .run(by.now, workspaceId, id);
      await this.#audit.append(
        auditEvent(link, by, SHARE_LINK_AUDIT_ACTIONS.revoked, by.now, undefined),
      );
      return { ...link, revokedAt: by.now };
    });
  }
}

function auditEvent(
  link: AccountantShareLink,
  by: ShareLinkActor,
  action: string,
  createdAt: string,
  metadata: JsonValue | undefined,
): AuditEvent {
  return {
    id: by.eventId,
    workspaceId: link.workspaceId,
    action,
    actor: by.actor,
    targetType: "accountant_share_link",
    targetId: link.id,
    ...(metadata === undefined ? {} : { metadata }),
    createdAt,
  };
}

function linkFromRow(source: Row): AccountantShareLink {
  return {
    id: requiredString(source, "id"),
    workspaceId: requiredString(source, "workspace_id"),
    packageDocumentId: requiredString(source, "package_document_id"),
    packageSha256: requiredString(source, "package_sha256"),
    taxYear: requiredNumber(source, "tax_year"),
    tokenHash: requiredString(source, "token_hash"),
    createdBy: requiredString(source, "created_by"),
    createdAt: requiredString(source, "created_at"),
    expiresAt: requiredString(source, "expires_at"),
    maxDownloads: requiredNumber(source, "max_downloads"),
    downloadCount: requiredNumber(source, "download_count"),
    revokedAt: optionalString(source, "revoked_at"),
  };
}
