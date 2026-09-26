/**
 * Pure helpers: sender allowlists, attachment selection, message identity, and
 * the redacted raw-record payload. No I/O, so every rule is unit-testable
 * against synthetic messages.
 */
import { type JsonValue, stableJsonHash } from "@sona/core";
import { toJsonValue } from "../shared.js";
import type {
  AttachmentSelection,
  EmailAddress,
  EmailAttachmentPart,
  EmailMessageSummary,
  EmailSourcePolicy,
  RawEmailAttachment,
  RawEmailMessagePayload,
} from "./types.js";

export const DEFAULT_ALLOWED_MIME_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/heic",
  "image/tiff",
  "image/webp",
] as const satisfies readonly string[];

export const DEFAULT_MIN_IMAGE_BYTES = 32 * 1024;
export const DEFAULT_MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const DEFAULT_FOLDER = "INBOX";

/**
 * Version of the code-level ingestion rules (attachment selection, byte
 * signatures, BODYSTRUCTURE walk). Part of the policy fingerprint so a rule
 * fix triggers a rescan of mail those rules skipped. Bump when such a rule
 * changes behaviour.
 */
export const EMAIL_INGESTION_RULES_VERSION = 1;

export interface ResolvedEmailSourcePolicy {
  folder: string;
  allowedSenders: readonly string[];
  allowedMimeTypes: ReadonlySet<string>;
  minImageBytes: number;
  maxAttachmentBytes: number;
  initialSinceDate: string | undefined;
}

export function resolveEmailSourcePolicy(
  policy: EmailSourcePolicy = {},
): ResolvedEmailSourcePolicy {
  if (policy.initialSinceDate !== undefined && !isIsoDate(policy.initialSinceDate)) {
    // IMAP libraries silently drop an unparseable SINCE, which would widen the
    // first scan to the whole mailbox.
    throw new Error("initialSinceDate must be an ISO-8601 date");
  }
  return {
    folder: policy.folder ?? DEFAULT_FOLDER,
    allowedSenders: (policy.allowedSenders ?? [])
      .map(normalizeAllowlistEntry)
      .filter((entry) => entry.length > 0),
    allowedMimeTypes: new Set(
      (policy.allowedMimeTypes ?? DEFAULT_ALLOWED_MIME_TYPES).map((type) => type.toLowerCase()),
    ),
    minImageBytes: policy.minImageBytes ?? DEFAULT_MIN_IMAGE_BYTES,
    maxAttachmentBytes: policy.maxAttachmentBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES,
    initialSinceDate: policy.initialSinceDate,
  };
}

/**
 * Stable hash of the policy fields that decide whether a message is ingested.
 * Stored with the UID cursor so that widening an allowlist or enabling another
 * document type triggers a rescan instead of silently skipping older mail.
 * The folder (part of the cursor key) and `initialSinceDate` (first scan only)
 * are excluded.
 */
export function policyFingerprint(policy: ResolvedEmailSourcePolicy): string {
  return stableJsonHash({
    rulesVersion: EMAIL_INGESTION_RULES_VERSION,
    allowedSenders: [...policy.allowedSenders].sort(),
    allowedMimeTypes: [...policy.allowedMimeTypes].sort(),
    minImageBytes: policy.minImageBytes,
    maxAttachmentBytes: policy.maxAttachmentBytes,
  });
}

/** `YYYY-MM-DD` with an optional ISO-8601 time part; `Date.parse` alone accepts too much. */
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/;

function isIsoDate(value: string): boolean {
  if (!ISO_DATE_PATTERN.test(value) || Number.isNaN(Date.parse(value))) {
    return false;
  }
  // `Date` rolls impossible calendar dates over (2026-02-30 → March 2). The
  // calendar part is checked on its own so a time zone offset in a timestamp
  // form cannot mask or fake the shift.
  const calendarDate = value.slice(0, 10);
  return new Date(calendarDate).toISOString().startsWith(calendarDate);
}

function normalizeAllowlistEntry(entry: string): string {
  return entry.trim().toLowerCase();
}

/**
 * Sender allowlist check. Accepts raw, un-normalised entries (so it can be
 * called directly) as well as the resolved policy list. Entries are exact
 * addresses or domains; a domain entry also matches its sub-domains. An empty
 * allowlist accepts every sender; a message without a parseable sender is
 * never accepted by a non-empty list.
 */
