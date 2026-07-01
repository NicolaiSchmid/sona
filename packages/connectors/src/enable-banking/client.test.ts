import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createEnableBankingClient,
  EnableBankingApiError,
  type FetchLike,
  type HttpRequestInit,
  type HttpResponse,
} from "./client.js";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

function jsonResponse(status: number, body: unknown): HttpResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

interface Call {
  url: string;
  init: HttpRequestInit;
}

function recordingFetch(responses: Array<HttpResponse | (() => never)>): {
  fetch: FetchLike;
  calls: Call[];
} {
  const calls: Call[] = [];
  let i = 0;
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const next = responses[i++];
    if (typeof next === "function") {
      next(); // throw a network error
    }
    return next as HttpResponse;
  };
  return { fetch, calls };
}

const baseConfig = {
  applicationId: "app_1",
  privateKeyPem,
  apiBase: "https://sandbox.example/api",
  retryDelayMs: () => 0,
};

describe("EnableBankingClient", () => {
  it("sends a Bearer JWT and respects the API base url", async () => {
    const { fetch, calls } = recordingFetch([jsonResponse(200, { name: "Demo App" })]);
    const client = createEnableBankingClient({ ...baseConfig, fetch });

    const app = await client.getApplication();

    expect(app).toEqual({ name: "Demo App" });
    expect(calls[0]?.url).toBe("https://sandbox.example/api/application");
    expect(calls[0]?.init.headers["Authorization"]).toMatch(/^Bearer ey/);
  });

  it("filters ASPSPs by name on top of the country query", async () => {
    const { fetch, calls } = recordingFetch([
      jsonResponse(200, {
        aspsps: [
          { name: "DKB", country: "DE" },
          { name: "Sparkasse", country: "DE" },
        ],
      }),
    ]);
    const client = createEnableBankingClient({ ...baseConfig, fetch });

    const result = await client.listAspsps({ country: "DE", nameContains: "spark" });

    expect(result.aspsps.map((a) => a.name)).toEqual(["Sparkasse"]);
    expect(calls[0]?.url).toContain("country=DE");
  });

  it("retries transient 503s and then succeeds", async () => {
    const { fetch, calls } = recordingFetch([
      jsonResponse(503, { error: "temporarily unavailable" }),
      jsonResponse(200, { name: "Demo App" }),
    ]);
    const client = createEnableBankingClient({ ...baseConfig, fetch });

    const app = await client.getApplication();

    expect(app).toEqual({ name: "Demo App" });
    expect(calls).toHaveLength(2);
  });

  it("retries network errors", async () => {
    const { fetch, calls } = recordingFetch([
      () => {
        throw new Error("ECONNRESET");
      },
      jsonResponse(200, { name: "Demo App" }),
    ]);
    const client = createEnableBankingClient({ ...baseConfig, fetch });

    await expect(client.getApplication()).resolves.toEqual({ name: "Demo App" });
    expect(calls).toHaveLength(2);
  });

  it("normalizes a non-2xx response into a structured error", async () => {
    const { fetch } = recordingFetch([jsonResponse(404, { error: "not found" })]);
    const client = createEnableBankingClient({ ...baseConfig, fetch });

    await expect(client.getAccountDetails({ accountUid: "acc_x" })).rejects.toMatchObject({
      name: "EnableBankingApiError",
      status: 404,
      method: "GET",
    });
  });

  it("forwards allowlisted PSU headers on data requests and drops others", async () => {
    const { fetch, calls } = recordingFetch([jsonResponse(200, { balances: [] })]);
    const client = createEnableBankingClient({
      ...baseConfig,
      fetch,
      psuHeaders: { "PSU-IP-Address": "203.0.113.7", "X-Evil": "nope" },
    });

    await client.getBalances({ accountUid: "acc_1", psuHeaders: { "PSU-User-Agent": "Sona/1" } });

    const headers = calls[0]?.init.headers ?? {};
    expect(headers["PSU-IP-Address"]).toBe("203.0.113.7");
    expect(headers["PSU-User-Agent"]).toBe("Sona/1");
    expect(headers["X-Evil"]).toBeUndefined();
  });

  it("does not retry non-idempotent POST requests", async () => {
    // A retried exchangeCode could resubmit a one-use code.
    const { fetch, calls } = recordingFetch([
      jsonResponse(503, {}),
      jsonResponse(200, { session_id: "s" }),
    ]);
    const client = createEnableBankingClient({ ...baseConfig, fetch });

    await expect(client.exchangeCode({ code: "one_time" })).rejects.toBeInstanceOf(
      EnableBankingApiError,
    );
    expect(calls).toHaveLength(1);
  });

  it("passes the history strategy through on transaction reads", async () => {
    const { fetch, calls } = recordingFetch([jsonResponse(200, { transactions: [] })]);
    const client = createEnableBankingClient({ ...baseConfig, fetch });

    await client.getTransactions({
      accountUid: "acc_1",
      strategy: "longest",
      dateFrom: "2025-01-01",
    });

    expect(calls[0]?.url).toContain("strategy=longest");
    expect(calls[0]?.url).toContain("date_from=2025-01-01");
  });

  it("gives up after exhausting retries on persistent 503", async () => {
    const { fetch, calls } = recordingFetch([
      jsonResponse(503, {}),
      jsonResponse(503, {}),
      jsonResponse(503, {}),
    ]);
    const client = createEnableBankingClient({ ...baseConfig, fetch, maxRetries: 2 });

    await expect(client.getApplication()).rejects.toBeInstanceOf(EnableBankingApiError);
    expect(calls).toHaveLength(3);
  });
});
