import { describe, expect, it } from "vitest";
import { DownloadTooLargeError, parseContentLength, readBodyWithLimit } from "./download.js";

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
