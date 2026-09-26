import { createCdpPlaywrightBrowserProvider } from "./playwright-adapter.js";
import type { LocalPlaywrightPortalTaskRunnerOptions } from "./playwright-runner.js";
import { LocalPlaywrightPortalTaskRunner } from "./playwright-runner.js";

export interface BrowserbasePortalTaskRunnerOptions
  extends Omit<LocalPlaywrightPortalTaskRunnerOptions, "browserProvider"> {
  /**
   * Browserbase CDP endpoint. It typically carries the API key or session
   * token in its query string, so the provider registers it with the run
   * redactor and it never appears in run errors or provenance.
   */
  connectOverCdpEndpoint: string;
}

/**
 * Browserbase-backed runner. Browserbase exposes a managed browser over CDP;
 * the read-only policy, network guard, redaction, storage, and dedup behavior
 * remain identical to the local Playwright runner.
 */
export class BrowserbasePortalTaskRunner extends LocalPlaywrightPortalTaskRunner {
  constructor(options: BrowserbasePortalTaskRunnerOptions) {
    super({
      ...options,
      browserProvider: createCdpPlaywrightBrowserProvider(
        "browserbase",
        options.connectOverCdpEndpoint,
      ),
    });
  }
}
