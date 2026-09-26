import type {
  AllowedNonIdempotentPortalRequest,
  BlockedPortalRequest,
  BlockedPortalRequestReason,
} from "./provenance.js";
import type { PortalHttpMethodException, PortalTask } from "./schema.js";

export interface PortalRequest {
  url: string;
  method: string;
  resourceType: string;
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
      return this.block(request, "off_allowlist");
    }

    // A WebSocket is a bidirectional channel whose messages the guard cannot
    // classify as idempotent, so guarded sessions never open one.
    if (request.resourceType === "websocket") {
      return this.block(request, "websocket");
    }

    if (IDEMPOTENT_METHODS.has(method)) {
      return { action: "allow" };
    }

    const exception = this.matchException(method, request.url);
    if (exception === undefined) {
      return this.block(request, "non_idempotent_method");
    }

    this.#allowedNonIdempotentRequests.push({
      url: sanitizeRequestUrl(request.url),
      method,
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

  private block(request: PortalRequest, reason: BlockedPortalRequestReason): PortalRequestDecision {
    this.#blockedRequests.push({
      url: sanitizeRequestUrl(request.url),
      method: request.method.toUpperCase(),
      resourceType: request.resourceType,
      reason,
    });
    return { action: "abort", reason };
  }
}

export function createNetworkGuard(options: NetworkGuardOptions): NetworkGuard {
  return new NetworkGuard(options);
}

function sanitizeRequestUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return rawUrl;
  }
}

function exceptionMatchKey(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    return `${url.protocol}//${url.host}${url.pathname}${url.search}`;
  } catch {
    return rawUrl;
  }
}

const SECURE_PROTOCOLS = new Set(["https:", "wss:"]);
const LOCALHOST_PROTOCOLS = new Set([...SECURE_PROTOCOLS, "http:", "ws:"]);

/** Portal traffic must be encrypted; only localhost fixtures may use cleartext. */
function isAllowedProtocol(protocol: string, hostname: string): boolean {
  return hostname === "localhost"
    ? LOCALHOST_PROTOCOLS.has(protocol)
    : SECURE_PROTOCOLS.has(protocol);
}
