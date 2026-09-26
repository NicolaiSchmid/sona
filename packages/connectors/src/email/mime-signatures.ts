/**
 * Byte-signature checks for the document types the email source stores. The
 * Content-Type header is sender-controlled, so this is the write-boundary
 * guard against storing e.g. HTML labelled as `application/pdf`.
 */

/** Signatures at offset 0; any one matching is enough. */
const SIGNATURES_AT_START: Readonly<Record<string, ReadonlyArray<readonly number[]>>> = {
  "image/jpeg": [[0xff, 0xd8, 0xff]],
  "image/png": [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  "image/tiff": [
    [0x49, 0x49, 0x2a, 0x00],
    [0x4d, 0x4d, 0x00, 0x2a],
  ],
};

const PDF_HEADER = "%PDF-";
/** The PDF header may be preceded by up to 1024 bytes of junk (ISO 32000, Annex H). */
const PDF_HEADER_WINDOW = 1024;

/** Byte-preserving text view for header/brand comparisons; stateless, so shared. */
const LATIN1 = new TextDecoder("latin1");

const RIFF = [0x52, 0x49, 0x46, 0x46] as const;
const WEBP = [0x57, 0x45, 0x42, 0x50] as const;
/** ISO base media files (HEIC/HEIF) carry an `ftyp` box at offset 4. */
const FTYP = [0x66, 0x74, 0x79, 0x70] as const;
/** Major brands used by HEIF-family still images (ISO/IEC 23008-12). */
const HEIF_BRANDS: ReadonlySet<string> = new Set([
  "heic",
  "heix",
  "hevc",
  "hevx",
  "heim",
  "heis",
  "mif1",
  "msf1",
  "heif",
]);

/**
 * Returns true when `bytes` carry the signature of the declared type. Types
 * without a known signature are accepted as declared.
 */
export function matchesDeclaredMimeType(bytes: Uint8Array, mimeType: string): boolean {
  const type = mimeType.toLowerCase();
  switch (type) {
    case "application/pdf": {
      const head = LATIN1.decode(bytes.subarray(0, PDF_HEADER_WINDOW + PDF_HEADER.length));
      return head.includes(PDF_HEADER);
    }
    case "image/webp":
      return startsWith(bytes, RIFF) && startsWith(bytes.subarray(8), WEBP);
    case "image/heic":
    case "image/heif":
      // Any ISO-BMFF file has `ftyp`; the brand at offset 8 separates HEIF from MP4/MOV.
      return (
        startsWith(bytes.subarray(4), FTYP) && HEIF_BRANDS.has(LATIN1.decode(bytes.subarray(8, 12)))
      );
    default: {
      const signatures = SIGNATURES_AT_START[type];
      return (
        signatures === undefined || signatures.some((signature) => startsWith(bytes, signature))
      );
    }
  }
}

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  return signature.every((byte, index) => bytes[index] === byte);
}
