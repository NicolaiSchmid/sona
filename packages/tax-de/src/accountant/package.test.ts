import { createWorkspaceContext, InMemoryDocumentStorage, sha256Hex } from "@sona/core";
import { describe, expect, it } from "vitest";
import { SAMPLE_DEPRECIATION, SAMPLE_POSTINGS } from "../export/fixtures.js";
import { PACKAGE_FILES } from "../export/package.js";
import { ELSTER_DRAFT_MAPPING_PRIVATE_DE } from "../templates/elster-draft-de.js";
import { PRIVATE_DE_TEMPLATE } from "../templates/private-de.js";
import {
  ACCOUNTANT_MANIFEST_FILE,
  ACCOUNTANT_README_FILE,
  type AccountantPackageDocument,
  type AccountantPackageInput,
  buildAccountantPackage,
  bundledDocumentPath,
  loadAccountantDocuments,
  referencedEvidenceDocumentIds,
} from "./package.js";

const text = (value: string): Uint8Array => new TextEncoder().encode(value);
const decode = (bytes: Uint8Array | undefined): string => new TextDecoder().decode(bytes);

const PDF_BYTES = text("%PDF-1.4 synthetic tax advice invoice");
const DOCS: AccountantPackageDocument[] = [
  {
    id: "doc_1",
    originalFilename: "Rechnung Steuerberater.pdf",
    contentType: "application/pdf",
    bytes: PDF_BYTES,
  },
  {
    id: "doc_2",
    originalFilename: undefined,
    contentType: "image/jpeg",
    bytes: text("jpeg bytes"),
  },
  // Referenced by no included line; it belongs to a `suggested` posting in another fixture set.
  {
    id: "doc_orphan",
    originalFilename: "orphan.pdf",
    contentType: "application/pdf",
    bytes: text("orphan"),
  },
];

const INPUT: AccountantPackageInput = {
  year: 2026,
  postings: SAMPLE_POSTINGS,
  template: PRIVATE_DE_TEMPLATE,
  mapping: ELSTER_DRAFT_MAPPING_PRIVATE_DE,
  depreciation: [SAMPLE_DEPRECIATION],
  generatedAt: "2027-03-01T10:00:00Z",
  documents: DOCS,
  recipientLabel: "Kanzlei Muster",
};

describe("buildAccountantPackage", () => {
  const pkg = buildAccountantPackage(INPUT);
  const byPath = new Map(pkg.files.map((f) => [f.path, f.bytes]));

  it("contains the export package, the ELSTER draft, the README, documents, and the manifest", () => {
    const paths = pkg.files.map((f) => f.path);
    for (const file of PACKAGE_FILES) {
      expect(paths).toContain(file);
    }
    expect(paths).toContain("elster-draft.md");
    expect(paths).toContain("elster-draft.json");
    expect(paths).toContain(ACCOUNTANT_README_FILE);
    expect(paths).toContain(ACCOUNTANT_MANIFEST_FILE);
    expect(paths).toContain("documents.csv");
    expect(paths).toContain("documents/doc_1.pdf");
    expect(paths).toContain("documents/doc_2.jpg");
  });

  it("applies the final review gate", () => {
    expect(decode(byPath.get("tax-categories.csv"))).not.toContain("Charity donation");
    expect(decode(byPath.get("elster-draft.md"))).not.toContain("Charity donation");
    expect(pkg.elsterDraft.requiredReviewState).toBe("user_reviewed");
  });

  it("bundles only originals referenced by an included line and reports the rest", () => {
    expect(pkg.bundledDocuments.map((d) => d.documentId)).toEqual(["doc_1", "doc_2"]);
    expect(pkg.excludedDocumentIds).toEqual(["doc_orphan"]);
    expect(pkg.files.some((f) => f.path.includes("doc_orphan"))).toBe(false);
    expect(pkg.missingDocumentIds).toEqual(["doc_notary"]);
    const bundledBytes = byPath.get("documents/doc_1.pdf");
    expect(bundledBytes !== undefined && Buffer.from(bundledBytes).equals(PDF_BYTES)).toBe(true);
  });

  it("keeps original filenames out of archive paths but in documents.csv", () => {
    expect(pkg.files.some((f) => f.path.includes("Rechnung"))).toBe(false);
    const csv = decode(byPath.get("documents.csv"));
    expect(csv.split("\n")[0]).toBe(
      "documentId,path,originalFilename,contentType,byteLength,sha256",
    );
    expect(csv).toContain(
      `doc_1,documents/doc_1.pdf,Rechnung Steuerberater.pdf,application/pdf,${PDF_BYTES.byteLength},${sha256Hex(PDF_BYTES)}`,
    );
  });

  it("writes a SHA-256 manifest covering every other file", () => {
    const manifest = decode(byPath.get(ACCOUNTANT_MANIFEST_FILE)).trimEnd().split("\n");
    const others = pkg.files.filter((f) => f.path !== ACCOUNTANT_MANIFEST_FILE);
    expect(manifest).toHaveLength(others.length);
    for (const file of others) {
      expect(manifest).toContain(`${sha256Hex(file.bytes)}  ${file.path}`);
    }
    expect(pkg.manifest.map((m) => m.path)).toEqual(others.map((f) => f.path));
  });

  it("addresses the Steuerberater with the review-gate and not-advice wording", () => {
    const readme = decode(byPath.get(ACCOUNTANT_README_FILE));
    expect(readme).toContain("NOT A SUBMISSION");
    expect(readme).toContain("NOT TAX ADVICE");
    expect(readme).toContain("`user_reviewed` or stronger");
    expect(readme).toContain("Prepared for: Kanzlei Muster");
    expect(readme).toContain("Generated: 2027-03-01T10:00:00Z");
    expect(readme).toContain("- Bundled originals: 2");
    expect(readme).toContain("therefore left out: 1");
    expect(readme).toContain("sha256sum -c MANIFEST.sha256");
    expect(readme).not.toMatch(/deductible under/i);
  });

  it("is byte-for-byte deterministic for identical inputs", () => {
    const again = buildAccountantPackage({ ...INPUT, documents: [...DOCS].reverse() });
    expect(again.zipSha256).toBe(pkg.zipSha256);
    expect(Buffer.from(again.zip).equals(Buffer.from(pkg.zip))).toBe(true);
    expect(again.manifest).toEqual(pkg.manifest);
  });

  it("changes the archive hash when any input changes", () => {
    const later = buildAccountantPackage({ ...INPUT, generatedAt: "2027-03-02T10:00:00Z" });
    expect(later.zipSha256).not.toBe(pkg.zipSha256);
    const otherBytes = buildAccountantPackage({
      ...INPUT,
      documents: DOCS.map((d) => (d.id === "doc_1" ? { ...d, bytes: text("different") } : d)),
    });
    expect(otherBytes.zipSha256).not.toBe(pkg.zipSha256);
  });

  it("lists referenced documents that were not supplied as missing", () => {
    const partial = buildAccountantPackage({ ...INPUT, documents: [] });
    expect(partial.missingDocumentIds).toEqual(["doc_1", "doc_2", "doc_notary"]);
    expect(partial.bundledDocuments).toEqual([]);
    expect(decode(partial.files.find((f) => f.path === ACCOUNTANT_README_FILE)?.bytes)).toContain(
      "not available in this package: 3 (doc_1, doc_2, doc_notary)",
    );
  });

  it("rejects a document supplied twice", () => {
    expect(() =>
      buildAccountantPackage({
        ...INPUT,
        documents: [...DOCS, DOCS[0] as AccountantPackageDocument],
      }),
    ).toThrow(/supplied more than once/);
  });
});

