import { describe, expect, it } from "vitest";
import {
  DownloadTooLargeError,
  documentBytesProblem,
  isExpectedMimeType,
  isRedirectStatus,
  isSuccessfulStatus,
  MAX_REDIRECT_HOPS,
  parseContentLength,
  readBodyWithLimit,
  redirectPreservesMethod,
  redirectTarget,
} from "./download.js";

function streamOf(chunks: readonly Uint8Array[]): {
  stream: ReadableStream<Uint8Array>;
  pulled: () => number;
  cancelled: () => boolean;
} {
  let index = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index];
      if (chunk === undefined) {
        controller.close();
        return;
      }
      index += 1;
      controller.enqueue(chunk);
    },
    cancel() {
      cancelled = true;
    },
  });
  return { stream, pulled: () => index, cancelled: () => cancelled };
}

describe("readBodyWithLimit", () => {
  it("concatenates a body within the limit", async () => {
    const { stream } = streamOf([new Uint8Array([1, 2]), new Uint8Array([3])]);

    const bytes = await readBodyWithLimit(stream, 3);

    expect([...bytes]).toEqual([1, 2, 3]);
  });

  it("stops reading and cancels the stream once the limit is crossed", async () => {
    const chunks = Array.from({ length: 10 }, () => new Uint8Array(4));
    const { stream, pulled, cancelled } = streamOf(chunks);

    await expect(readBodyWithLimit(stream, 9)).rejects.toBeInstanceOf(DownloadTooLargeError);
    expect(pulled()).toBe(3);
    expect(cancelled()).toBe(true);
  });

  it("returns an empty body for a null stream", async () => {
    expect((await readBodyWithLimit(null, 1)).byteLength).toBe(0);
  });

  it("accepts a body that lands exactly on the limit", async () => {
    const { stream, cancelled } = streamOf([new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])]);

    const bytes = await readBodyWithLimit(stream, 5);

    expect([...bytes]).toEqual([1, 2, 3, 4, 5]);
    expect(cancelled()).toBe(false);
  });

  it("rejects a body one byte over the limit and reports the cap", async () => {
    const { stream } = streamOf([new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6])]);

    const error = await readBodyWithLimit(stream, 5).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DownloadTooLargeError);
    expect((error as DownloadTooLargeError).maxBytes).toBe(5);
    expect((error as DownloadTooLargeError).name).toBe("DownloadTooLargeError");
  });

  it("releases the reader lock after a completed read", async () => {
    const { stream } = streamOf([new Uint8Array([1])]);

    await readBodyWithLimit(stream, 1);

    expect(stream.locked).toBe(false);
  });
});

describe("isExpectedMimeType", () => {
  it("compares media types ignoring parameters, case, and whitespace", () => {
    expect(isExpectedMimeType("application/PDF; charset=binary", "application/pdf")).toBe(true);
    expect(isExpectedMimeType("  application/pdf ", "application/pdf")).toBe(true);
  });

  it("rejects different media types and empty content types", () => {
    expect(isExpectedMimeType("text/html", "application/pdf")).toBe(false);
    expect(isExpectedMimeType("", "application/pdf")).toBe(false);
  });
});

describe("isSuccessfulStatus", () => {
  it("treats only 2xx as success", () => {
    expect(isSuccessfulStatus(199)).toBe(false);
    expect(isSuccessfulStatus(200)).toBe(true);
    expect(isSuccessfulStatus(299)).toBe(true);
    expect(isSuccessfulStatus(300)).toBe(false);
  });

  it("treats only followable 3xx statuses as redirects", () => {
    expect([301, 302, 303, 307, 308].every(isRedirectStatus)).toBe(true);
    expect([299, 300, 304, 305, 399, 400].some(isRedirectStatus)).toBe(false);
    expect(redirectPreservesMethod(307)).toBe(true);
    expect(redirectPreservesMethod(308)).toBe(true);
    expect(redirectPreservesMethod(303)).toBe(false);
  });
});

describe("redirectTarget", () => {
  it("resolves relative and absolute Location headers against the current hop", () => {
    expect(
      redirectTarget({ status: 302, location: "/next", currentUrl: "https://a.test/x/y", hop: 0 }),
    ).toBe("https://a.test/next");
    expect(
      redirectTarget({
        status: 302,
        location: "//b.test/z",
        currentUrl: "https://a.test/",
        hop: 1,
      }),
    ).toBe("https://b.test/z");
  });

  it("refuses chains without a Location header or beyond the hop limit", () => {
    expect(() =>
      redirectTarget({ status: 302, location: null, currentUrl: "https://a.test/", hop: 0 }),
    ).toThrow("without a Location header");
    expect(() =>
      redirectTarget({
        status: 302,
        location: "/x",
        currentUrl: "https://a.test/",
        hop: MAX_REDIRECT_HOPS,
      }),
    ).toThrow(`exceeded ${MAX_REDIRECT_HOPS} hops`);
  });
});

describe("parseContentLength", () => {
  it("parses non-negative integers and rejects everything else", () => {
    expect(parseContentLength("1024")).toBe(1024);
    expect(parseContentLength("0")).toBe(0);
    expect(parseContentLength("-1")).toBeUndefined();
    expect(parseContentLength("abc")).toBeUndefined();
    expect(parseContentLength(null)).toBeUndefined();
    expect(parseContentLength(undefined)).toBeUndefined();
  });
});

describe("documentBytesProblem", () => {
  const pdf = new TextEncoder().encode("%PDF-1.7 body");

  it("accepts PDF bytes that start with the PDF signature", () => {
    expect(documentBytesProblem(pdf, "application/pdf; charset=binary")).toBeUndefined();
  });

  it("rejects empty payloads and PDFs without a signature", () => {
    expect(documentBytesProblem(new Uint8Array(0), "application/pdf")).toBe(
      "download payload is empty",
    );
    expect(
      documentBytesProblem(new TextEncoder().encode("<html>expired</html>"), "application/pdf"),
    ).toBe("download payload does not carry the application/pdf signature");
    expect(documentBytesProblem(new TextEncoder().encode("%PDF"), "application/pdf")).toBe(
      "download payload does not carry the application/pdf signature",
    );
  });

  it("verifies PNG and JPEG signatures and refuses unsupported media types", () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1]);

    expect(documentBytesProblem(png, "image/png")).toBeUndefined();
    expect(documentBytesProblem(jpeg, "image/jpeg")).toBeUndefined();
    expect(documentBytesProblem(jpeg, "image/png")).toBe(
      "download payload does not carry the image/png signature",
    );
    expect(documentBytesProblem(new TextEncoder().encode("id,amount"), "text/csv")).toBe(
      "download media type text/csv is not a supported evidence format",
    );
  });
});

describe("DownloadTooLargeError", () => {
  it("carries the cap and a stable name", () => {
    const error = new DownloadTooLargeError(1024);

    expect(error.name).toBe("DownloadTooLargeError");
    expect(error.maxBytes).toBe(1024);
    expect(error.message).toBe("download exceeds 1024 byte limit");
  });
});
