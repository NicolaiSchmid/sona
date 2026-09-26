/**
 * Playwright-backed {@link PortalBrowserProvider}. Playwright is resolved at
 * runtime rather than imported statically so `@sona/agents` loads without the
 * optional `playwright` peer; the module shape is narrowed structurally below
 * instead of relying on Playwright's own types.
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
import { DownloadTooLargeError } from "./download.js";
import type { PortalRequest } from "./network-guard.js";
import { PORTAL_RESOURCE_TYPES, type PortalResourceType } from "./provenance.js";

const PLAYWRIGHT_SPECIFIER = "playwright";
const MIN_TOKEN_LENGTH = 8;

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
  newPage(): Promise<PlaywrightPage>;
  close(): Promise<void>;
}

interface PlaywrightRequest {
  url(): string;
  method(): string;
  resourceType(): string;
  postData(): string | null;
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
  evaluate<Result, Arg>(pageFunction: (arg: Arg) => Promise<Result>, arg: Arg): Promise<Result>;
  screenshot(): Promise<Buffer>;
  url(): string;
}

interface PlaywrightRoute {
  request(): PlaywrightRequest;
  continue(): Promise<void>;
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
    let context: PlaywrightContext | undefined;
    try {
      context = await browser.newContext({
        acceptDownloads: false,
        serviceWorkers: "block",
      });
      const guardedContext = context;
      const page = await context.newPage();
      return {
        page: new PlaywrightPageAdapter(page),
        guardRequests: (guard) => installRequestGuard(guardedContext, guard),
        close: async () => {
          await guardedContext.close();
          await browser.close();
        },
      };
    } catch (error) {
      // A failed setup must not leak a Chromium process or a managed session.
      await context?.close().catch(() => undefined);
      await browser.close().catch(() => undefined);
      throw error;
    }
  }
}

/**
 * Installs the guard at the browser-context level so popups are covered from
 * their first request, on WebSocket handshakes (which `route` never sees), and
 * on redirect hops. Playwright presents only the first URL of a redirect chain
 * to a route handler and the browser follows later hops on its own; those hops
 * still surface as request events, so they are reported to the guard for
 * provenance and, once any hop is disallowed, every further request in the
 * session is aborted (fail closed).
 */
async function installRequestGuard(
  context: PlaywrightContext,
  guard: PortalRequestGuard,
): Promise<void> {
  let escaped = false;
  await context.route("**/*", async (route) => {
    if (escaped) {
      await route.abort();
      return;
    }
    try {
      await guard(toPortalRequest(route.request()));
      await route.continue();
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
        escaped = true;
      });
  });
}

function toPortalRequest(request: PlaywrightRequest): PortalRequest {
  return {
    url: request.url(),
    method: request.method(),
    resourceType: toResourceType(request.resourceType()),
    postData: request.postData(),
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

  constructor(page: PlaywrightPage) {
    this.#page = page;
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
   * Fetches inside the page so the portal sees the browser's own cookies, IP,
   * and TLS fingerprint (with Browserbase the browser is remote), and streams
   * the body in the browser so no more than `maxBytes` is ever buffered. The
   * first hop passes through the route guard; later redirect hops are
   * reported to it as request events and the runner re-checks the final URL.
   */
  async requestBytes(
    url: string,
    options: PortalDownloadRequestOptions,
  ): Promise<PortalDownloadResponse> {
    const result = await this.#page.evaluate(fetchBoundedInPage, {
      url,
      accept: `${options.expectedMimeType}, */*;q=0.1`,
      maxBytes: options.maxBytes,
    });
    if (result.truncated) {
      throw new DownloadTooLargeError(options.maxBytes);
    }
    return {
      bytes: new Uint8Array(Buffer.from(result.base64, "base64")),
      mimeType: result.mimeType,
      finalUrl: result.finalUrl,
      status: result.status,
    };
  }

  async screenshot(): Promise<Uint8Array> {
    return new Uint8Array(await this.#page.screenshot());
  }

  url(): string {
    return this.#page.url();
  }
}

interface InPageDownloadInput {
  url: string;
  accept: string;
  maxBytes: number;
}

interface InPageDownloadResult {
  status: number;
  mimeType: string;
  finalUrl: string;
  base64: string;
  truncated: boolean;
}

/**
 * Runs inside the browser page (serialized by Playwright), so it must stay
 * self-contained: no references to module scope.
 */
async function fetchBoundedInPage(input: InPageDownloadInput): Promise<InPageDownloadResult> {
  const response = await fetch(input.url, {
    credentials: "include",
    headers: { accept: input.accept },
    redirect: "follow",
  });
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = response.body?.getReader();
  if (reader !== undefined) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > input.maxBytes) {
        await reader.cancel();
        return {
          status: response.status,
          mimeType: response.headers.get("content-type") ?? "",
          finalUrl: response.url,
          base64: "",
          truncated: true,
        };
      }
      chunks.push(value);
    }
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let binary = "";
  const sliceSize = 0x8000;
  for (let index = 0; index < merged.length; index += sliceSize) {
    binary += String.fromCharCode(...merged.subarray(index, index + sliceSize));
  }
  return {
    status: response.status,
    mimeType: response.headers.get("content-type") ?? "",
    finalUrl: response.url,
    base64: btoa(binary),
    truncated: false,
  };
}

function matchEveryUrl(): boolean {
  return true;
}
