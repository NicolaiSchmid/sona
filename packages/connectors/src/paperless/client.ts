/**
 * Real {@link PaperlessClient} over the Paperless-ngx REST API using `fetch`.
 *
 * - The API token is resolved from the {@link SecretStore} per request and
 *   placed in the `Authorization` header only; it is never held on the
 *   client, logged, or placed in errors.
 * - The base URL must be HTTPS (plain HTTP only for loopback hosts) and its
 *   host must be on the configured allowlist, so a mistyped or hostile
 *   configuration cannot send the token elsewhere.
 * - Only `GET` requests exist; there is no code path that could mutate the
 *   archive. Responses are validated with zod before use, and the OCR
 *   `content` field is never requested (`fields=` narrows the payload).
 * - Errors are re-thrown as {@link PaperlessClientError} with a redacted
 *   message and no `cause` chain.
 */
import type { SecretRef, SecretStore, WorkspaceContext } from "@sona/core";
import { z } from "zod";
import {
  PaperlessBaseUrlRejectedError,
  PaperlessClientError,
  PaperlessDocumentTooLargeError,
  type PaperlessOperation,
} from "./errors.js";
import { mediaType, paperlessErrorMessage } from "./normalize.js";
import type {
  DownloadOriginalInput,
  ListDocumentsInput,
  PaperlessClient,
  PaperlessDocument,
  PaperlessDownload,
  PaperlessNamedEntity,
  PaperlessPage,
} from "./types.js";

export interface PaperlessHttpResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
}

export interface PaperlessHttpRequestInit {
  method: "GET";
  headers: Record<string, string>;
  signal?: AbortSignal;
}

export type PaperlessFetch = (
  url: string,
  init: PaperlessHttpRequestInit,
) => Promise<PaperlessHttpResponse>;

export interface PaperlessConnectionSettings {
  /** Instance root, e.g. `https://paperless.example.net` or `https://host/paperless`. */
  baseUrl: string;
  /**
   * Hostnames the base URL may point at; sub-domains of an entry match.
   * Required and non-empty: an empty allowlist rejects every URL.
   */
  allowedHosts: readonly string[];
  /** Secret-store reference to the Paperless API token. */
  tokenSecret: SecretRef;
}

export interface PaperlessHttpClientInput {
  connection: PaperlessConnectionSettings;
  secrets: SecretStore;
  /** Workspace the credentials belong to; the client is bound to it. */
  context: WorkspaceContext;
  /** Injectable transport; defaults to the global `fetch`. */
  fetch?: PaperlessFetch;
  /** Per-request budget in ms. Default 30s. */
  requestTimeoutMs?: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
/** Fields requested from `/api/documents/`; `content` (OCR text) is deliberately absent. */
const DOCUMENT_FIELDS = [
  "id",
  "title",
  "created",
  "modified",
  "added",
  "correspondent",
  "document_type",
  "tags",
  "archive_serial_number",
  "original_file_name",
  "mime_type",
] as const;

const namedEntitySchema = z.object({ id: z.number().int(), name: z.string() });

const pageSchema = <T extends z.ZodTypeAny>(item: T) =>
  z.object({ next: z.string().nullable().optional(), results: z.array(item) });

const documentSchema = z.object({
  id: z.number().int(),
  title: z.string(),
  created: z.string(),
  modified: z.string(),
  added: z.string(),
  correspondent: z.number().int().nullable().optional(),
  document_type: z.number().int().nullable().optional(),
  tags: z.array(z.number().int()).default([]),
  archive_serial_number: z.number().int().nullable().optional(),
  original_file_name: z.string().nullable().optional(),
  mime_type: z.string().nullable().optional(),
});

/**
 * Validates and normalizes the configured base URL: absolute, https (http only
 * for loopback), no credentials/query/fragment, host on the allowlist.
 * Returns the URL with a trailing slash so paths append cleanly.
 */
export function resolvePaperlessBaseUrl(baseUrl: string, allowedHosts: readonly string[]): URL {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new PaperlessBaseUrlRejectedError("not an absolute URL");
  }
  if (url.username !== "" || url.password !== "") {
    throw new PaperlessBaseUrlRejectedError("credentials in URL are not allowed");
  }
  if (url.search !== "" || url.hash !== "") {
    throw new PaperlessBaseUrlRejectedError("query string or fragment is not allowed");
  }
  const host = url.hostname.toLowerCase();
  const loopback = LOOPBACK_HOSTS.has(host);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new PaperlessBaseUrlRejectedError("only https is allowed (http for loopback only)");
  }
  const allowed = allowedHosts
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
  if (!allowed.some((entry) => host === entry || host.endsWith(`.${entry}`))) {
    throw new PaperlessBaseUrlRejectedError("host is not on the allowlist");
  }
  if (!url.pathname.endsWith("/")) {
    url.pathname = `${url.pathname}/`;
  }
  return url;
}

