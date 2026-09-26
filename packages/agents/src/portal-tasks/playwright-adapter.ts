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
} from "./browser.js";
import { isSelectorTimeoutError } from "./browser.js";
import {
  isExpectedMimeType,
  isRedirectStatus,
  isSuccessfulStatus,
  parseContentLength,
  readBodyWithLimit,
} from "./download.js";
import type { PortalRequest } from "./network-guard.js";
import { resolveUrl } from "./url.js";

const PLAYWRIGHT_SPECIFIER = "playwright";
const DOWNLOAD_TIMEOUT_MS = 60_000;
const MIN_TOKEN_LENGTH = 8;

export function createLocalPlaywrightBrowserProvider(): PortalBrowserProvider {
  return new DynamicPlaywrightBrowserProvider("local-playwright", undefined);
}

export function createCdpPlaywrightBrowserProvider(
  providerName: string,
  cdpEndpoint: string,
): PortalBrowserProvider {
  return new DynamicPlaywrightBrowserProvider(providerName, cdpEndpoint);
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
  cookies(urls: readonly string[]): Promise<PlaywrightCookie[]>;
  newPage(): Promise<PlaywrightPage>;
  close(): Promise<void>;
}

interface PlaywrightCookie {
  name: string;
  value: string;
}

interface PlaywrightWebSocketRoute {
  url(): string;
  connectToServer(): unknown;
  close(): Promise<void>;
}

interface PlaywrightPage {
  goto(url: string): Promise<unknown>;
  fill(selector: string, value: string): Promise<void>;
  click(selector: string): Promise<void>;
  waitForSelector(selector: string, options: { timeout?: number }): Promise<unknown | null>;
  $$(selector: string): Promise<PlaywrightElement[]>;
  screenshot(): Promise<Buffer>;
  url(): string;
}

interface PlaywrightRoute {
  request(): {
    url(): string;
    method(): string;
    resourceType(): string;
  };
  continue(): Promise<void>;
  abort(): Promise<void>;
}

interface PlaywrightElement {
  getAttribute(name: string): Promise<string | null>;
  textContent(): Promise<string | null>;
}

class DynamicPlaywrightBrowserProvider implements PortalBrowserProvider {
  readonly providerName: string;
  readonly sensitiveValues: readonly string[];
  readonly #cdpEndpoint: string | undefined;

  constructor(providerName: string, cdpEndpoint: string | undefined) {
    this.providerName = providerName;
    this.#cdpEndpoint = cdpEndpoint;
    this.sensitiveValues = cdpEndpoint === undefined ? [] : cdpEndpointSecrets(cdpEndpoint);
  }

  async createSession(): Promise<PortalBrowserSession> {
    const module = await loadPlaywrightModule();
    const browser =
      this.#cdpEndpoint === undefined
        ? await module.chromium.launch({ headless: true })
        : await module.chromium.connectOverCDP(this.#cdpEndpoint);
    const context = await browser.newContext({
      acceptDownloads: false,
      serviceWorkers: "block",
    });
    const page = await context.newPage();
    const adaptedPage = new PlaywrightPageAdapter(page, context);
    return {
      page: adaptedPage,
      route: async (pattern, handler) => {
        await adaptedPage.route(pattern, handler);
      },
      close: async () => {
        await context.close();
        await browser.close();
      },
    };
  }
}

/**
 * A CDP endpoint is a secret in its own right, and so are the token-shaped
 * parts it is built from, in case an error echoes only one of them.
 */
function cdpEndpointSecrets(endpoint: string): string[] {
  const secrets = new Set<string>([endpoint]);
  try {
    const url = new URL(endpoint);
    if (url.password.length > 0) {
      secrets.add(url.password);
    }
    for (const value of url.searchParams.values()) {
      if (value.length >= MIN_TOKEN_LENGTH) {
        secrets.add(value);
      }
    }
  } catch {
    // Not a URL; the full string is still redacted.
  }
  return [...secrets];
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

  /**
   * Installs the guard on the browser context so popups are covered from their
   * first request, and on WebSocket handshakes, which `route` does not see.
   */
  async route(
    pattern: string,
    handler: (request: PortalRequest) => void | Promise<void>,
  ): Promise<void> {
    await this.#context.route(pattern, async (route) => {
      const request = route.request();
      try {
        await handler({
          url: request.url(),
          method: request.method(),
          resourceType: request.resourceType(),
        });
        await route.continue();
      } catch {
        await route.abort();
      }
    });
    // A glob such as `**/*` does not match `ws://` URLs in Playwright, so the
    // WebSocket route uses a predicate that intercepts every handshake.
    await this.#context.routeWebSocket(matchEveryUrl, async (route) => {
      try {
        await handler({ url: route.url(), method: "GET", resourceType: "websocket" });
        route.connectToServer();
      } catch {
        await route.close();
      }
    });
  }

  async goto(url: string): Promise<void> {
    await this.#page.goto(url);
  }

  async fill(selector: string, value: string): Promise<void> {
    await this.#page.fill(selector, value);
  }

  async click(selector: string): Promise<void> {
    await this.#page.click(selector);
  }

  async waitForSelector(selector: string, options: { timeoutMs?: number } = {}): Promise<boolean> {
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
   * Downloads with Node's streaming `fetch` rather than Playwright's request
   * API, which buffers the whole body before exposing it. Each hop carries the
   * browser session's cookies for that URL, follows redirects one at a time so
   * every target is re-evaluated by the guard, and stops reading the body the
   * moment it crosses the byte cap.
   */
  async requestBytes(
    url: string,
    options: PortalDownloadRequestOptions,
  ): Promise<PortalDownloadResponse> {
    let currentUrl = url;
    let redirectsFollowed = 0;
    while (true) {
      const response = await fetch(currentUrl, {
        method: "GET",
        headers: await this.downloadHeaders(currentUrl, options.expectedMimeType),
        redirect: "manual",
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      });
      const status = response.status;
      if (isRedirectStatus(status)) {
        await response.body?.cancel();
        if (redirectsFollowed >= options.maxRedirects) {
          throw new Error(`download exceeded ${options.maxRedirects} redirects`);
        }
        const location = response.headers.get("location");
        if (location === null) {
          throw new Error(`download redirect ${status} missing Location header`);
        }
        const nextUrl = resolveUrl(location, currentUrl);
        if (!options.onRedirect(nextUrl)) {
          throw new Error("download redirect blocked by portal network policy");
        }
        currentUrl = nextUrl;
        redirectsFollowed += 1;
        continue;
      }

      const mimeType = response.headers.get("content-type") ?? "application/octet-stream";
      if (!isSuccessfulStatus(status)) {
        await response.body?.cancel();
        throw new Error(`download failed with status ${status}`);
      }
      if (!isExpectedMimeType(mimeType, options.expectedMimeType)) {
        await response.body?.cancel();
        throw new Error(
          `download returned unexpected content type ${mimeType}; expected ${options.expectedMimeType}`,
        );
      }
      const contentLength = parseContentLength(response.headers.get("content-length"));
      if (contentLength !== undefined && contentLength > options.maxBytes) {
        await response.body?.cancel();
        throw new Error(`download exceeds ${options.maxBytes} byte limit`);
      }
      const bytes = await readBodyWithLimit(response.body, options.maxBytes);
      return { bytes, mimeType, finalUrl: currentUrl, status };
    }
  }

  private async downloadHeaders(
    url: string,
    expectedMimeType: string,
  ): Promise<Record<string, string>> {
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
