import { describe, expect, it } from "vitest";
import { sonaCoreVersion } from "./index";

describe("sona core", () => {
  it("exports a package marker", () => {
    expect(sonaCoreVersion).toBe("0.0.0");
  });
});
