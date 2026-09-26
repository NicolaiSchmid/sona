/**
 * @sona/connectors
 *
 * Source adapters for banks, email, merchant portals, and portfolio exports.
 * Every adapter produces immutable raw source records before normalization.
 */

/** Package version marker, used to verify wiring and test discovery. */
export const sonaConnectorsVersion = "0.0.0" as const;

export * as email from "./email/index.js";
export * as enableBanking from "./enable-banking/index.js";
export * as paperless from "./paperless/index.js";
export * as portfolioPerformance from "./portfolio-performance/index.js";
