/**
 * Tests for fibonacci.ts — backoff, trust scoring, prerequisite checking.
 */
import { describe, it, expect } from "vitest";
import {
  fibonacciBackoff,
  computeTrustScore,
  checkPrerequisites,
  buildPath,
  SCENARIO_PREREQUISITES,
  MAX_TRUST_SCORE,
  TRUST_WEIGHTS,
} from "../src/fibonacci";

// ── fibonacciBackoff ──────────────────────────────────────────────────────────

describe("fibonacciBackoff", () => {
  it("returns 1000ms for attempt 0", () => {
    expect(fibonacciBackoff(0)).toBe(1_000);
  });

  it("returns 1000ms for attempt 1 (F(2) = 1)", () => {
    expect(fibonacciBackoff(1)).toBe(1_000);
  });

  it("returns 2000ms for attempt 2 (F(3) = 2)", () => {
    expect(fibonacciBackoff(2)).toBe(2_000);
  });

  it("returns 3000ms for attempt 3 (F(4) = 3)", () => {
    expect(fibonacciBackoff(3)).toBe(3_000);
  });

  it("returns 5000ms for attempt 4 (F(5) = 5)", () => {
    expect(fibonacciBackoff(4)).toBe(5_000);
  });

  it("returns 8000ms for attempt 5 (F(6) = 8)", () => {
    expect(fibonacciBackoff(5)).toBe(8_000);
  });

  it("respects maxMs cap", () => {
    // Attempt 10 would be 89s without cap
    expect(fibonacciBackoff(10, 30_000)).toBe(30_000);
  });

  it("each step is greater than or equal to the previous (non-decreasing)", () => {
    for (let i = 1; i < 10; i++) {
      expect(fibonacciBackoff(i)).toBeGreaterThanOrEqual(fibonacciBackoff(i - 1));
    }
  });

  it("grows more predictably than exponential (1.5x) across 8 retries", () => {
    // Fibonacci total delay over 8 retries vs 1.5x exponential
    const fibTotal = Array.from({ length: 8 }, (_, i) => fibonacciBackoff(i)).reduce((a, b) => a + b, 0);
    const expoTotal = Array.from({ length: 8 }, (_, i) => Math.round(1_000 * Math.pow(1.5, i))).reduce((a, b) => a + b, 0);
    // Both are reasonable but Fibonacci stays in a similar order of magnitude
    expect(fibTotal).toBeGreaterThan(0);
    expect(fibTotal).toBeLessThan(expoTotal * 2); // never more than 2x exponential total
  });
});

// ── computeTrustScore ─────────────────────────────────────────────────────────

describe("computeTrustScore", () => {
  const noSignals = {
    nip05Verified: false,
    hasExternalLinks: false,
    hasThirdPartyAssertions: false,
    hasVerifiedReviews: false,
    hasReceivedZaps: false,
    hasCleanReportHistory: false,
  };

  const allSignals = {
    nip05Verified: true,
    hasExternalLinks: true,
    hasThirdPartyAssertions: true,
    hasVerifiedReviews: true,
    hasReceivedZaps: true,
    hasCleanReportHistory: true,
  };

  it("returns 0 when no signals present", () => {
    expect(computeTrustScore(noSignals).score).toBe(0);
  });

  it("returns 20 (MAX_TRUST_SCORE) when all signals present", () => {
    expect(computeTrustScore(allSignals).score).toBe(MAX_TRUST_SCORE);
    expect(MAX_TRUST_SCORE).toBe(20); // 1+1+2+3+5+8
  });

  it("tier is 'unknown' for score 0–1", () => {
    expect(computeTrustScore(noSignals).tier).toBe("unknown");
    expect(computeTrustScore({ ...noSignals, nip05Verified: true }).tier).toBe("unknown");
  });

  it("tier is 'low' for score 2–5", () => {
    const score = computeTrustScore({ ...noSignals, nip05Verified: true, hasExternalLinks: true });
    expect(score.score).toBe(2);
    expect(score.tier).toBe("low");
  });

  it("tier is 'verified' for max score", () => {
    expect(computeTrustScore(allSignals).tier).toBe("verified");
  });

  it("breakdown has 6 entries (one per Fibonacci weight)", () => {
    expect(computeTrustScore(noSignals).breakdown).toHaveLength(6);
  });

  it("earned is 0 for missing signals and equals weight for present signals", () => {
    const result = computeTrustScore({ ...noSignals, nip05Verified: true });
    const nip05Entry = result.breakdown.find(b => b.signal.includes("NIP-05"));
    expect(nip05Entry?.earned).toBe(TRUST_WEIGHTS.nip05Verified);

    const reviewEntry = result.breakdown.find(b => b.signal.includes("reviews"));
    expect(reviewEntry?.earned).toBe(0);
  });

  it("missing array lists signals not yet established", () => {
    const result = computeTrustScore({ ...noSignals, nip05Verified: true });
    expect(result.missing).toHaveLength(5); // all except NIP-05
  });

  it("percentage is 100 when all signals present", () => {
    expect(computeTrustScore(allSignals).percentage).toBe(100);
  });

  it("weights follow Fibonacci sequence: 1, 1, 2, 3, 5, 8", () => {
    const weights = Object.values(TRUST_WEIGHTS);
    expect(weights).toEqual([1, 1, 2, 3, 5, 8]);
  });

  it("higher-weight signals correctly dominate the score", () => {
    // Clean report history (8) alone scores higher than NIP-05 + links + 3rd party (1+1+2=4)
    const heavy = computeTrustScore({ ...noSignals, hasCleanReportHistory: true });
    const light = computeTrustScore({
      ...noSignals,
      nip05Verified: true,
      hasExternalLinks: true,
      hasThirdPartyAssertions: true,
    });
    expect(heavy.score).toBeGreaterThan(light.score);
  });
});

