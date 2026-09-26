/**
 * Playwright-backed {@link PortalBrowserProvider}. Playwright is resolved at
 * runtime rather than imported statically so `@sona/agents` loads without the
 * optional `playwright` peer; the module shape is narrowed structurally below
 * instead of relying on Playwright's own types.
 *
 * Every HTTP request of a guarded session is issued by the worker through
 * Playwright's request interception with redirects disabled, so each hop is
 * evaluated by the guard before it is sent. A remote (Browserbase) browser
 * therefore contributes rendering and script execution, not network egress.
 */
import type {
  PortalBrowserPage,
  PortalBrowserProvider,
  PortalBrowserSession,
  PortalDownloadRequestOptions,
  PortalDownloadResponse,
  PortalElementHandle,
  PortalRequestGuard,
  PortalSelectorOptions,
} from "./browser.js";
import { isSelectorTimeoutError } from "./browser.js";
import {
  isRedirectStatus,
  parseContentLength,
  readBodyWithLimit,
  redirectPreservesMethod,
  redirectTarget,
} from "./download.js";
import type { PortalRequest } from "./network-guard.js";
import { PORTAL_RESOURCE_TYPES, type PortalResourceType } from "./provenance.js";

const PLAYWRIGHT_SPECIFIER = "playwright";
const MIN_TOKEN_LENGTH = 8;
const DOWNLOAD_TIMEOUT_MS = 60_000;

export function createLocalPlaywrightBrowserProvider(): PortalBrowserProvider {
  return new PlaywrightBrowserProvider("local-playwright", undefined);
}

export function createCdpPlaywrightBrowserProvider(
  providerName: string,
  cdpEndpoint: string,
): PortalBrowserProvider {
  return new PlaywrightBrowserProvider(providerName, cdpEndpoint);
}

interface PlaywrightModule {
  chromium: {
    launch(options: { headless: boolean }): Promise<PlaywrightBrowser>;
    connectOverCDP(endpoint: string): Promise<PlaywrightBrowser>;
  };
}

interface PlaywrightBrowser {
  newContext(options: {
    acceptDownloads: boolean;
    serviceWorkers: "allow" | "block";
  }): Promise<PlaywrightContext>;
  close(): Promise<void>;
}

interface PlaywrightContext {
  route(pattern: string, handler: (route: PlaywrightRoute) => Promise<void>): Promise<void>;
  routeWebSocket(
    matcher: (url: URL) => boolean,
    handler: (route: PlaywrightWebSocketRoute) => void | Promise<void>,
  ): Promise<void>;
  on(event: "request", handler: (request: PlaywrightRequest) => void): void;
  cookies(urls: readonly string[]): Promise<PlaywrightCookie[]>;
  newPage(): Promise<PlaywrightPage>;
  close(): Promise<void>;
}

interface PlaywrightCookie {
  name: string;
  value: string;
}

interface PlaywrightRequest {
  url(): string;
  method(): string;
  resourceType(): string;
  headers(): Record<string, string>;
  postData(): string | null;
  isNavigationRequest(): boolean;
  redirectedFrom(): object | null;
}

interface PlaywrightWebSocketRoute {
  url(): string;
  connectToServer(): unknown;
  close(): Promise<void>;
}

interface PlaywrightPage {
  goto(url: string): Promise<unknown>;
  fill(selector: string, value: string, options: { timeout?: number }): Promise<void>;
  click(selector: string, options: { timeout?: number }): Promise<void>;
  waitForSelector(selector: string, options: { timeout?: number }): Promise<unknown>;
  $$(selector: string): Promise<PlaywrightElement[]>;
  screenshot(): Promise<Buffer>;
  url(): string;
}

interface PlaywrightRouteFetchOptions {
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  /** A Buffer (possibly empty) replaces the body; a missing value re-sends the original. */
  postData?: string | Buffer;
  /** The whole design relies on the browser never following a hop itself. */
  maxRedirects: 0;
}

interface PlaywrightApiResponse {
  status(): number;
  headers(): Record<string, string>;
}

