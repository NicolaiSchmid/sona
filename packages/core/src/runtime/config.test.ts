import { describe, expect, it } from "vitest";
import { parseSonaRuntimeConfig, RUNTIME_MODES } from "./config";

const selfHostedConfig = {
  runtime: "self_hosted",
  locale: "de-DE",
  currency: "EUR",
  storage: {
    documents: {
      provider: "filesystem",
      path: "./data/documents",
    },
    database: {
      provider: "sqlite",
      path: "./data/sona.sqlite",
    },
  },
  policies: {
    aiCan: {
      suggestClassifications: true,
      submitTaxReturns: false,
      initiatePayments: false,
    },
    receipts: {
      requireFor: ["Expenses:RealEstate:*", "Expenses:TaxAdvice"],
    },
  },
};

describe("runtime config parser", () => {
  it("defines the supported runtime modes explicitly", () => {
    expect(RUNTIME_MODES).toEqual(["local_dev", "self_hosted", "hosted_cloud"]);
  });

  it("parses a valid self-hosted config without requiring inline secrets", () => {
    const parsed = parseSonaRuntimeConfig(selfHostedConfig);

    expect(parsed.runtime).toBe("self_hosted");
    expect(parsed.storage.documents.provider).toBe("filesystem");
    expect(parsed.storage.database.provider).toBe("sqlite");
    expect(parsed.storage.secrets.provider).toBe("env");
    expect(parsed.policies.aiCan.suggestClassifications).toBe(true);
  });

  it("rejects automatic tax-return submission because no feature flag exists yet", () => {
    expect(() =>
      parseSonaRuntimeConfig({
        ...selfHostedConfig,
        policies: {
          ...selfHostedConfig.policies,
          aiCan: {
            ...selfHostedConfig.policies.aiCan,
            submitTaxReturns: true,
          },
        },
      }),
    ).toThrow(/submitTaxReturns/);
  });

  it("rejects payment initiation by default", () => {
    expect(() =>
      parseSonaRuntimeConfig({
        ...selfHostedConfig,
        policies: {
          ...selfHostedConfig.policies,
          aiCan: {
            ...selfHostedConfig.policies.aiCan,
            initiatePayments: true,
          },
        },
      }),
    ).toThrow(/initiatePayments/);
  });

  it("requires non-filesystem document storage in hosted cloud mode", () => {
    expect(() =>
      parseSonaRuntimeConfig({
        ...selfHostedConfig,
        runtime: "hosted_cloud",
        storage: {
          ...selfHostedConfig.storage,
          secrets: {
            provider: "managed_vault",
            namespace: "prod/sona",
          },
        },
      }),
    ).toThrow(/document storage/);
  });

  it("requires non-plaintext secret backend settings in hosted cloud mode", () => {
    expect(() =>
      parseSonaRuntimeConfig({
        ...selfHostedConfig,
        runtime: "hosted_cloud",
        storage: {
          ...selfHostedConfig.storage,
          documents: {
            provider: "object_storage",
            bucket: "sona-prod-documents",
          },
          secrets: {
            provider: "plaintext_file",
            path: "./data/secrets.json",
          },
        },
      }),
    ).toThrow(/secret backend/);
  });

  it("rejects hosted cloud mode when secret backend settings are omitted", () => {
    expect(() =>
      parseSonaRuntimeConfig({
        ...selfHostedConfig,
        runtime: "hosted_cloud",
        storage: {
          ...selfHostedConfig.storage,
          documents: {
            provider: "object_storage",
            bucket: "sona-prod-documents",
          },
        },
      }),
    ).toThrow(/secret backend/);
  });

  it("parses hosted cloud mode with object storage and managed secret settings", () => {
    const parsed = parseSonaRuntimeConfig({
      ...selfHostedConfig,
      runtime: "hosted_cloud",
      storage: {
        documents: {
          provider: "object_storage",
          bucket: "sona-prod-documents",
        },
        database: {
          provider: "postgres",
          url: "postgres://sona.example.invalid/app",
        },
        secrets: {
          provider: "managed_vault",
          namespace: "prod/sona",
        },
      },
    });

    expect(parsed.runtime).toBe("hosted_cloud");
    expect(parsed.storage.documents.provider).toBe("object_storage");
    expect(parsed.storage.secrets.provider).toBe("managed_vault");
  });
});