export function createPaperlessHttpClient(input: PaperlessHttpClientInput): PaperlessClient {
  const base = resolvePaperlessBaseUrl(input.connection.baseUrl, input.connection.allowedHosts);
  const doFetch: PaperlessFetch = input.fetch ?? ((url, init) => fetch(url, init));
  const timeoutMs = input.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const { secrets, context } = input;
  const tokenSecret = input.connection.tokenSecret;

  function apiUrl(path: string, query: Record<string, string | undefined>): string {
    const url = new URL(path.replace(/^\//, ""), base);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) {
        url.searchParams.set(key, value);
      }
    }
    return url.toString();
  }

  /** Issues one GET with a fresh token; every failure becomes a redacted client error. */
  async function get(
    operation: PaperlessOperation,
    url: string,
    accept: string,
  ): Promise<PaperlessHttpResponse> {
    const token = (await secrets.getSecret({ context, ref: tokenSecret })).reveal();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await doFetch(url, {
        method: "GET",
        headers: { Authorization: `Token ${token}`, Accept: accept },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new PaperlessClientError(operation, `HTTP ${response.status}`, response.status);
      }
      return response;
    } catch (error) {
      if (error instanceof PaperlessClientError) {
        throw error;
      }
      throw new PaperlessClientError(operation, paperlessErrorMessage(error, [token]), undefined);
    } finally {
      clearTimeout(timer);
    }
  }

  async function getJson<T>(url: string, schema: z.ZodType<T>): Promise<T> {
    const response = await get("list", url, "application/json; version=5");
    let body: unknown;
    try {
      body = JSON.parse(await response.text());
    } catch {
      throw new PaperlessClientError("list", "response was not JSON", response.status);
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw new PaperlessClientError(
        "list",
        "response did not match the expected shape",
        response.status,
      );
    }
    return parsed.data;
  }

  /** Follows DRF pagination for the small lookup endpoints. */
  async function listAll(path: string): Promise<PaperlessNamedEntity[]> {
    const results: PaperlessNamedEntity[] = [];
    for (let page = 1; ; page++) {
      const body = await getJson(
        apiUrl(path, { page: String(page), page_size: "100", fields: "id,name" }),
        pageSchema(namedEntitySchema),
      );
      results.push(...body.results);
      if (body.next === null || body.next === undefined) {
        return results;
      }
    }
  }

  return {
    workspaceId: context.workspaceId,
    instanceHost: base.hostname,

    listTags: () => listAll("api/tags/"),
    listCorrespondents: () => listAll("api/correspondents/"),
    listDocumentTypes: () => listAll("api/document_types/"),

    async listDocuments(query: ListDocumentsInput): Promise<PaperlessPage<PaperlessDocument>> {
      const body = await getJson(
        apiUrl("api/documents/", {
          ordering: "modified,id",
          page: String(query.page),
          page_size: String(query.pageSize),
          fields: DOCUMENT_FIELDS.join(","),
          modified__gte: query.modifiedSince,
        }),
        pageSchema(documentSchema),
      );
      return {
        hasMore: body.next !== null && body.next !== undefined,
        results: body.results.map((d) => ({
          id: d.id,
          title: d.title,
          created: d.created,
          modified: d.modified,
          added: d.added,
          correspondentId: d.correspondent ?? undefined,
          documentTypeId: d.document_type ?? undefined,
          tagIds: d.tags ?? [],
          archiveSerialNumber: d.archive_serial_number ?? undefined,
          originalFileName: d.original_file_name ?? undefined,
          mimeType: mediaType(d.mime_type),
        })),
      };
    },

    async downloadOriginal(request: DownloadOriginalInput): Promise<PaperlessDownload> {
      const response = await get(
        "download",
        apiUrl(`api/documents/${request.documentId}/download/`, { original: "true" }),
        "*/*",
      );
      const declaredLength = Number(response.headers.get("content-length") ?? "");
      if (Number.isFinite(declaredLength) && declaredLength > request.maxBytes) {
        throw new PaperlessDocumentTooLargeError(request.documentId, request.maxBytes);
      }
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(await response.arrayBuffer());
      } catch (error) {
        throw new PaperlessClientError("download", paperlessErrorMessage(error), response.status);
      }
      if (bytes.byteLength > request.maxBytes) {
        throw new PaperlessDocumentTooLargeError(request.documentId, request.maxBytes);
      }
      return { bytes, contentType: mediaType(response.headers.get("content-type")) };
    },
  };
}