interface PlaywrightRoute {
  request(): PlaywrightRequest;
  fetch(options: PlaywrightRouteFetchOptions): Promise<PlaywrightApiResponse>;
  fulfill(
    options:
      | { response: PlaywrightApiResponse }
      | { status: number; contentType: string; body: string },
  ): Promise<void>;
  abort(): Promise<void>;
}

interface PlaywrightElement {
  getAttribute(name: string): Promise<string | null>;
  textContent(): Promise<string | null>;
}

class PlaywrightBrowserProvider implements PortalBrowserProvider {
  readonly providerName: string;
  readonly sensitiveValues: readonly string[];
  readonly #cdpEndpoint: string | undefined;

  constructor(providerName: string, cdpEndpoint: string | undefined) {
    this.providerName = providerName;
    this.#cdpEndpoint = cdpEndpoint;
    this.sensitiveValues = cdpEndpoint === undefined ? [] : cdpEndpointSensitiveValues(cdpEndpoint);
  }

  async createSession(): Promise<PortalBrowserSession> {
    const module = await loadPlaywrightModule();
    const browser =
      this.#cdpEndpoint === undefined
        ? await module.chromium.launch({ headless: true })
        : await module.chromium.connectOverCDP(this.#cdpEndpoint);
    // A failed setup must not leak a Chromium process or a managed session.
    const context = await browser
      .newContext({ acceptDownloads: false, serviceWorkers: "block" })
      .catch(async (error: unknown) => {
        await browser.close().catch(() => undefined);
        throw error;
      });
    let page: PlaywrightPage;
    try {
      page = await context.newPage();
    } catch (error) {
      await context.close().catch(() => undefined);
      await browser.close().catch(() => undefined);
      throw error;
    }
    return {
      page: new PlaywrightPageAdapter(page, context),
      guardRequests: (guard) => installRequestGuard(context, guard),
      close: async () => {
        try {
          await context.close();
        } finally {
          await browser.close();
        }
      },
    };
  }
}

/**
 * Installs the guard at the browser-context level so popups are covered from
 * their first request, on WebSocket handshakes (which `route` never sees), and
 * on every redirect hop: the browser is never handed a 3xx to follow on its
 * own (see {@link resolveRouteThroughGuard}). Should a redirected request
 * nevertheless surface, it is reported to the guard and the session fails
 * closed.
 */
async function installRequestGuard(
  context: PlaywrightContext,
  guard: PortalRequestGuard,
): Promise<void> {
  let guardBypassed = false;
  await context.route("**/*", async (route) => {
    if (guardBypassed) {
      await route.abort();
      return;
    }
    try {
      await guard(toPortalRequest(route.request()));
      await resolveRouteThroughGuard(route, guard);
    } catch {
      await route.abort();
    }
  });
  // A glob such as `**/*` does not match `ws://` URLs in Playwright, so the
  // WebSocket route uses a predicate that intercepts every handshake.
  await context.routeWebSocket(matchEveryUrl, async (route) => {
    try {
      await guard({ url: route.url(), method: "GET", resourceType: "websocket" });
      route.connectToServer();
    } catch {
      await route.close();
    }
  });
  context.on("request", (request) => {
    if (request.redirectedFrom() === null) {
      return;
    }
    void Promise.resolve()
      .then(() => guard(toPortalRequest(request)))
      .catch(() => {
        guardBypassed = true;
      });
  });
}

/**
 * Performs an already-allowed request with redirects disabled and resolves
 * the chain hop by hop, presenting each target to the guard before it is
 * sent. An allowed GET navigation is handed back to the browser as a
 * client-side redirect so the next hop becomes a fresh, routed navigation and
 * the page URL stays truthful; every other allowed hop is followed here and
 * the final response fulfilled in place.
 */
async function resolveRouteThroughGuard(
  route: PlaywrightRoute,
  guard: PortalRequestGuard,
): Promise<void> {
  const request = route.request();
  const resourceType = toResourceType(request.resourceType());
  const originalMethod = request.method();
  const originalOrigin = new URL(request.url()).origin;
  let url = request.url();
  let method = originalMethod;
  let postData = request.postData() ?? undefined;
  for (let hop = 0; ; hop += 1) {
    const response = await route.fetch(
      hop === 0
        ? { maxRedirects: 0 }
        : {
            url,
            method,
            headers: hopHeaders(request.headers(), {
              methodChanged: method !== originalMethod,
              originChanged: new URL(url).origin !== originalOrigin,
            }),
            // An empty Buffer is an explicit "no body"; undefined would re-send
            // the original. Playwright still labels it `application/octet-stream`
            // with `content-length: 0`, which is harmless for a body-less GET.
            postData: postData === undefined ? Buffer.alloc(0) : postData,
            maxRedirects: 0,
          },
    );
    const status = response.status();
    if (!isRedirectStatus(status)) {
      await route.fulfill({ response });
      return;
    }
    const nextUrl = redirectTarget({
      status,
      location: response.headers()["location"],
      currentUrl: url,
      hop,
    });
    const preservesMethod = redirectPreservesMethod(status);
    const nextMethod = preservesMethod ? method : "GET";
    const nextPostData = preservesMethod ? postData : undefined;
    await guard({ url: nextUrl, method: nextMethod, resourceType, postData: nextPostData });
    if (request.isNavigationRequest() && nextMethod === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "text/html",
        body: clientRedirectPage(nextUrl),
      });
      return;
    }
    url = nextUrl;
    method = nextMethod;
    postData = nextPostData;
  }
}

