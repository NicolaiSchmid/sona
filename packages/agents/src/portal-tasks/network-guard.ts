import { forbiddenConceptFor } from "./policy.js";
import type {
  AllowedNonIdempotentPortalRequest,
  BlockedPortalRequest,
  BlockedPortalRequestReason,
  PortalResourceType,
} from "./provenance.js";
import type { PortalHttpMethodException, PortalTask } from "./schema.js";
import { sanitizeUrl } from "./url.js";

export interface PortalRequest {
  url: string;
  /** HTTP method as sent by the browser; compared case-insensitively. */
  method: string;
  resourceType: PortalResourceType;
  /** Request body for non-idempotent methods; null/undefined when absent. */
  postData?: string | null;
}

export interface NetworkGuardOptions {
  task: PortalTask;
}

export type PortalRequestDecision =
  | { action: "allow" }
  | { action: "abort"; reason: BlockedPortalRequestReason };

export interface NetworkGuardSnapshot {
  blockedRequests: BlockedPortalRequest[];
  allowedNonIdempotentRequests: AllowedNonIdempotentPortalRequest[];
}

const IDEMPOTENT_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const SECURE_PROTOCOLS = new Set(["https:", "wss:"]);
const LOCALHOST_PROTOCOLS = new Set([...SECURE_PROTOCOLS, "http:", "ws:"]);

/**
 * Execution-time read-only enforcement for one run. Every decision that blocks
 * a request, and every non-idempotent request let through under a reviewed
 * exception, is recorded for provenance.
 */
export class NetworkGuard {
  readonly #task: PortalTask;
  readonly #blockedRequests: BlockedPortalRequest[] = [];
  readonly #allowedNonIdempotentRequests: AllowedNonIdempotentPortalRequest[] = [];

  constructor(options: NetworkGuardOptions) {
    this.#task = options.task;
  }

  evaluateRequest(request: PortalRequest): PortalRequestDecision {
    const method = request.method.toUpperCase();
    if (!this.isAllowedUrl(request.url)) {
      return this.block(request, method, "off_allowlist");
    }

    // A WebSocket is a bidirectional channel whose messages the guard cannot
    // classify as idempotent, so guarded sessions never open one.
    if (request.resourceType === "websocket") {
      return this.block(request, method, "websocket");
    }

    if (IDEMPOTENT_METHODS.has(method)) {
      return { action: "allow" };
    }

    const exception = this.matchException(method, request.url);
    if (exception === undefined) {
      return this.block(request, method, "non_idempotent_method");
    }
    if (!isReviewedBody(request.postData, exception)) {
      return this.block(request, method, "unreviewed_body");
    }

    this.#allowedNonIdempotentRequests.push({
      url: sanitizeUrl(request.url) ?? request.url,
      method: exception.method,
      reason: exception.reason,
      justification: exception.justification,
    });
    return { action: "allow" };
  }

  snapshot(): NetworkGuardSnapshot {
    return {
      blockedRequests: this.#blockedRequests.map((request) => ({ ...request })),
      allowedNonIdempotentRequests: this.#allowedNonIdempotentRequests.map((request) => ({
        ...request,
      })),
    };
  }

  private isAllowedUrl(rawUrl: string): boolean {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return false;
    }

    const hostname = url.hostname.toLowerCase();
    if (!isAllowedProtocol(url.protocol, hostname)) {
      return false;
    }

    return this.#task.domains.some((domain) => {
      const normalized = domain.toLowerCase();
      return hostname === normalized || hostname.endsWith(`.${normalized}`);
    });
  }

  /**
   * Exceptions match the exact endpoint including its query string: a
   * justified `?action=search` must not also admit `?action=delete`. Only the
   * fragment is ignored because it never reaches the server.
   */
  private matchException(method: string, rawUrl: string): PortalHttpMethodException | undefined {
    const requestKey = exceptionMatchKey(rawUrl);
    return this.#task.httpMethodExceptions.find(
      (exception) =>
        exception.method === method && requestKey === exceptionMatchKey(exception.urlPattern),
    );
  }

  private block(
    request: PortalRequest,
    method: string,
    reason: BlockedPortalRequestReason,
  ): PortalRequestDecision {
    this.#blockedRequests.push({
      url: sanitizeUrl(request.url) ?? request.url,
      method,
      resourceType: request.resourceType,
      reason,
    });
    return { action: "abort", reason };
  }
}

export function createNetworkGuard(options: NetworkGuardOptions): NetworkGuard {
  return new NetworkGuard(options);
}

/**
 * The exception URL alone does not bound what a POST does; a multiplexed
 * `/api` endpoint dispatches on its body. Only the reviewed field names may be
 * sent, and for anything but login (whose values are opaque credentials) no
 * value may name a forbidden operation. Bodies the guard cannot parse are
 * refused rather than trusted.
 */
function isReviewedBody(
  postData: string | null | undefined,
  exception: PortalHttpMethodException,
): boolean {
  const fields = parseBodyFields(postData);
  if (fields === undefined) {
    return false;
  }
  const allowed = new Set(exception.allowedBodyFields);
  for (const [name, value] of fields) {
    if (!allowed.has(name)) {
      return false;
    }
    if (exception.reason !== "login" && forbiddenConceptFor(value) !== undefined) {
      return false;
    }
  }
  return true;
}

function parseBodyFields(postData: string | null | undefined): Map<string, string> | undefined {
  if (postData === undefined || postData === null || postData.trim().length === 0) {
    return new Map();
  }
  const trimmed = postData.trim();
  if (trimmed.startsWith("{")) {
    return parseJsonFields(trimmed);
  }
  if (trimmed.startsWith("--")) {
    // multipart/form-data is not reviewed field-by-field.
    return undefined;
  }
  return new Map(new URLSearchParams(trimmed));
}

function parseJsonFields(body: string): Map<string, string> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  const fields = new Map<string, string>();
  for (const [name, value] of Object.entries(parsed)) {
    fields.set(name, typeof value === "string" ? value : JSON.stringify(value));
  }
  return fields;
}

function exceptionMatchKey(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    return `${url.protocol}//${url.host}${url.pathname}${url.search}`;
  } catch {
    return rawUrl;
  }
}

/** Portal traffic must be encrypted; only localhost fixtures may use cleartext. */
function isAllowedProtocol(protocol: string, hostname: string): boolean {
  return hostname === "localhost"
    ? LOCALHOST_PROTOCOLS.has(protocol)
    : SECURE_PROTOCOLS.has(protocol);
}
