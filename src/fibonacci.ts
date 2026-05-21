/**
 * fibonacci.ts — Fibonacci-aware commerce utilities
 *
 * Three implementations derived from the Fibonacci structure of the 22 scenarios:
 *
 * 1. fibonacciBackoff()     — Retry delays following the Fibonacci sequence.
 *                             Gentler ramp up than exponential (1.5×). Better
 *                             for Lightning relay pressure and wallet rate limits.
 *
 * 2. computeTrustScore()    — Trust signals weighted by Fibonacci values.
 *                             Each signal is worth more because it requires
 *                             the previous ones to exist naturally. A merchant
 *                             cannot have 5-point zap endorsements without first
 *                             having a 1-point domain and real buyers to zap them.
 *
 * 3. SCENARIO_PREREQUISITES — Formal dependency map for all 22 scenarios.
 *                             Agents use this to detect missing layers before
 *                             implementing a requested scenario — preventing
 *                             silent failures like valid-looking-but-broken escrow,
 *                             fake-passing reviews, and $0 platform fees.
 */

// ─── Fibonacci Sequence ───────────────────────────────────────────────────────

/** First 16 Fibonacci numbers in milliseconds (×1000) for backoff use. */
const FIB_SECONDS = [1, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233, 377, 610, 987];

/**
 * Fibonacci backoff delay for a given attempt number.
 *
 * Attempt 0 →  1s
 * Attempt 1 →  1s
 * Attempt 2 →  2s
 * Attempt 3 →  3s
 * Attempt 4 →  5s
 * Attempt 5 →  8s
 * Attempt 6 → 13s
 * Attempt 7 → 21s  ← typical max for Lightning retries
 *
 * Capped at maxMs (default: 60s) to prevent indefinite lockout.
 * Gentler than 1.5× exponential for the first 6 retries — avoids
 * flooding NWC endpoints when a wallet is temporarily unreachable.
 *
 * @example
 *   for (let attempt = 0; attempt < 8; attempt++) {
 *     try { return await wallet.payInvoice(invoice); }
 *     catch { await sleep(fibonacciBackoff(attempt)); }
 *   }
 */
export function fibonacciBackoff(attempt: number, maxMs = 60_000): number {
  const idx = Math.min(attempt, FIB_SECONDS.length - 1);
  return Math.min(FIB_SECONDS[idx] * 1_000, maxMs);
}

/**
 * Sleep for the Fibonacci backoff duration at `attempt`.
 * Drop-in replacement for any retry loop.
 */
export function fibonacciSleep(attempt: number, maxMs = 60_000): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, fibonacciBackoff(attempt, maxMs)));
}

// ─── Trust Score ──────────────────────────────────────────────────────────────

/**
 * Input signals for computeTrustScore().
 * Collect these from verifyIdentity(), fetchVerifiedReviews(),
 * summarizeZaps(), and assessPubkeyTrust().
 */
export interface TrustSignals {
  /** NIP-05: merchant controls a domain (user@domain.com verified). Weight: 1 */
  nip05Verified: boolean;
  /** NIP-39: at least one linked external identity (GitHub, Twitter, etc.). Weight: 1 */
  hasExternalLinks: boolean;
  /** NIP-85: at least one trusted third party assertion for this pubkey. Weight: 2 */
  hasThirdPartyAssertions: boolean;
  /** Kind 31990: at least one review verified by a real payment preimage. Weight: 3 */
  hasVerifiedReviews: boolean;
  /** NIP-57: at least one zap receipt on their listings — real sats from real people. Weight: 5 */
  hasReceivedZaps: boolean;
  /** NIP-56: zero kind-1984 reports against this pubkey across known relays. Weight: 8 */
  hasCleanReportHistory: boolean;
}

/**
 * Fibonacci weights for each trust signal.
 *
 * 1, 1, 2, 3, 5, 8 — each signal is harder to fake than the previous.
 * A scammer can fake a domain (weight 1). They cannot fake 50 buyers
 * paying with real Lightning preimages (weight 3) or years of clean
 * reputation with real zap endorsements (weight 5 + 8).
 *
 * Maximum score: 1+1+2+3+5+8 = 20
 */
export const TRUST_WEIGHTS = {
  nip05Verified:          1,  // F(1): easiest signal — own a domain
  hasExternalLinks:       1,  // F(2): corroborates across platforms
  hasThirdPartyAssertions:2,  // F(3): someone trusted vouched for you
  hasVerifiedReviews:     3,  // F(4): real buyers with payment preimages
  hasReceivedZaps:        5,  // F(5): community spent real sats to endorse
  hasCleanReportHistory:  8,  // F(6): sustained trustworthy behaviour
} as const;

export const MAX_TRUST_SCORE = Object.values(TRUST_WEIGHTS).reduce((a, b) => a + b, 0); // 20