const BODY_HEADERS = new Set([
  "content-type",
  "content-length",
  "content-encoding",
  "content-language",
  "content-location",
]);

/**
 * Headers for an in-place hop. `route.fetch` would otherwise re-send the
 * original request's headers verbatim: the `Cookie` header must go so the
 * context jar re-derives cookies for the new URL, `Authorization` must not
 * cross origins, and body headers are meaningless once a redirect turned the
 * request into a GET.
 */
function hopHeaders(
  original: Record<string, string>,
  change: { methodChanged: boolean; originChanged: boolean },
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(original)) {
    const lower = name.toLowerCase();
    if (lower === "cookie") {
      continue;
    }
    if (lower === "authorization" && change.originChanged) {
      continue;
    }
    if (BODY_HEADERS.has(lower) && change.methodChanged) {
      continue;
    }
    headers[lower] = value;
  }
  return headers;
}

/**
 * Both a meta refresh and `location.replace` are emitted: the script keeps the
 * interstitial out of history, the meta tag covers a page with scripting off.
 */
function clientRedirectPage(url: string): string {
  const literal = JSON.stringify(url);
  const attribute = url.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  return `<!doctype html><meta http-equiv="refresh" content="0;url=${attribute}"><script>location.replace(${literal})</script>`;
}

function toPortalRequest(request: PlaywrightRequest): PortalRequest {
  return {
    url: request.url(),
    method: request.method(),
    resourceType: toResourceType(request.resourceType()),
    postData: request.postData() ?? undefined,
  };
}

const RESOURCE_TYPES: ReadonlySet<string> = new Set(PORTAL_RESOURCE_TYPES);

function toResourceType(value: string): PortalResourceType {
  return isPortalResourceType(value) ? value : "other";
}

function isPortalResourceType(value: string): value is PortalResourceType {
  return RESOURCE_TYPES.has(value);
}

/**
 * A CDP endpoint is a secret in its own right, and so are the token-shaped
 * parts it is built from, in case an error echoes only one of them.
 */
function cdpEndpointSensitiveValues(endpoint: string): string[] {
  const values = new Set<string>([endpoint]);
  try {
    const url = new URL(endpoint);
    if (url.password.length > 0) {
      values.add(url.password);
    }
    for (const value of url.searchParams.values()) {
      if (value.length >= MIN_TOKEN_LENGTH) {
        values.add(value);
      }
    }
  } catch {
    // Not a URL; the full string is still redacted.
  }
  return [...values];
}

async function loadPlaywrightModule(): Promise<PlaywrightModule> {
  let loaded: unknown;
  try {
    loaded = await import(PLAYWRIGHT_SPECIFIER);
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    throw new Error(
      `playwright module is required for the default portal browser provider; install the optional peer dependency "playwright" or inject a PortalBrowserProvider: ${cause}`,
    );
  }
  if (!isPlaywrightModule(loaded)) {
    throw new Error(
      'playwright module is required for the default portal browser provider but did not expose chromium; install the optional peer dependency "playwright" or inject a PortalBrowserProvider',
    );
  }
  return loaded;
}