export function isSenderAllowed(
  from: EmailAddress | undefined,
  allowedSenders: readonly string[],
): boolean {
  if (allowedSenders.length === 0) {
    return true;
  }
  if (from === undefined) {
    return false;
  }
  const address = from.address.toLowerCase();
  const domain = address.slice(address.lastIndexOf("@") + 1);
  return allowedSenders.some((entry) => {
    const normalized = normalizeAllowlistEntry(entry);
    if (normalized.length === 0) {
      return false;
    }
    if (normalized.startsWith("@")) {
      return domainMatches(domain, normalized.slice(1));
    }
    if (normalized.includes("@")) {
      return address === normalized;
    }
    return domainMatches(domain, normalized);
  });
}

function domainMatches(domain: string, allowed: string): boolean {
  return domain === allowed || domain.endsWith(`.${allowed}`);
}

/** Applies the MIME/size/embedding rules to a message's candidate parts. */
export function selectAttachments(
  parts: readonly EmailAttachmentPart[],
  policy: ResolvedEmailSourcePolicy,
): AttachmentSelection {
  const selection: AttachmentSelection = { selected: [], skipped: [] };
  for (const part of parts) {
    const mimeType = part.mimeType.toLowerCase();
    if (!policy.allowedMimeTypes.has(mimeType)) {
      selection.skipped.push({ partId: part.partId, reason: "mime_type_not_allowed" });
      continue;
    }
    if (part.size !== undefined && part.size > policy.maxAttachmentBytes) {
      selection.skipped.push({ partId: part.partId, reason: "above_size_limit" });
      continue;
    }
    if (mimeType.startsWith("image/")) {
      // Images referenced from an HTML body (Content-ID + inline) are signatures,
      // logos, or trackers, not receipts.
      if (part.disposition === "inline" && part.contentId !== undefined) {
        selection.skipped.push({ partId: part.partId, reason: "embedded_image" });
        continue;
      }
      if (part.size !== undefined && part.size < policy.minImageBytes) {
        selection.skipped.push({ partId: part.partId, reason: "below_size_threshold" });
        continue;
      }
    }
    selection.selected.push(part);
  }
  return selection;
}

/**
 * Stable identity for message-id dedup. Prefers the RFC 5322 `Message-ID`,
 * which survives the same mail appearing in several folders (e.g. Gmail's
 * "All Mail"); falls back to the folder-scoped UID identity.
 */
export function messageExternalId(message: EmailMessageSummary): string {
  const messageId = normalizeMessageId(message.messageId);
  return messageId !== undefined
    ? `msgid:${messageId}`
    : `uid:${message.folder}:${message.uidValidity}:${message.uid}`;
}

export function normalizeMessageId(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim().replace(/^<|>$/g, "").trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Builds the redacted raw payload for a message and the attachments kept from it. */
export function toRawEmailPayload(
  message: EmailMessageSummary,
  attachments: readonly RawEmailAttachment[],
): RawEmailMessagePayload {
  return {
    kind: "email_message",
    folder: message.folder,
    uid: message.uid,
    uidValidity: message.uidValidity,
    messageId: normalizeMessageId(message.messageId),
    subject: message.subject,
    date: message.date,
    fromAddress: message.from?.address,
    fromName: message.from?.name,
    attachments: [...attachments],
  };
}

/**
 * Attachments listed on a previously recorded raw payload, so a rescan can
 * fetch only parts that were not kept before. Malformed entries are ignored
 * rather than trusted.
 */
export function recordedAttachments(payload: JsonValue): RawEmailAttachment[] {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return [];
  }
  const attachments = payload["attachments"];
  if (!Array.isArray(attachments)) {
    return [];
  }
  const kept: RawEmailAttachment[] = [];
  for (const entry of attachments) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const { partId, filename, mimeType, byteLength, contentHash } = entry;
    if (
      typeof partId === "string" &&
      typeof mimeType === "string" &&
      typeof byteLength === "number" &&
      typeof contentHash === "string" &&
      (filename === undefined || typeof filename === "string")
    ) {
      kept.push({ partId, filename, mimeType, byteLength, contentHash });
    }
  }
  return kept;
}

/** `JsonValue` view of the payload (drops `undefined` fields like JSON does). */
export function rawEmailPayloadJson(payload: RawEmailMessagePayload): JsonValue {
  return toJsonValue(payload);
}

const EMAIL_ADDRESS_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/**
 * Strips email addresses and any caller-supplied secrets from free text before
 * it reaches logs, error records, or sync summaries.
 */
export function redactSensitiveText(text: string, secrets: readonly string[] = []): string {
  let result = text;
  // Longest first, so a secret that contains another (user "nico", password
  // "nico1234") cannot leave a partial remainder behind.
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    if (secret.length > 0) {
      result = result.split(secret).join("[redacted]");
    }
  }
  return result.replace(EMAIL_ADDRESS_PATTERN, "[email]");
}

export function errorMessageRedacted(error: unknown, secrets: readonly string[] = []): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactSensitiveText(message, secrets);
}
