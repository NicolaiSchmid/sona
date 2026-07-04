import type { LocalPlaywrightPortalTaskRunnerOptions } from "./playwright-runner.js";
import {
  createCdpPlaywrightBrowserProvider,
  LocalPlaywrightPortalTaskRunner,
} from "./playwright-runner.js";

export interface BrowserbasePortalTaskRunnerOptions
  extends Omit<LocalPlaywrightPortalTaskRunnerOptions, "browserProvider"> {
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
