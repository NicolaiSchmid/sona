import { createSecretValue, createWorkspaceContext, InMemorySecretStore } from "@sona/core";
import { describe, expect, it } from "vitest";
import {
  createPaperlessHttpClient,
  type PaperlessFetch,
  type PaperlessHttpRequestInit,
  type PaperlessHttpResponse,
  resolvePaperlessBaseUrl,
} from "./client.js";
import {
  PaperlessBaseUrlRejectedError,
  PaperlessClientError,
  PaperlessDocumentTooLargeError,
} from "./errors.js";

const TOKEN = "paperless-token-0123456789abcdef";
const context = createWorkspaceContext({ workspaceId: "ws_1" });

interface Recorded {
  url: string;
  init: PaperlessHttpRequestInit;
}

function response(
  body: string | Uint8Array,
  init: { status?: number; headers?: Record<string, string> } = {},
): PaperlessHttpResponse {
  const status = init.status ?? 200;
  const headers = new Map(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers.get(name.toLowerCase()) ?? null },
    arrayBuffer: async () => {
      const copy = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(copy).set(bytes);
      return copy;
    },
    text: async () => new TextDecoder().decode(bytes),
  };
}

async function setup(handler: (url: URL, init: PaperlessHttpRequestInit) => PaperlessHttpResponse) {
  const secrets = new InMemorySecretStore();
  const ref = await secrets.putSecret({
    context,
    label: "paperless token",
    value: createSecretValue(TOKEN),
  });
  const requests: Recorded[] = [];
  const fetch: PaperlessFetch = async (url, init) => {
    requests.push({ url, init });
    return handler(new URL(url), init);
  };
  const client = createPaperlessHttpClient({
    connection: {
      baseUrl: "https://paperless.example.net/dms",
      allowedHosts: ["example.net"],
      tokenSecret: ref,
    },
    secrets,
    context,
    fetch,
  });
  return { client, requests };
}

describe("resolvePaperlessBaseUrl", () => {
  it("accepts an allowlisted https host and normalizes the trailing slash", () => {
    expect(resolvePaperlessBaseUrl("https://dms.example.net", ["example.net"]).toString()).toBe(
      "https://dms.example.net/",
    );
    expect(
      resolvePaperlessBaseUrl("https://dms.example.net/paperless", ["dms.example.net"]).toString(),
    ).toBe("https://dms.example.net/paperless/");
  });

  it("allows plain http for loopback only", () => {
    expect(resolvePaperlessBaseUrl("http://localhost:8000", ["localhost"]).hostname).toBe(
      "localhost",
    );
    expect(() => resolvePaperlessBaseUrl("http://dms.example.net", ["example.net"])).toThrow(
      PaperlessBaseUrlRejectedError,
    );
  });

  it("rejects hosts off the allowlist, credentials, queries, and relative URLs", () => {
    for (const [url, hosts] of [
      ["https://evil.example.org", ["example.net"]],
      ["https://example.net.evil.org", ["example.net"]],
      ["https://user:pw@dms.example.net", ["example.net"]],
      ["https://dms.example.net/?x=1", ["example.net"]],
      ["https://dms.example.net/#frag", ["example.net"]],
      ["dms.example.net", ["example.net"]],
      ["https://dms.example.net", []],
      ["https://dms.example.net", ["  "]],
    ] as const) {
      expect(() => resolvePaperlessBaseUrl(url, hosts), url).toThrow(PaperlessBaseUrlRejectedError);
    }
  });
});

