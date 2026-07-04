import type { PortalTask } from "../schema.js";

export const syntheticReferencePortalTask = {
  id: "synthetic-reference-portal",
  name: "Synthetic reference portal invoice fetcher",
  version: 1,
  risk: "read_only_document_fetch",
  domains: ["portal.test"],
  requires: ["credentials"],
  allowedActions: ["navigate", "login", "search_invoices", "download_invoice_pdf"],
  forbiddenActions: ["purchase", "cancel_order", "change_payment_method"],
  outputs: ["document_file", "provenance_json"],
  httpMethodExceptions: [
    {
      method: "POST",
      urlPattern: "https://portal.test/login",
      reason: "login",
      justification: "Portal login form requires POST before read-only invoice access.",
    },
  ],
  steps: [
    {
      kind: "navigate",
      url: "https://portal.test/login",
      sensitive: true,
    },
    {
      kind: "fill",
      selector: "#email",
      credentialKey: "username",
    },
    {
      kind: "fill",
      selector: "#password",
      credentialKey: "password",
      sensitive: true,
    },
    {
      kind: "click",
      selector: "button.login",
    },
    {
      kind: "waitForSelector",
      selector: "[data-testid='invoice-list']",
    },
    {
      kind: "downloadLinks",
      selector: "a.invoice-download",
      hrefAttribute: "href",
      filenameAttribute: "data-filename",
      mimeType: "application/pdf",
    },
  ],
} as const satisfies PortalTask;
