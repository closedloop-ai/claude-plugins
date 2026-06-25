import { describe, it, expect } from "vitest";
import { PRICING, costOf, modelFamily, addInto, emptyTokenCounts, type TokenCounts } from "./pricing.js";

describe("modelFamily", () => {
  it("maps known model ids to families", () => {
    expect(modelFamily("claude-opus-4-8")).toBe("opus");
    expect(modelFamily("claude-opus-4-8[1m]")).toBe("opus");
    expect(modelFamily("claude-sonnet-4-6")).toBe("sonnet");
    expect(modelFamily("claude-haiku-4-5-20251001")).toBe("haiku");
  });

  it("prices fable at the opus tier", () => {
    expect(modelFamily("claude-fable-5")).toBe("opus");
  });

  it("returns null for unpriceable / missing ids", () => {
    expect(modelFamily("gpt-5")).toBeNull();
    expect(modelFamily(undefined)).toBeNull();
    expect(modelFamily(null)).toBeNull();
    expect(modelFamily("")).toBeNull();
  });
});

describe("costOf", () => {
  it("charges output at the family output rate", () => {
    const t: TokenCounts = { ...emptyTokenCounts(), output: 1_000_000 };
    expect(costOf("opus", t)).toBeCloseTo(75.0, 6);
    expect(costOf("sonnet", t)).toBeCloseTo(15.0, 6);
    expect(costOf("haiku", t)).toBeCloseTo(5.0, 6);
  });

  it("charges cache read at 0.1x input (opus)", () => {
    const t: TokenCounts = { ...emptyTokenCounts(), cacheRead: 1_000_000 };
    expect(costOf("opus", t)).toBeCloseTo(PRICING.opus.cacheRead, 6);
    expect(costOf("opus", t)).toBeCloseTo(1.5, 6);
  });

  it("charges 1h cache writes at 2x input and 5m at 1.25x", () => {
    expect(costOf("opus", { ...emptyTokenCounts(), cacheWrite1h: 1_000_000 })).toBeCloseTo(30.0, 6);
    expect(costOf("opus", { ...emptyTokenCounts(), cacheWrite5m: 1_000_000 })).toBeCloseTo(18.75, 6);
  });

  it("sums all token kinds", () => {
    const t: TokenCounts = { input: 1_000_000, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 1_000_000, output: 1_000_000 };
    // opus: 15 + 1.5 + 75 = 91.5
    expect(costOf("opus", t)).toBeCloseTo(91.5, 6);
  });
});

describe("addInto", () => {
  it("accumulates per-kind in place", () => {
    const dst = emptyTokenCounts();
    addInto(dst, { input: 1, cacheWrite5m: 2, cacheWrite1h: 3, cacheRead: 4, output: 5 });
    addInto(dst, { input: 10, cacheWrite5m: 20, cacheWrite1h: 30, cacheRead: 40, output: 50 });
    expect(dst).toEqual({ input: 11, cacheWrite5m: 22, cacheWrite1h: 33, cacheRead: 44, output: 55 });
  });
});