// ── checkPrerequisites ────────────────────────────────────────────────────────

describe("checkPrerequisites", () => {
  it("Scenario 1 (Identity) has no prerequisites", () => {
    const result = checkPrerequisites(1, new Set());
    expect(result.allPrerequisites).toHaveLength(0);
    expect(result.missing).toHaveLength(0);
  });

  it("Scenario 17 (Platform Fees) requires Identity, Zaps, and Prisms transitively", () => {
    const result = checkPrerequisites(17, new Set());
    // Platform Fees (17) → Prisms (14) → Zaps (13) → Direct Payment (7) → Identity (1)
    expect(result.allPrerequisites).toContain(1);
    expect(result.allPrerequisites).toContain(7);
    expect(result.allPrerequisites).toContain(13);
    expect(result.allPrerequisites).toContain(14);
  });

  it("reports no missing when all prerequisites are satisfied", () => {
    const implemented = new Set([1, 7, 13, 14]);
    const result = checkPrerequisites(17, implemented);
    expect(result.missing).toHaveLength(0);
    expect(result.hasSilentRisk).toBe(false);
  });

  it("flags silent risk when a silent-failure prerequisite is missing", () => {
    // Platform Fees without Prisms is a silent failure
    const result = checkPrerequisites(17, new Set([1, 7, 13]));
    expect(result.missing).toContain(14);
    expect(result.hasSilentRisk).toBe(true);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("Scenario 10 (Reviews) requires Proof of Payment (9) which requires Direct Payment (7)", () => {
    const result = checkPrerequisites(10, new Set());
    expect(result.allPrerequisites).toContain(7);
    expect(result.allPrerequisites).toContain(9);
  });

  it("all 22 scenarios have valid prerequisite entries", () => {
    for (let s = 1; s <= 22; s++) {
      expect(SCENARIO_PREREQUISITES[s]).toBeDefined();
      expect(typeof SCENARIO_PREREQUISITES[s].name).toBe("string");
      expect(Array.isArray(SCENARIO_PREREQUISITES[s].requires)).toBe(true);
    }
  });
});

// ── buildPath ─────────────────────────────────────────────────────────────────

describe("buildPath", () => {
  it("Scenario 1 path is just [1]", () => {
    expect(buildPath(1)).toEqual([1]);
  });

  it("Scenario 7 path is [1, 7]", () => {
    expect(buildPath(7)).toEqual([1, 7]);
  });

  it("Scenario 17 path starts with Identity (1) and ends with Platform Fees (17)", () => {
    const path = buildPath(17);
    expect(path[0]).toBe(1);
    expect(path[path.length - 1]).toBe(17);
  });

  it("path never contains duplicates", () => {
    for (let s = 1; s <= 22; s++) {
      const path = buildPath(s);
      expect(new Set(path).size).toBe(path.length);
    }
  });

  it("path for every scenario ends with that scenario number", () => {
    for (let s = 1; s <= 22; s++) {
      const path = buildPath(s);
      expect(path[path.length - 1]).toBe(s);
    }
  });

  it("prerequisites always appear before the scenario in the path", () => {
    for (let s = 1; s <= 22; s++) {
      const path = buildPath(s);
      const info = SCENARIO_PREREQUISITES[s];
      for (const req of info.requires) {
        const reqIdx = path.indexOf(req);
        const sIdx = path.indexOf(s);
        expect(reqIdx).toBeLessThan(sIdx);
      }
    }
  });

  it("Scenario 18 (Zapvertising) path includes both Zaps (13) and Discovery (4)", () => {
    const path = buildPath(18);
    expect(path).toContain(13);
    expect(path).toContain(4);
  });
});