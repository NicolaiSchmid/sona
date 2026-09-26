import { inflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { crc32, createZip, type ZipEntry } from "./zip.js";

const text = (value: string): Uint8Array => new TextEncoder().encode(value);

/** Minimal reader for the archives this writer produces, to verify structure. */
function readZip(bytes: Uint8Array): Array<{ path: string; bytes: Uint8Array; method: number }> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = bytes.byteLength - 22;
  expect(view.getUint32(eocd, true)).toBe(0x06054b50);
  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const entries: Array<{ path: string; bytes: Uint8Array; method: number }> = [];
  for (let i = 0; i < count; i++) {
    expect(view.getUint32(offset, true)).toBe(0x02014b50);
    const method = view.getUint16(offset + 10, true);
    const crc = view.getUint32(offset + 16, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const localOffset = view.getUint32(offset + 42, true);
    const path = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    expect(view.getUint32(localOffset, true)).toBe(0x04034b50);
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const data = bytes.subarray(dataStart, dataStart + compressedSize);
    const content = method === 8 ? new Uint8Array(inflateRawSync(data)) : data;
    expect(crc32(content)).toBe(crc);
    entries.push({ path, bytes: content, method });
    offset += 46 + nameLength;
  }
  return entries;
}

describe("crc32", () => {
  it("matches the reference value for the classic test vector", () => {
    expect(crc32(text("123456789")).toString(16)).toBe("cbf43926");
    expect(crc32(new Uint8Array(0))).toBe(0);
  });
});

describe("createZip", () => {
  const entries: ZipEntry[] = [
    { path: "b/second.txt", bytes: text("second ".repeat(50)) },
    { path: "a.txt", bytes: text("hello") },
  ];

  it("round-trips entries sorted by path with correct CRCs", () => {
    const read = readZip(createZip(entries));
    expect(read.map((e) => e.path)).toEqual(["a.txt", "b/second.txt"]);
    expect(new TextDecoder().decode(read[0]?.bytes)).toBe("hello");
    expect(new TextDecoder().decode(read[1]?.bytes)).toBe("second ".repeat(50));
  });

  it("stores incompressible data and deflates compressible data", () => {
    const read = readZip(createZip(entries));
    expect(read.find((e) => e.path === "a.txt")?.method).toBe(0);
    expect(read.find((e) => e.path === "b/second.txt")?.method).toBe(8);
  });

  it("is byte-for-byte deterministic regardless of input order", () => {
    const a = createZip(entries);
    const b = createZip([...entries].reverse());
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it("stamps the fixed 1980-01-01 timestamp instead of the current time", () => {
    const bytes = createZip([{ path: "a.txt", bytes: text("x") }]);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(view.getUint16(10, true)).toBe(0x0000);
    expect(view.getUint16(12, true)).toBe(0x0021);
  });

  it("rejects duplicate and unsafe paths", () => {
    expect(() =>
      createZip([
        { path: "a", bytes: text("1") },
        { path: "a", bytes: text("2") },
      ]),
    ).toThrow(/duplicate zip entry path/);
    for (const path of ["/abs", "a/../b", "./a", "a//b", "a\\b", ""]) {
      expect(() => createZip([{ path, bytes: text("x") }]), path).toThrow(/zip entry path/);
    }
  });

  it("produces an empty but valid archive for no entries", () => {
    const bytes = createZip([]);
    expect(bytes.byteLength).toBe(22);
    expect(readZip(bytes)).toEqual([]);
  });
});
