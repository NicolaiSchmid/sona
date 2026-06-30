/**
 * A small Enable Banking AIS client.
 *
 * - Every request carries a freshly signed `Authorization: Bearer <jwt>`.
 * - Transient sandbox failures (502/503/504, network errors) are retried.
 * - Non-2xx responses become an {@link EnableBankingApiError} with status and a
 *   truncated body. Tokens and the private key are never placed in errors/logs.
 */
import { createEnableBankingJwt } from "./jwt.js";
import type {
  EbAccountDetails,
  EbApplication,
  EbAspspList,
  EbAuthResponse,
  EbBalancesResponse,
  EbSession,
  EbTransactionsResponse,
} from "./types.js";

export interface HttpResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

export interface HttpRequestInit {
  method: string;
  headers: Record<string, string>;
  body?: string;
}

export type FetchLike = (url: string, init: HttpRequestInit) => Promise<HttpResponse>;

export interface EnableBankingConfig {
  applicationId: string;
  privateKeyPem: string;
  apiBase?: string;
  audience?: string;
  jwtTtlSeconds?: number;
  /** Injectable transport; defaults to the global `fetch`. */
  fetch?: FetchLike;
  /** Injectable clock (ms); defaults to `Date.now`. */
  now?: () => number;
  /** Max retry attempts for transient failures. Default 2. */
  maxRetries?: number;
  /** Backoff before retry `attempt` (1-based). Default 250ms * attempt. */
  retryDelayMs?: (attempt: number) => number;
}

const DEFAULT_API_BASE = "https://api.enablebanking.com";
const RETRYABLE_STATUS = new Set([502, 503, 504]);

export class EnableBankingApiError extends Error {
  readonly status: number;
  readonly method: string;
  readonly path: string;
  readonly bodySnippet: string;
  constructor(status: number, method: string, path: string, bodySnippet: string) {
    super(`Enable Banking API error ${status} for ${method} ${path}`);
    this.name = "EnableBankingApiError";
    this.status = status;
    this.method = method;
    this.path = path;
    this.bodySnippet = bodySnippet;
  }
}

interface RequestOptions {
  query?: Record<string, string | undefined>;
  body?: unknown;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface EnableBankingClient {
  getApplication(): Promise<EbApplication>;
  listAspsps(input: { country: string; nameContains?: string }): Promise<EbAspspList>;
  startAuth(input: {
    country: string;
    name: string;
    redirectUrl: string;
    validUntil: string;
    state?: string;
    psuType?: string;
  }): Promise<EbAuthResponse>;
  exchangeCode(input: { code: string }): Promise<EbSession>;
  getSession(input: { sessionId: string }): Promise<EbSession>;
  getAccountDetails(input: { accountUid: string }): Promise<EbAccountDetails>;
  getBalances(input: { accountUid: string }): Promise<EbBalancesResponse>;
  getTransactions(input: {
    accountUid: string;
    continuationKey?: string;
  }): Promise<EbTransactionsResponse>;
}

export function createEnableBankingClient(config: EnableBankingConfig): EnableBankingClient {
  const apiBase = (config.apiBase ?? DEFAULT_API_BASE).replace(/\/$/, "");
  const doFetch: FetchLike = config.fetch ?? ((url, init) => fetch(url, init));
  const now = config.now ?? Date.now;
  const maxRetries = config.maxRetries ?? 2;
  const retryDelayMs = config.retryDelayMs ?? ((attempt: number) => 250 * attempt);

  function authHeader(): string {
    const token = createEnableBankingJwt(
      {
        applicationId: config.applicationId,
        privateKeyPem: config.privateKeyPem,
        audience: config.audience,
        ttlSeconds: config.jwtTtlSeconds,
      },
      Math.floor(now() / 1000),
    );
    return `Bearer ${token}`;
  }

  function buildUrl(path: string, query?: RequestOptions["query"]): string {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) {
        params.set(key, value);
      }
    }
    const qs = params.toString();
    return `${apiBase}${path}${qs ? `?${qs}` : ""}`;
  }

  async function request<T>(
    method: string,
    path: string,
    options: RequestOptions = {},
  ): Promise<T> {
    const url = buildUrl(path, options.query);
    const init: HttpRequestInit = {
      method,
      headers: {
        Authorization: authHeader(),
        Accept: "application/json",
        ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    };

    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        await sleep(retryDelayMs(attempt));
      }
      let response: HttpResponse;
      try {
        response = await doFetch(url, init);
      } catch (error) {
        lastError = error; // network/timeout error: retry
        continue;
      }

      if (response.ok) {
        return (await response.json()) as T;
      }

      if (RETRYABLE_STATUS.has(response.status) && attempt < maxRetries) {
        lastError = new EnableBankingApiError(response.status, method, path, "");
        continue;
      }

      const bodySnippet = (await safeText(response)).slice(0, 500);
      throw new EnableBankingApiError(response.status, method, path, bodySnippet);
    }

    throw lastError instanceof Error
      ? lastError
      : new Error(`Enable Banking request failed for ${method} ${path}`);
  }

  return {
    getApplication: () => request("GET", "/application"),
    listAspsps: async ({ country, nameContains }) => {
      const result = await request<EbAspspList>("GET", "/aspsps", { query: { country } });
      if (nameContains === undefined) {
        return result;
      }
      const needle = nameContains.toLowerCase();
      return { aspsps: result.aspsps.filter((a) => a.name.toLowerCase().includes(needle)) };
    },
    startAuth: ({ country, name, redirectUrl, validUntil, state, psuType }) =>
      request("POST", "/auth", {
        body: {
          access: { valid_until: validUntil },
          aspsp: { name, country },
          redirect_url: redirectUrl,
          state,
          psu_type: psuType,
        },
      }),
    exchangeCode: ({ code }) => request("POST", "/sessions", { body: { code } }),
    getSession: ({ sessionId }) => request("GET", `/sessions/${encodeURIComponent(sessionId)}`),
    getAccountDetails: ({ accountUid }) =>
      request("GET", `/accounts/${encodeURIComponent(accountUid)}/details`),
    getBalances: ({ accountUid }) =>
      request("GET", `/accounts/${encodeURIComponent(accountUid)}/balances`),
    getTransactions: ({ accountUid, continuationKey }) =>
      request("GET", `/accounts/${encodeURIComponent(accountUid)}/transactions`, {
        query: { continuation_key: continuationKey },
      }),
  };
}

async function safeText(response: HttpResponse): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}
