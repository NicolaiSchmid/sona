import { describe, expect, it } from "vitest";
import { toJsonValue } from "./shared.js";

describe("toJsonValue", () => {
  it("drops undefined fields like JSON serialisation does", () => {
    const value = toJsonValue({
      keep: "yes",
      gone: undefined,
      nested: { alsoGone: undefined, nullStays: null },
      list: [1, undefined, "x"],
    });
    expect(value).toEqual({
      keep: "yes",
      nested: { nullStays: null },
      // Arrays keep their length: JSON turns an undefined element into null.
      list: [1, null, "x"],
    });
    expect(value).not.toHaveProperty("gone");
    expect(value).not.toHaveProperty(["nested", "alsoGone"]);
  });

  it("deep-clones so mutating the result never touches the input", () => {
    const input = { attachments: [{ partId: "2", tags: ["a"] }], meta: { count: 1 } };
    const value = toJsonValue(input) as {
      attachments: Array<{ partId: string; tags: string[] }>;
      meta: { count: number };
    };
    expect(value).toEqual(input);
    expect(value).not.toBe(input);
    expect(value.attachments).not.toBe(input.attachments);
    expect(value.attachments[0]).not.toBe(input.attachments[0]);

    value.meta.count = 99;
    value.attachments[0]?.tags.push("b");
    value.attachments.push({ partId: "3", tags: [] });
    expect(input).toEqual({ attachments: [{ partId: "2", tags: ["a"] }], meta: { count: 1 } });
  });

  it("passes primitives and empty containers through", () => {
    expect(toJsonValue("text")).toBe("text");
    expect(toJsonValue(42)).toBe(42);
    expect(toJsonValue(false)).toBe(false);
    expect(toJsonValue(null)).toBeNull();
    expect(toJsonValue([])).toEqual([]);
    expect(toJsonValue({})).toEqual({});
  });
});
