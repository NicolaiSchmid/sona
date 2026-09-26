/**
 * The browser contract a portal task runner executes against. Providers wrap
 * a real browser (see `playwright-adapter.ts`) or a test fixture; the runner
 * never touches a browser API directly.
 */
import type { PortalRequest } from "./network-guard.js";
import type { PortalTask } from "./schema.js";

export interface PortalBrowserProvider {
  providerName: string;
  /**
   * Values the provider itself must keep out of run output, such as a CDP
   * endpoint carrying an API token. The runner registers them with the run
   * redactor before the session is created so setup failures are redacted too.
   */
  sensitiveValues?: readonly string[];
  createSession(input: PortalBrowserSessionInput): Promise<PortalBrowserSession>;
}

export interface PortalBrowserSessionInput {
  task: PortalTask;
  runId: string;
}

/**
 * A guarded browser session. `route` must see every request the session can
 * make, including popups and WebSocket handshakes, before it leaves the
 * browser; a handler that throws aborts the request.
 */
export interface PortalBrowserSession {
  page: PortalBrowserPage;
  route(pattern: string, handler: (request: PortalRequest) => void | Promise<void>): Promise<void>;
  close(): Promise<void>;
}

export interface PortalElementHandle {
  getAttribute(name: string): Promise<string | null>;
  textContent(): Promise<string | null>;
}

export interface PortalBrowserPage {
  goto(url: string): Promise<void>;
  fill(selector: string, value: string): Promise<void>;
  click(selector: string): Promise<void>;
  /**
   * Resolves false when the selector does not appear in time. Pages may also
   * surface the timeout as an error; see {@link isSelectorTimeoutError}.
   */
  waitForSelector(selector: string, options?: { timeoutMs?: number }): Promise<boolean>;
  queryAll(selector: string): Promise<PortalElementHandle[]>;
  requestBytes(url: string, options: PortalDownloadRequestOptions): Promise<PortalDownloadResponse>;
  screenshot?(): Promise<Uint8Array>;
  url(): string;
}

export interface PortalDownloadRequestOptions {
  expectedMimeType: string;
  maxBytes: number;
  maxRedirects: number;
  onRedirect(url: string): boolean;
}

export interface PortalDownloadResponse {
  bytes: Uint8Array;
  mimeType: string;
  finalUrl: string;
  status: number;
}

export function isSelectorTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return error.name === "TimeoutError" || /timeout/i.test(error.message);
}