export interface TrustScore {
  score: number;        // 0–20
  max: number;          // always 20
  percentage: number;   // 0–100
  tier: "unknown" | "low" | "moderate" | "high" | "verified";
  breakdown: { signal: string; earned: number; weight: number }[];
  missing: string[];    // signals not yet established
}

/**
 * Compute a Fibonacci weighted trust score (0–20) for a merchant.
 *
 * The tiers map to actionable UX decisions:
 *   unknown   (0–1):   No trust signals. Show a warning.
 *   low       (2–5):   Basic identity only. Suggest escrow.
 *   moderate  (6–10):  Some verification. Reasonable for small orders.
 *   high     (11–17):  Strong multi-signal trust. Safe for most orders.
 *   verified (18–20):  All signals present. Waive escrow requirement.
 *
 * @example
 *   const verification = await verifyIdentity(merchantPubkey);
 *   const reviews = await fetchVerifiedReviews(merchantPubkey, 'pubkey');
 *   const zaps = await fetchZapReceipts(merchantPubkey);
 *   const trust = await assessPubkeyTrust(merchantPubkey);
 *
 *   const score = computeTrustScore({
 *     nip05Verified: verification.nip05Valid,
 *     hasExternalLinks: verification.externalLinks.length > 0,
 *     hasThirdPartyAssertions: verification.attestations.length > 0,
 *     hasVerifiedReviews: reviews.some(r => r.isVerified),
 *     hasReceivedZaps: zaps.length > 0,
 *     hasCleanReportHistory: trust.reportCount === 0,
 *   });
 *
 *   if (score.tier === 'unknown' || score.tier === 'low') {
 *     suggestEscrow(); // protect buyer
 *   }
 */
export function computeTrustScore(signals: TrustSignals): TrustScore {
  const breakdown: TrustScore["breakdown"] = [];
  const missing: string[] = [];
  let score = 0;

  const entries: [keyof TrustSignals, keyof typeof TRUST_WEIGHTS, string][] = [
    ["nip05Verified",           "nip05Verified",           "NIP-05 domain verification"],
    ["hasExternalLinks",        "hasExternalLinks",        "NIP-39 external identity links"],
    ["hasThirdPartyAssertions", "hasThirdPartyAssertions", "NIP-85 third party assertions"],
    ["hasVerifiedReviews",      "hasVerifiedReviews",      "Preimage-verified reviews"],
    ["hasReceivedZaps",         "hasReceivedZaps",         "Zap endorsements (NIP-57)"],
    ["hasCleanReportHistory",   "hasCleanReportHistory",   "Clean report history (NIP-56)"],
  ];

  for (const [signal, weightKey, label] of entries) {
    const weight = TRUST_WEIGHTS[weightKey];
    const earned = signals[signal] ? weight : 0;
    score += earned;
    breakdown.push({ signal: label, earned, weight });
    if (!signals[signal]) missing.push(label);
  }

  const percentage = Math.round((score / MAX_TRUST_SCORE) * 100);

  let tier: TrustScore["tier"];
  if (score <= 1)  tier = "unknown";
  else if (score <= 5)  tier = "low";
  else if (score <= 10) tier = "moderate";
  else if (score <= 17) tier = "high";
  else tier = "verified";

  return { score, max: MAX_TRUST_SCORE, percentage, tier, breakdown, missing };
}

// ─── Scenario Prerequisites ───────────────────────────────────────────────────

export interface ScenarioInfo {
  name: string;
  requires: number[];  // Scenario numbers that must be in place first
  layer: number;       // Fibonacci depth in the dependency graph
  riskIfMissing: "silent" | "loud";
  // silent: compiles and runs but produces wrong outcome (worst kind)
  // loud: throws an error immediately (at least you know)
}

/**
 * Formal prerequisite map for all 22 scenarios.
 *
 * The dependency graph has 5 layers — each layer is the sum of
 * the two preceding (Fibonacci like structure):
 *
 *   Layer 0: 1 scenario  (Identity — the root)
 *   Layer 1: 5 scenarios (build on identity)
 *   Layer 2: 11 scenarios (build on layer 1)
 *   Layer 3: 4 scenarios (build on layer 2)
 *   Layer 4: 1 scenario  (Platform Fees — deepest leaf)
 *
 * Why this matters: implementing a scenario without its prerequisites
 * either fails loudly (throws) or silently produces wrong outcomes.
 * Silent failures are the dangerous ones: escrow that looks active but
 * isn't tracked, platform fees that compute to $0, reviews that
 * pass verification checks but prove nothing.
 */
