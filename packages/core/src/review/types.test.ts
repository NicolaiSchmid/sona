import { describe, expect, it } from "vitest";
import { isReviewState, meetsReviewState } from "./types";

describe("review states", () => {
  it("recognizes valid states", () => {
    expect(isReviewState("user_reviewed")).toBe(true);
    expect(isReviewState("nonsense")).toBe(false);
  });

  it("ranks approval progression", () => {
    expect(meetsReviewState("user_reviewed", "suggested")).toBe(true);
    expect(meetsReviewState("advisor_reviewed", "user_reviewed")).toBe(true);
    expect(meetsReviewState("suggested", "user_reviewed")).toBe(false);
    expect(meetsReviewState("user_reviewed", "user_reviewed")).toBe(true);
  });

  it("never lets a superseded record meet a requirement", () => {
    expect(meetsReviewState("superseded", "draft")).toBe(false);
    expect(meetsReviewState("superseded", "user_reviewed")).toBe(false);
  });

  it("never treats 'superseded' as a satisfiable requirement", () => {
    expect(meetsReviewState("exported", "superseded")).toBe(false);
    expect(meetsReviewState("user_reviewed", "superseded")).toBe(false);
  });
});
