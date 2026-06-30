import { createVerify, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createEnableBankingJwt, decodeJwt, MAX_JWT_TTL_SECONDS } from "./jwt.js";

// A throwaway key generated per test run — never a real Enable Banking key.
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();

describe("createEnableBankingJwt", () => {
  it("builds the expected header and payload", () => {
    const token = createEnableBankingJwt({ applicationId: "app_1", privateKeyPem }, 1000);
    const { header, payload } = decodeJwt(token);

    expect(header).toEqual({ typ: "JWT", alg: "RS256", kid: "app_1" });
    // The app id is the `kid`; the issuer is the documented constant.
    expect(payload.iss).toBe("enablebanking.com");
    expect(payload.aud).toBe("api.enablebanking.com");
    expect(payload.iat).toBe(1000);
    expect(payload.exp).toBe(1000 + 3600);
  });

  it("clamps the lifetime to at most 24h", () => {
    const token = createEnableBankingJwt(
      { applicationId: "app_1", privateKeyPem, ttlSeconds: 999_999 },
      1000,
    );
    const { payload } = decodeJwt(token);
    expect(payload.exp - payload.iat).toBe(MAX_JWT_TTL_SECONDS);
  });

  it("produces a signature verifiable with the public key", () => {
    const token = createEnableBankingJwt({ applicationId: "app_1", privateKeyPem }, 1000);
    const [headerPart, payloadPart, signaturePart] = token.split(".");
    const signingInput = `${headerPart}.${payloadPart}`;
    const ok = createVerify("RSA-SHA256")
      .update(signingInput)
      .verify(publicKeyPem, Buffer.from(signaturePart ?? "", "base64url"));
    expect(ok).toBe(true);
  });

  it("honors a custom audience", () => {
    const token = createEnableBankingJwt(
      { applicationId: "app_1", privateKeyPem, audience: "custom.example" },
      1000,
    );
    expect(decodeJwt(token).payload.aud).toBe("custom.example");
  });
});