export const SCENARIO_PREREQUISITES: Record<number, ScenarioInfo> = {
  1:  { name: "Identity",           requires: [],        layer: 0, riskIfMissing: "loud" },
  2:  { name: "Listings",           requires: [1],       layer: 1, riskIfMissing: "loud" },
  3:  { name: "Expiration",         requires: [2],       layer: 2, riskIfMissing: "silent" },
  4:  { name: "Discovery",          requires: [2],       layer: 2, riskIfMissing: "loud" },
  5:  { name: "Verification",       requires: [1],       layer: 1, riskIfMissing: "silent" },
  6:  { name: "Encrypted Orders",   requires: [1],       layer: 1, riskIfMissing: "loud" },
  7:  { name: "Direct Payment",     requires: [1],       layer: 1, riskIfMissing: "loud" },
  8:  { name: "Escrow",             requires: [7],       layer: 2, riskIfMissing: "silent" },
  9:  { name: "Proof of Payment",   requires: [7],       layer: 2, riskIfMissing: "silent" },
  10: { name: "Reviews",            requires: [9],       layer: 3, riskIfMissing: "silent" },
  11: { name: "Product Q&A",        requires: [2],       layer: 2, riskIfMissing: "loud" },
  12: { name: "Report Bad Actor",   requires: [1],       layer: 1, riskIfMissing: "loud" },
  13: { name: "Zaps",               requires: [7],       layer: 2, riskIfMissing: "loud" },
  14: { name: "Payment Prisms",     requires: [13],      layer: 3, riskIfMissing: "silent" },
  15: { name: "Subscriptions",      requires: [7],       layer: 2, riskIfMissing: "loud" },
  16: { name: "multi merchant Cart",requires: [7, 2],    layer: 2, riskIfMissing: "loud" },
  17: { name: "Platform Fees",      requires: [14],      layer: 4, riskIfMissing: "silent" },
  18: { name: "Zapvertising",       requires: [13, 4],   layer: 3, riskIfMissing: "silent" },
  19: { name: "Fiat Conversion",    requires: [2],       layer: 2, riskIfMissing: "silent" },
  20: { name: "Paid APIs (L402)",   requires: [7],       layer: 2, riskIfMissing: "loud" },
  21: { name: "Notifications",      requires: [6],       layer: 2, riskIfMissing: "loud" },
  22: { name: "Disputes",           requires: [9],       layer: 3, riskIfMissing: "silent" },
};

/**
 * Check whether all prerequisites for a scenario are satisfied.
 *
 * Returns the full prerequisite chain (transitive), the missing
 * scenarios, and whether any missing prerequisite risks silent failure.
 *
 * @example
 *   // Developer wants to add Platform Fees (17).
 *   // They already have Identity (1) and Direct Payment (7).
 *   const check = checkPrerequisites(17, new Set([1, 7]));
 *   // → missing: [13 (Zaps), 14 (Payment Prisms)]
 *   // → hasSilentRisk: true  ← warn the developer
 */
export function checkPrerequisites(
  scenarioNumber: number,
  implementedScenarios: Set<number>
): {
  allPrerequisites: number[];
  missing: number[];
  hasSilentRisk: boolean;
  warnings: string[];
} {
  // Collect transitive prerequisites
  const allPrerequisites = new Set<number>();

  function collect(n: number) {
    const info = SCENARIO_PREREQUISITES[n];
    if (!info) return;
    for (const req of info.requires) {
      if (!allPrerequisites.has(req)) {
        allPrerequisites.add(req);
        collect(req);
      }
    }
  }
  collect(scenarioNumber);

  const missing = [...allPrerequisites].filter(n => !implementedScenarios.has(n));

  const warnings: string[] = [];
  let hasSilentRisk = false;

  for (const m of missing) {
    const info = SCENARIO_PREREQUISITES[m];
    if (info?.riskIfMissing === "silent") {
      hasSilentRisk = true;
      warnings.push(
        `Scenario ${m} (${info.name}) is missing and risks SILENT failure ` +
        `in Scenario ${scenarioNumber} — code will run but produce wrong outcomes.`
      );
    } else {
      warnings.push(
        `Scenario ${m} (${info?.name ?? "unknown"}) is missing — ` +
        `Scenario ${scenarioNumber} will throw at runtime.`
      );
    }
  }

  return {
    allPrerequisites: [...allPrerequisites].sort((a, b) => a - b),
    missing: missing.sort((a, b) => a - b),
    hasSilentRisk,
    warnings,
  };
}

/**
 * Given a target scenario, return the minimal ordered build path.
 * Gives an agent the correct implementation sequence — Layer 0 first.
 *
 * @example
 *   buildPath(17) → [1, 7, 13, 14, 17]
 *   // "Implement Identity, then Direct Payment, then Zaps,
 *   //  then Payment Prisms, then Platform Fees."
 */
export function buildPath(scenarioNumber: number): number[] {
  const visited = new Set<number>();
  const result: number[] = [];

  function visit(n: number) {
    if (visited.has(n)) return;
    visited.add(n);
    const info = SCENARIO_PREREQUISITES[n];
    if (info) {
      // Sort prerequisites by layer (ascending) so lower layers come first
      const sorted = [...info.requires].sort(
        (a, b) => SCENARIO_PREREQUISITES[a].layer - SCENARIO_PREREQUISITES[b].layer
      );
      for (const req of sorted) visit(req);
    }
    result.push(n);
  }

  visit(scenarioNumber);
  return result;
}