describe("createPaperlessHttpClient", () => {
  it("lists documents with the token header, narrowed fields, and (modified, id) ordering", async () => {
    const { client, requests } = await setup((url) => {
      expect(url.pathname).toBe("/dms/api/documents/");
      return response(
        JSON.stringify({
          next: null,
          results: [
            {
              id: 5,
              title: "T",
              created: "2026-01-01T00:00:00+01:00",
              modified: "2026-01-02T00:00:00Z",
              added: "2026-01-01T00:00:00Z",
              correspondent: null,
              document_type: 2,
              tags: [1],
              archive_serial_number: null,
              original_file_name: "t.pdf",
              mime_type: "application/pdf",
            },
          ],
        }),
      );
    });
    const page = await client.listDocuments({
      modifiedSince: "2026-01-01T00:00:00Z",
      page: 2,
      pageSize: 50,
    });
    expect(page.hasMore).toBe(false);
    expect(page.results).toEqual([
      {
        id: 5,
        title: "T",
        created: "2026-01-01T00:00:00+01:00",
        modified: "2026-01-02T00:00:00Z",
        added: "2026-01-01T00:00:00Z",
        correspondentId: undefined,
        documentTypeId: 2,
        tagIds: [1],
        archiveSerialNumber: undefined,
        originalFileName: "t.pdf",
        mimeType: "application/pdf",
      },
    ]);
    const request = requests[0];
    const url = new URL(request?.url ?? "");
    expect(request?.init.method).toBe("GET");
    expect(request?.init.headers["Authorization"]).toBe(`Token ${TOKEN}`);
    expect(url.searchParams.get("ordering")).toBe("modified,id");
    expect(url.searchParams.get("page")).toBe("2");
    expect(url.searchParams.get("page_size")).toBe("50");
    expect(url.searchParams.get("modified__gte")).toBe("2026-01-01T00:00:00Z");
    expect(url.searchParams.get("fields")).not.toContain("content");
    expect(client.instanceHost).toBe("paperless.example.net");
    expect(client.workspaceId).toBe("ws_1");
  });

  it("follows pagination for lookup endpoints", async () => {
    const { client, requests } = await setup((url) =>
      response(
        JSON.stringify(
          url.searchParams.get("page") === "1"
            ? {
                next: "https://paperless.example.net/dms/api/tags/?page=2",
                results: [{ id: 1, name: "A" }],
              }
            : { next: null, results: [{ id: 2, name: "B" }] },
        ),
      ),
    );
    expect(await client.listTags()).toEqual([
      { id: 1, name: "A" },
      { id: 2, name: "B" },
    ]);
    expect(requests).toHaveLength(2);
  });

  it("downloads originals and enforces the byte cap from header and body", async () => {
    const pdf = new TextEncoder().encode("%PDF-1.4 x");
    const { client } = await setup((url) => {
      expect(url.pathname).toBe("/dms/api/documents/7/download/");
      expect(url.searchParams.get("original")).toBe("true");
      return response(pdf, {
        headers: {
          "content-type": "application/pdf; charset=binary",
          "content-length": String(pdf.byteLength),
        },
      });
    });
    const download = await client.downloadOriginal({ documentId: 7, maxBytes: 1024 });
    expect(download.contentType).toBe("application/pdf");
    expect(Buffer.from(download.bytes).equals(pdf)).toBe(true);
    await expect(client.downloadOriginal({ documentId: 7, maxBytes: 4 })).rejects.toBeInstanceOf(
      PaperlessDocumentTooLargeError,
    );

    const { client: noLength } = await setup(() => response(pdf));
    await expect(noLength.downloadOriginal({ documentId: 7, maxBytes: 4 })).rejects.toBeInstanceOf(
      PaperlessDocumentTooLargeError,
    );
  });

  it("turns HTTP errors, malformed bodies, and transport failures into redacted client errors", async () => {
    const { client: forbidden } = await setup(() => response("nope", { status: 403 }));
    await expect(forbidden.listTags()).rejects.toMatchObject({
      name: "PaperlessClientError",
      status: 403,
      message: "Paperless list failed: HTTP 403",
    });

    const { client: garbage } = await setup(() => response("<html>"));
    await expect(garbage.listTags()).rejects.toThrow(/response was not JSON/);

    const { client: wrongShape } = await setup(() =>
      response(JSON.stringify({ results: [{ id: "x" }] })),
    );
    await expect(wrongShape.listTags()).rejects.toThrow(/did not match the expected shape/);

    const secrets = new InMemorySecretStore();
    const ref = await secrets.putSecret({ context, label: "t", value: createSecretValue(TOKEN) });
    const leaky = createPaperlessHttpClient({
      connection: {
        baseUrl: "https://dms.example.net",
        allowedHosts: ["example.net"],
        tokenSecret: ref,
      },
      secrets,
      context,
      fetch: async () => {
        throw new Error(`ECONNRESET while sending Token ${TOKEN} to admin@example.net`);
      },
    });
    const error = await leaky.listTags().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PaperlessClientError);
    const message = error instanceof Error ? error.message : "";
    expect(message).not.toContain(TOKEN);
    expect(message).not.toContain("admin@");
    expect(message).toContain("[redacted]");
    expect((error as Error & { cause?: unknown }).cause).toBeUndefined();
  });

  it("refuses to construct against a base URL off the allowlist", async () => {
    const secrets = new InMemorySecretStore();
    const ref = await secrets.putSecret({ context, label: "t", value: createSecretValue(TOKEN) });
    expect(() =>
      createPaperlessHttpClient({
        connection: {
          baseUrl: "https://attacker.example.org",
          allowedHosts: ["example.net"],
          tokenSecret: ref,
        },
        secrets,
        context,
      }),
    ).toThrow(PaperlessBaseUrlRejectedError);
  });
});