describe("bundledDocumentPath", () => {
  it("uses a safe extension from the filename, else from the content type", () => {
    expect(bundledDocumentPath({ id: "d", originalFilename: "a.PDF", contentType: "x/y" })).toBe(
      "documents/d.pdf",
    );
    expect(
      bundledDocumentPath({ id: "d", originalFilename: "noext", contentType: "image/png" }),
    ).toBe("documents/d.png");
    expect(
      bundledDocumentPath({ id: "d", originalFilename: "weird.ex ten", contentType: "x/y" }),
    ).toBe("documents/d.bin");
    expect(
      bundledDocumentPath({ id: "d", originalFilename: undefined, contentType: "application/pdf" }),
    ).toBe("documents/d.pdf");
  });

  it("refuses ids that could escape the documents directory", () => {
    for (const id of ["..", "a/b", "a b", ""]) {
      expect(
        () => bundledDocumentPath({ id, originalFilename: undefined, contentType: "x/y" }),
        id,
      ).toThrow(/safe archive path/);
    }
  });
});

describe("loadAccountantDocuments", () => {
  it("loads referenced originals from DocumentStorage and skips unknown ids", async () => {
    const storage = new InMemoryDocumentStorage();
    const context = createWorkspaceContext({ workspaceId: "ws_1" });
    await storage.put({
      context,
      id: "doc_1",
      bytes: PDF_BYTES,
      contentType: "application/pdf",
      originalFilename: "invoice.pdf",
      createdAt: "2026-04-01T00:00:00Z",
    });
    const ids = referencedEvidenceDocumentIds({
      year: 2026,
      postings: SAMPLE_POSTINGS,
      template: PRIVATE_DE_TEMPLATE,
    });
    expect(ids).toEqual(["doc_1", "doc_2"]);
    const loaded = await loadAccountantDocuments({ storage, context, documentIds: ids });
    expect(loaded.map((d) => d.id)).toEqual(["doc_1"]);
    expect(loaded[0]?.originalFilename).toBe("invoice.pdf");
    expect(loaded[0]?.contentType).toBe("application/pdf");
  });

  it("never reads another workspace's documents", async () => {
    const storage = new InMemoryDocumentStorage();
    await storage.put({
      context: createWorkspaceContext({ workspaceId: "ws_2" }),
      id: "doc_1",
      bytes: PDF_BYTES,
      contentType: "application/pdf",
      createdAt: "2026-04-01T00:00:00Z",
    });
    const loaded = await loadAccountantDocuments({
      storage,
      context: createWorkspaceContext({ workspaceId: "ws_1" }),
      documentIds: ["doc_1"],
    });
    expect(loaded).toEqual([]);
  });
});
