import { describe, expect, it } from "vitest";
import { sha256Hex, stableJsonHash } from "./hash";

describe("sha256Hex", () => {
  it("hashes strings and bytes to lowercase hex", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });
});

describe("stableJsonHash", () => {
  it("is independent of object key order", () => {
    expect(stableJsonHash({ a: 1, b: 2 })).toBe(stableJsonHash({ b: 2, a: 1 }));
  });

  it("distinguishes different values", () => {
    expect(stableJsonHash({ a: 1 })).not.toBe(stableJsonHash({ a: 2 }));
  });

  it("ignores undefined object members (matching JSON semantics)", () => {
    expect(stableJsonHash({ a: 1, b: undefined as never })).toBe(stableJsonHash({ a: 1 }));
  });

  it("throws on non-JSON values rather than silently coercing them", () => {
    // Dates, Maps, and class instances would lose their JSON meaning here.
    expect(() => stableJsonHash(new Date() as never)).toThrow(TypeError);
    expect(() => stableJsonHash(new Map() as never)).toThrow(TypeError);
    expect(() => stableJsonHash(Number.NaN as never)).toThrow(TypeError);
  });
});
