/**
 * reports.ts — Bad Actor Reports (Scenario 12, NIP-56)
 *
 * NIP-56 defines kind 1984 — a signed report event targeting a pubkey.
 *
 * Game theory rationale:
 *   Without punishment, defection (scamming) is always rational.
 *   With reports tied to the scammer's pubkey, the cost of scamming grows:
 *   - Reports follow the pubkey across ALL Nostr clients and applications
 *   - A pubkey with many reports loses merchant status across the network
 *   - Creating a new pubkey loses all reputation history
 *   This makes sustained defection irrational for reputation-building actors.
 *
 * KNOWN LIMITATION (from audit):
 *   Reports are social signals — there is no enforcement mechanism.
 *   A scammer with no reputation to protect can simply create a new pubkey.
 *   The system works for actors with established reputation. For new entrants,
 *   combine with Web of Trust verification and identity cost mechanisms.
 */

import { finalizeEvent, verifyEvent } from "nostr-tools";
import { publishToRelays, fetchEvents } from "./relays.js";
import {
  type ReportData,
  type ReportReason,
  type NostrEvent,
  type PublishResult,
  KIND,
  DEFAULT_RELAYS,
} from "./types.js";

// ─── Publish Report ───────────────────────────────────────────────────────────

/**
 * Publish a NIP-56 report event targeting a pubkey.
 *
 * The report is signed by the reporter's key — they stake their own
 * reputation on the report. False reports can themselves be reported.
 *
 * @param data        - Report details (target pubkey, reason, evidence)
 * @param reporterKey - Reporter's private key
 * @param relays      - Relays to publish to (use broad relays for visibility)
 */
export async function publishReport(
  data: ReportData,
  reporterKey: Uint8Array,
  relays: string[] = DEFAULT_RELAYS
): Promise<PublishResult> {
  if (!data.reportedPubkey || data.reportedPubkey.length !== 64) {
    throw new Error("reportedPubkey must be a valid 64-char hex pubkey.");
  }

  const tags: string[][] = [
    // Primary target: the reported pubkey + reason
    ["p", data.reportedPubkey, data.reason],
  ];

  // Optional: reference a specific event as evidence
  if (data.evidenceEventId) {
    if (data.evidenceEventId.length !== 64) {
      throw new Error("evidenceEventId must be a valid 64-char hex event ID.");
    }
    tags.push(["e", data.evidenceEventId, "", "evidence"]);
  }

  const event = finalizeEvent(
    {
      kind: KIND.REPORT, // 1984
      created_at: Math.floor(Date.now() / 1000),
      tags,
      content: data.comment ?? "",
    },
    reporterKey
  );

  if (!verifyEvent(event)) {
    throw new Error("Generated report event has an invalid signature.");
  }

  return publishToRelays(event, relays);
}

// ─── Fetch Reports ────────────────────────────────────────────────────────────

/**
 * Fetch all reports targeting a specific pubkey.
 * Use this to check if a merchant has a bad actor history before transacting.
 */
export async function fetchReportsForPubkey(
  targetPubkey: string,
  relays: string[] = DEFAULT_RELAYS,
  limit = 50
): Promise<NostrEvent[]> {
  return fetchEvents(
    [{ kinds: [KIND.REPORT], "#p": [targetPubkey], limit }],
    relays
  ) as Promise<NostrEvent[]>;
}

/**
 * Fetch reports published by a specific reporter.
 * Use this to evaluate a reporter's history (are they themselves trustworthy?).
 */
export async function fetchReportsByReporter(
  reporterPubkey: string,
  relays: string[] = DEFAULT_RELAYS,
  limit = 50
): Promise<NostrEvent[]> {
  return fetchEvents(
    [
      {
        kinds: [KIND.REPORT],
        authors: [reporterPubkey],
        limit,
      },
    ],
    relays
  ) as Promise<NostrEvent[]>;
}

// ─── Parse Report ─────────────────────────────────────────────────────────────

export interface ParsedReport {
  reporter: string;
  reportedPubkey: string;
  reason: ReportReason | string;
  comment: string;
  evidenceEventId?: string;
  createdAt: number;
  eventId: string;
}

/** Parse a raw kind 1984 report event into a structured object. */
export function parseReport(event: NostrEvent): ParsedReport | null {
  const pTag = event.tags.find((t) => t[0] === "p");
  if (!pTag?.[1]) return null;

  const eTag = event.tags.find(
    (t) => t[0] === "e" && t[3] === "evidence"
  );

  return {
    reporter: event.pubkey,
    reportedPubkey: pTag[1],
    reason: (pTag[2] as ReportReason) ?? "other",
    comment: event.content,
    evidenceEventId: eTag?.[1],
    createdAt: event.created_at,
    eventId: event.id,
  };
}

// ─── Trust Assessment ─────────────────────────────────────────────────────────

export interface TrustAssessment {
  pubkey: string;
  reportCount: number;
  reasons: string[];
  mostRecentReport?: number;
  /** Higher = more reports from unique reporters */
  uniqueReporters: number;
  /** Rough signal: low = trust, high = investigate */
  riskScore: number;
}

/**
 * Quick trust assessment for a pubkey based on their report history.
 * This is a heuristic — not a definitive judgment.
 *
 * riskScore: 0 (no reports) → 10 (many unique reporters with serious reasons)
 */
export async function assessPubkeyTrust(
  pubkey: string,
  relays: string[] = DEFAULT_RELAYS
): Promise<TrustAssessment> {
  const reports = await fetchReportsForPubkey(pubkey, relays);
  const parsed = reports.map(parseReport).filter(Boolean) as ParsedReport[];

  const uniqueReporters = new Set(parsed.map((r) => r.reporter)).size;
  const reasons = [...new Set(parsed.map((r) => r.reason))];
  const mostRecentReport =
    parsed.length > 0
      ? Math.max(...parsed.map((r) => r.createdAt))
      : undefined;

  // Severity weights for reasons
  const severityMap: Record<string, number> = {
    scam: 10,
    illegal: 10,
    impersonation: 8,
    malware: 8,
    spam: 4,
    profanity: 2,
    nudity: 2,
    other: 3,
  };

  const maxSeverity = Math.max(
    0,
    ...reasons.map((r) => severityMap[r] ?? 3)
  );

  // riskScore: combination of unique reporters and severity (0-10 scale)
  const riskScore = Math.min(
    10,
    Math.round((uniqueReporters * maxSeverity) / 10)
  );

  return {
    pubkey,
    reportCount: parsed.length,
    reasons,
    mostRecentReport,
    uniqueReporters,
    riskScore,
  };
}
