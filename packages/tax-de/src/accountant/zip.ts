/**
 * Minimal, deterministic ZIP writer (PKWARE APPNOTE 4.4.x subset) with no
 * native dependencies: `node:zlib` raw deflate for compression and a local
 * CRC-32. Entries are sorted by path and stamped with a fixed DOS timestamp,
 * so identical inputs produce identical bytes — which is what lets the
 * accountant package's SHA-256 be a stable identity for a share link.
 *
 * Writes only; reading archives is out of scope.
 */
import { deflateRawSync } from "node:zlib";

export interface ZipEntry {
  /** Forward-slash separated path inside the archive; no leading slash. */
  path: string;
  bytes: Uint8Array;
}

const LOCAL_FILE_HEADER = 0x04034b50;
const CENTRAL_DIRECTORY_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
/** Version 2.0: deflate + directory support. */
const VERSION_NEEDED = 20;
/** Bit 11: file names are UTF-8. */
const FLAG_UTF8 = 0x0800;
const METHOD_STORED = 0;
const METHOD_DEFLATED = 8;
/** 1980-01-01 00:00:00 in MS-DOS date/time encoding — the format's epoch. */
const FIXED_DOS_TIME = 0x0000;
const FIXED_DOS_DATE = 0x0021;
/** ZIP32 limits; the accountant package is far below, but fail loudly rather than corrupt. */
const MAX_UINT16 = 0xffff;
const MAX_UINT32 = 0xffffffff;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 (IEEE 802.3) as used by ZIP. */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function assertEntryPath(path: string): void {
  if (path.length === 0 || path.startsWith("/") || path.includes("\\") || path.includes("\0")) {
    throw new Error(`invalid zip entry path ${JSON.stringify(path)}`);
  }
  if (path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`zip entry path must be a normalized relative path: ${JSON.stringify(path)}`);
  }
}

function u16(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0 || value > MAX_UINT16) {
    throw new Error(`${label} exceeds the ZIP32 limit`);
  }
  return value;
}

function u32(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0 || value > MAX_UINT32) {
    throw new Error(`${label} exceeds the ZIP32 limit`);
  }
  return value;
}

interface EncodedEntry {
  name: Uint8Array;
  method: number;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  data: Uint8Array;
  localHeaderOffset: number;
}

function encodeEntry(entry: ZipEntry, offset: number): EncodedEntry {
  assertEntryPath(entry.path);
  const name = new TextEncoder().encode(entry.path);
  u16(name.byteLength, `zip entry name length for ${entry.path}`);
  const deflated = new Uint8Array(deflateRawSync(entry.bytes));
  // Incompressible data is stored as-is; smaller archive, still deterministic.
  const useDeflate = deflated.byteLength < entry.bytes.byteLength;
  return {
    name,
    method: useDeflate ? METHOD_DEFLATED : METHOD_STORED,
    crc: crc32(entry.bytes),
    compressedSize: u32(
      useDeflate ? deflated.byteLength : entry.bytes.byteLength,
      `compressed size of ${entry.path}`,
    ),
    uncompressedSize: u32(entry.bytes.byteLength, `size of ${entry.path}`),
    data: useDeflate ? deflated : entry.bytes,
    localHeaderOffset: u32(offset, "archive size"),
  };
}

class ByteWriter {
  readonly #chunks: Uint8Array[] = [];
  #length = 0;

  get length(): number {
    return this.#length;
  }

  u16(value: number): void {
    const view = new Uint8Array(2);
    new DataView(view.buffer).setUint16(0, value, true);
    this.bytes(view);
  }

  u32(value: number): void {
    const view = new Uint8Array(4);
    new DataView(view.buffer).setUint32(0, value, true);
    this.bytes(view);
  }

  bytes(value: Uint8Array): void {
    this.#chunks.push(value);
    this.#length += value.byteLength;
  }

  finish(): Uint8Array {
    const out = new Uint8Array(this.#length);
    let position = 0;
    for (const chunk of this.#chunks) {
      out.set(chunk, position);
      position += chunk.byteLength;
    }
    return out;
  }
}

function writeLocalHeader(out: ByteWriter, entry: EncodedEntry): void {
  out.u32(LOCAL_FILE_HEADER);
  out.u16(VERSION_NEEDED);
  out.u16(FLAG_UTF8);
  out.u16(entry.method);
  out.u16(FIXED_DOS_TIME);
  out.u16(FIXED_DOS_DATE);
  out.u32(entry.crc);
  out.u32(entry.compressedSize);
  out.u32(entry.uncompressedSize);
  out.u16(entry.name.byteLength);
  out.u16(0); // extra field length
  out.bytes(entry.name);
  out.bytes(entry.data);
}

function writeCentralHeader(out: ByteWriter, entry: EncodedEntry): void {
  out.u32(CENTRAL_DIRECTORY_HEADER);
  out.u16(VERSION_NEEDED); // version made by
  out.u16(VERSION_NEEDED); // version needed to extract
  out.u16(FLAG_UTF8);
  out.u16(entry.method);
  out.u16(FIXED_DOS_TIME);
  out.u16(FIXED_DOS_DATE);
  out.u32(entry.crc);
  out.u32(entry.compressedSize);
  out.u32(entry.uncompressedSize);
  out.u16(entry.name.byteLength);
  out.u16(0); // extra field length
  out.u16(0); // file comment length
  out.u16(0); // disk number start
  out.u16(0); // internal attributes
  out.u32(0); // external attributes
  out.u32(entry.localHeaderOffset);
  out.bytes(entry.name);
}

/**
 * Builds a ZIP archive. Entries are sorted by path; duplicate paths are
 * rejected because two files at one path would make the archive ambiguous.
 */
export function createZip(entries: readonly ZipEntry[]): Uint8Array {
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]?.path === sorted[i - 1]?.path) {
      throw new Error(`duplicate zip entry path ${JSON.stringify(sorted[i]?.path)}`);
    }
  }
  u16(sorted.length, "zip entry count");

  const out = new ByteWriter();
  const encoded: EncodedEntry[] = [];
  for (const entry of sorted) {
    const item = encodeEntry(entry, out.length);
    writeLocalHeader(out, item);
    encoded.push(item);
  }

  const centralDirectoryOffset = u32(out.length, "archive size");
  for (const item of encoded) {
    writeCentralHeader(out, item);
  }
  const centralDirectorySize = u32(out.length - centralDirectoryOffset, "central directory size");

  out.u32(END_OF_CENTRAL_DIRECTORY);
  out.u16(0); // this disk
  out.u16(0); // disk with central directory
  out.u16(encoded.length);
  out.u16(encoded.length);
  out.u32(centralDirectorySize);
  out.u32(centralDirectoryOffset);
  out.u16(0); // comment length
  return out.finish();
}
