/**
 * Deterministic in-memory {@link PaperlessClient} for tests.
 *
 * Every request is appended to {@link FakePaperlessClient.requests} as
 * `"<METHOD> <path>"` so a test can assert that a sync issued nothing but
 * `GET`s. The fake also exposes the mutating endpoints a real instance would
 * accept (`POST`, `PATCH`, `DELETE`, bulk edit) — each records the request
 * and throws, so any code path that reaches for them fails loudly.
 */
import {
  PaperlessClientError,
  PaperlessDocumentTooLargeError,
  PaperlessReadOnlyViolationError,
} from "./errors.js";
import { compareDocumentOrder, mediaType } from "./normalize.js";
import type {
  DownloadOriginalInput,
  ListDocumentsInput,
  PaperlessClient,
  PaperlessDocument,
  PaperlessDownload,
  PaperlessNamedEntity,
  PaperlessPage,
} from "./types.js";

export interface FakePaperlessDocument extends PaperlessDocument {
  /** Original bytes served by `/download/?original=true`. */
  bytes: Uint8Array;
  /** `Content-Type` of the download response. */
  contentType: string;
}

export interface FakePaperlessClientOptions {
  workspaceId: string;
  instanceHost?: string;
  documents: readonly FakePaperlessDocument[];
  tags?: readonly PaperlessNamedEntity[];
  correspondents?: readonly PaperlessNamedEntity[];
  documentTypes?: readonly PaperlessNamedEntity[];
  /** Every listing call fails with this error (simulates downtime). */
  listError?: Error;
  /** Downloads of these document ids fail with a transport error. */
  failDownloadIds?: readonly number[];
}

export class FakePaperlessClient implements PaperlessClient {
  readonly workspaceId: string;
  readonly instanceHost: string;
  readonly requests: string[] = [];
  #documents: FakePaperlessDocument[];
  readonly #options: FakePaperlessClientOptions;

  constructor(options: FakePaperlessClientOptions) {
    this.workspaceId = options.workspaceId;
    this.instanceHost = options.instanceHost ?? "paperless.test";
    this.#documents = [...options.documents];
    this.#options = options;
  }

  /** Test hook: mutate the fixture between syncs (what a user would do in Paperless). */
  setDocuments(documents: readonly FakePaperlessDocument[]): void {
    this.#documents = [...documents];
  }

  async listTags(): Promise<PaperlessNamedEntity[]> {
    return this.#list("api/tags/", this.#options.tags ?? []);
  }

  async listCorrespondents(): Promise<PaperlessNamedEntity[]> {
    return this.#list("api/correspondents/", this.#options.correspondents ?? []);
  }

  async listDocumentTypes(): Promise<PaperlessNamedEntity[]> {
    return this.#list("api/document_types/", this.#options.documentTypes ?? []);
  }

  async listDocuments(input: ListDocumentsInput): Promise<PaperlessPage<PaperlessDocument>> {
    this.#record(
      `GET api/documents/?ordering=modified,id&page=${input.page}&page_size=${input.pageSize}${
        input.modifiedSince === undefined ? "" : `&modified__gte=${input.modifiedSince}`
      }`,
    );
    this.#failIfDown();
    const since = input.modifiedSince === undefined ? undefined : Date.parse(input.modifiedSince);
    const ordered = [...this.#documents]
      .filter((d) => since === undefined || Date.parse(d.modified) >= since)
      .sort(compareDocumentOrder);
    const start = (input.page - 1) * input.pageSize;
    const results = ordered.slice(start, start + input.pageSize).map(stripFakeFields);
    return { results, hasMore: start + input.pageSize < ordered.length };
  }

  async downloadOriginal(input: DownloadOriginalInput): Promise<PaperlessDownload> {
    this.#record(`GET api/documents/${input.documentId}/download/?original=true`);
    if (this.#options.failDownloadIds?.includes(input.documentId)) {
      throw new PaperlessClientError("download", "connection reset", undefined);
    }
    const document = this.#documents.find((d) => d.id === input.documentId);
    if (document === undefined) {
      throw new PaperlessClientError("download", "HTTP 404", 404);
    }
    if (document.bytes.byteLength > input.maxBytes) {
      throw new PaperlessDocumentTooLargeError(input.documentId, input.maxBytes);
    }
    return { bytes: new Uint8Array(document.bytes), contentType: mediaType(document.contentType) };
  }

  // --- Mutating endpoints a real instance exposes; never legitimately reached. ---

  async createDocument(): Promise<never> {
    return this.#refuse("POST api/documents/post_document/");
  }

  async updateDocument(id: number): Promise<never> {
    return this.#refuse(`PATCH api/documents/${id}/`);
  }

  async deleteDocument(id: number): Promise<never> {
    return this.#refuse(`DELETE api/documents/${id}/`);
  }

  async bulkEdit(): Promise<never> {
    return this.#refuse("POST api/documents/bulk_edit/");
  }

  #refuse(request: string): never {
    this.#record(request);
    throw new PaperlessReadOnlyViolationError(request.split(" ")[0] ?? request);
  }

  #list<T extends PaperlessNamedEntity>(path: string, entities: readonly T[]): T[] {
    this.#record(`GET ${path}?page=1&page_size=100`);
    this.#failIfDown();
    return [...entities];
  }

  #failIfDown(): void {
    if (this.#options.listError !== undefined) {
      throw this.#options.listError;
    }
  }

  #record(request: string): void {
    this.requests.push(request);
  }
}

function stripFakeFields(document: FakePaperlessDocument): PaperlessDocument {
  const { bytes: _bytes, contentType: _contentType, ...rest } = document;
  return rest;
}
