import { forbiddenConceptFor } from "./policy.js";
import type {
  AllowedNonIdempotentPortalRequest,
  BlockedPortalRequest,
  BlockedPortalRequestReason,
  PortalResourceType,
} from "./provenance.js";
import type { PortalHttpMethodException, PortalTask } from "./schema.js";
import { decodedPathAndQuery, redactUrl } from "./url.js";

export interface PortalRequest {
  url: string;
  /** HTTP method as sent by the browser; compared case-insensitively. */
  method: string;
  resourceType: PortalResourceType;
  /** Request body for non-idempotent methods; absent when the request has none. */
  postData?: string;
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
 * Paths ending in a static asset extension are exempt from the destructive
 * URL screen: an icon named `add.svg` is not an operation. The exemption is
 * based on the URL, not on how the browser classified the request, because a
 * portal can trigger `GET /cancel-subscription` through an `<img>` just as
 * well as through a link.
 */
const STATIC_ASSET_RE =
  /\.(?:js|mjs|css|map|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|otf|eot|mp4|webm|mp3|json|xml|txt)$/i;

/**
 * Blocks that mean the task itself tried to leave the read-only boundary: a
 * navigation or download the guard refused, or an attempted mutation. An
 * incidental third-party pixel, font, or WebSocket that was aborted is recorded
 * as provenance but does not stop the run.
 */
export function isMaterialBlock(blocked: BlockedPortalRequest): boolean {
  return (
    blocked.resourceType === "document" ||
    blocked.reason === "destructive_url" ||
    blocked.reason === "non_idempotent_method" ||
    blocked.reason === "unreviewed_body"
  );
}

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

    // Merchant portals do not reliably keep GET side-effect free, so a URL
    // that names a forbidden operation is refused regardless of method.
    if (isDestructiveUrl(request.url)) {
      return this.block(request, method, "destructive_url");
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
      url: recordedUrl(request.url),
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
      url: recordedUrl(request.url),
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

function isDestructiveUrl(rawUrl: string): boolean {
  const pathAndQuery = decodedPathAndQuery(rawUrl);
  // Only a bare asset path is exempt; `logo.png?action=delete` is still screened.
  if (!pathAndQuery.includes("?") && STATIC_ASSET_RE.test(pathAndQuery)) {
    return false;
  }
  return forbiddenConceptFor(pathAndQuery) !== undefined;
}

/**
 * The exception URL alone does not bound what a POST does; a multiplexed
 * `/api` endpoint dispatches on its body. Only the reviewed field names may be
 * sent; credential fields carry opaque values, pinned control fields must
 * carry one of their reviewed values, and any other value must not name a
 * forbidden operation. Every occurrence of a repeated field is checked, and
 * bodies the guard cannot parse are refused rather than trusted.
 */
function isReviewedBody(
  postData: string | undefined,
  exception: PortalHttpMethodException,
): boolean {
  const fields = parseBodyFields(postData);
  if (fields === undefined) {
    return false;
  }
  const allowed = new Set(exception.allowedBodyFields);
  const credentials = new Set(exception.credentialBodyFields);
  for (const [name, value] of fields) {
    if (!allowed.has(name)) {
      return false;
    }
    if (credentials.has(name)) {
      continue;
    }
    const pinned = exception.pinnedBodyValues[name];
    if (pinned !== undefined ? !pinned.includes(value) : forbiddenConceptFor(value) !== undefined) {
      return false;
    }
  }
  return true;
}

type BodyField = readonly [name: string, value: string];

function parseBodyFields(postData: string | undefined): readonly BodyField[] | undefined {
  if (postData === undefined || postData.trim().length === 0) {
    return [];
  }
  const trimmed = postData.trim();
  if (trimmed.startsWith("{")) {
    return parseJsonFields(trimmed);
  }
  if (trimmed.startsWith("--")) {
    // multipart/form-data is not reviewed field-by-field.
    return undefined;
  }
  return [...new URLSearchParams(trimmed).entries()];
}

function parseJsonFields(body: string): readonly BodyField[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  return Object.entries(parsed).map(([name, value]) => [
    name,
    typeof value === "string" ? value : JSON.stringify(value),
  ]);
}

/**
 * Provenance keeps host and path shape only; malformed input is kept verbatim
 * so the record still explains the block.
 */
function recordedUrl(rawUrl: string): string {
  return redactUrl(rawUrl) ?? rawUrl;
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