function isPlaywrightModule(value: unknown): value is PlaywrightModule {
  if (typeof value !== "object" || value === null || !("chromium" in value)) {
    return false;
  }
  const chromium: unknown = value.chromium;
  return (
    typeof chromium === "object" &&
    chromium !== null &&
    "launch" in chromium &&
    typeof chromium.launch === "function" &&
    "connectOverCDP" in chromium &&
    typeof chromium.connectOverCDP === "function"
  );
}

class PlaywrightPageAdapter implements PortalBrowserPage {
  readonly #page: PlaywrightPage;
  readonly #context: PlaywrightContext;

  constructor(page: PlaywrightPage, context: PlaywrightContext) {
    this.#page = page;
    this.#context = context;
  }

  async goto(url: string): Promise<void> {
    await this.#page.goto(url);
  }

  async fill(selector: string, value: string, options: PortalSelectorOptions = {}): Promise<void> {
    await this.#page.fill(selector, value, { timeout: options.timeoutMs });
  }

  async click(selector: string, options: PortalSelectorOptions = {}): Promise<void> {
    await this.#page.click(selector, { timeout: options.timeoutMs });
  }

  async waitForSelector(selector: string, options: PortalSelectorOptions = {}): Promise<boolean> {
    try {
      const found = await this.#page.waitForSelector(selector, { timeout: options.timeoutMs });
      return found !== null;
    } catch (error) {
      if (isSelectorTimeoutError(error)) {
        return false;
      }
      throw error;
    }
  }

  async queryAll(selector: string): Promise<PortalElementHandle[]> {
    return await this.#page.$$(selector);
  }

  /**
   * Downloads with Node's streaming `fetch`, which (unlike Playwright's request
   * API) exposes the body before buffering it, so reading stops the moment the
   * cap is crossed. Each hop carries the session's cookies for that URL, is
   * bounded by a wall-clock deadline, and is presented to `onRedirect` before
   * it is followed. Being worker-issued, it does not depend on page CORS.
   */
  async requestBytes(
    url: string,
    options: PortalDownloadRequestOptions,
  ): Promise<PortalDownloadResponse> {
    const signal = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
    let currentUrl = url;
    let redirectsFollowed = 0;
    while (true) {
      const response = await fetch(currentUrl, {
        method: "GET",
        headers: await this.#downloadHeaders(currentUrl, options.expectedMimeType),
        redirect: "manual",
        signal,
      });
      if (isRedirectStatus(response.status)) {
        await response.body?.cancel();
        const nextUrl = redirectTarget({
          status: response.status,
          location: response.headers.get("location"),
          currentUrl,
          hop: redirectsFollowed,
        });
        if (redirectsFollowed >= options.maxRedirects) {
          throw new Error(`download exceeded ${options.maxRedirects} redirects`);
        }
        if (!options.onRedirect(nextUrl)) {
          throw new Error("download redirect blocked by portal network policy");
        }
        currentUrl = nextUrl;
        redirectsFollowed += 1;
        continue;
      }

      const contentLength = parseContentLength(response.headers.get("content-length"));
      if (contentLength !== undefined && contentLength > options.maxBytes) {
        await response.body?.cancel();
        throw new Error(`download exceeds ${options.maxBytes} byte limit`);
      }
      const bytes = await readBodyWithLimit(response.body, options.maxBytes);
      return {
        bytes,
        mimeType: response.headers.get("content-type") ?? "",
        finalUrl: currentUrl,
        status: response.status,
      };
    }
  }

  async #downloadHeaders(url: string, expectedMimeType: string): Promise<Record<string, string>> {
    const headers: Record<string, string> = { accept: `${expectedMimeType}, */*;q=0.1` };
    const cookies = await this.#context.cookies([url]);
    if (cookies.length > 0) {
      headers["cookie"] = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
    }
    return headers;
  }

  async screenshot(): Promise<Uint8Array> {
    return new Uint8Array(await this.#page.screenshot());
  }

  url(): string {
    return this.#page.url();
  }
}

function matchEveryUrl(): boolean {
  return true;
}
