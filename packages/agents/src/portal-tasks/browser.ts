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

/** Passed to providers so managed browsers can tag their remote session with the run. */
export interface PortalBrowserSessionInput {
  task: PortalTask;
  runId: string;
}

/** Throws to abort the request; resolving lets it through. */
export type PortalRequestGuard = (request: PortalRequest) => void | Promise<void>;

/**
 * A guarded browser session. `guardRequests` must present every request the
 * session can make, including popups, WebSocket handshakes, and every redirect
 * hop, to the guard before it is sent; a guard that throws aborts the request.
 */
export interface PortalBrowserSession {
  page: PortalBrowserPage;
  guardRequests(guard: PortalRequestGuard): Promise<void>;
  close(): Promise<void>;
}

export interface PortalElementHandle {
  getAttribute(name: string): Promise<string | null>;
  textContent(): Promise<string | null>;
}

export interface PortalSelectorOptions {
  timeoutMs?: number;
}

export interface PortalBrowserPage {
  goto(url: string): Promise<void>;
  /** Selector actions reject with a timeout error (see {@link isSelectorTimeoutError}) when the element does not appear. */
  fill(selector: string, value: string, options?: PortalSelectorOptions): Promise<void>;
  click(selector: string, options?: PortalSelectorOptions): Promise<void>;
  /** Resolves false when the selector does not appear in time; may also reject with a timeout error. */
  waitForSelector(selector: string, options?: PortalSelectorOptions): Promise<boolean>;
  queryAll(selector: string): Promise<PortalElementHandle[]>;
  /**
   * Downloads with the session's cookies. Implementations follow redirects one
   * hop at a time and consult `onRedirect` before each, stop reading once
   * `maxBytes` is exceeded (throwing `DownloadTooLargeError`), and report
   * status, media type, and final URL, leaving acceptance policy to the runner.
   */
  requestBytes(url: string, options: PortalDownloadRequestOptions): Promise<PortalDownloadResponse>;
  screenshot?(): Promise<Uint8Array>;
  url(): string;
}

export interface PortalDownloadRequestOptions {
  expectedMimeType: string;
  maxBytes: number;
  maxRedirects: number;
  /** Returns false to refuse a redirect target; the download then fails. */
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
