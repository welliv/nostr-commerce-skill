/**
 * zapvertising.ts - Incentivized Advertising (Scenario 18)
 *
 * NIPs: NIP-57 (zap delivery), NIP-50 (audience search)
 * Lightning: Direct sats-to-viewer payment model
 *
 * Traditional advertising: Meta takes your budget, interrupts users,
 * nobody wins except the platform.
 *
 * Zapvertising: Advertiser finds audience via NIP-50 search,
 * zaps them directly with a message. Viewer receives sats.
 * They can ignore the ad - they keep the sats either way.
 * Attention economy inverted: pay the viewer, not the middleman.
 */

import { fetchEvents } from "./relays.js";
import {
  resolveLnurlFromProfile,
  requestZapInvoice,
  type ParsedZap,
  parseZapReceipt,
  fetchZapReceipts,
} from "./zaps.js";
import { NostrWalletConnect } from "./nwc.js";
import {
  type NostrEvent,
  KIND,
  SEARCH_RELAYS,
  DEFAULT_RELAYS,
} from "./types.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ZapvertiseParams {
  /** Search query to find target audience */
  audienceQuery: string;
  /** Ad message to include with the zap */
  message: string;
  /** Amount to zap each viewer (msats) */
  amountPerViewerMsats: number;
  /** Max viewers to reach (budget control) */
  maxViewers: number;
  /** Minimum account age in days (filters bots) */
  minAccountAgeDays?: number;
}

export interface ZapvertiseResult {
  reached: number;
  totalSpentMsats: number;
  failed: number;
  viewers: { pubkey: string; status: "zapped" | "no_lnurl" | "failed"; amountMsats?: number }[];
}

// ─── Find Audience ────────────────────────────────────────────────────────────

/**
 * Search for potential audience members using NIP-50.
 * Returns pubkeys of users who have posted about the search topic.
 *
 * Note: NIP-50 search is relay-dependent. Use SEARCH_RELAYS (nostr.band, primal).
 * The quality of audience targeting depends on relay search implementation.
 */
export async function findAudience(
  query: string,
  maxResults = 50,
  relays: string[] = SEARCH_RELAYS
): Promise<string[]> {
  const events = await fetchEvents(
    [{ kinds: [KIND.TEXT_NOTE, KIND.METADATA], search: query, limit: maxResults }],
    relays
  );

  // Deduplicate by pubkey
  const pubkeys = [...new Set(events.map(e => e.pubkey))];
  return pubkeys.slice(0, maxResults);
}

// ─── Run Zapvertise Campaign ───────────────────────────────────────────────────

/**
 * Run a zapvertising campaign:
 *   1. Find audience via NIP-50 search
 *   2. For each viewer: resolve their Lightning address
 *   3. Zap them with your message
 *
 * The viewer receives sats whether or not they engage with the message.
 * This is the honest attention economy: you pay for attention,
 * not the impression of attention.
 *
 * Budget protection: stops after maxViewers is reached.
 */
export async function runZapvertiseCampaign(
  params: ZapvertiseParams,
  advertiserWallet: NostrWalletConnect,
  advertiserPrivkey: Uint8Array,
  relays: string[] = DEFAULT_RELAYS
): Promise<ZapvertiseResult> {
  const totalBudgetMsats = params.amountPerViewerMsats * params.maxViewers;
  const balance = await advertiserWallet.getBalance();

  if (balance.msats < totalBudgetMsats) {
    throw new Error(
      `Insufficient balance for campaign.\n` +
      `Budget needed: ${Math.floor(totalBudgetMsats / 1000)} sats\n` +
      `Wallet balance: ${balance.sats} sats`
    );
  }

  // Find audience
  const audience = await findAudience(params.audienceQuery, params.maxViewers * 3, SEARCH_RELAYS);
  const viewers: ZapvertiseResult["viewers"] = [];
  let reached = 0, totalSpentMsats = 0, failed = 0;

  for (const pubkey of audience) {
    if (reached >= params.maxViewers) break;

    // Resolve viewer's Lightning address
    const lnurlEndpoint = await resolveLnurlFromProfile(pubkey, relays);
    if (!lnurlEndpoint) {
      viewers.push({ pubkey, status: "no_lnurl" });
      continue;
    }

    try {
      // Get invoice from viewer's LNURL
      const { invoice } = await requestZapInvoice(
        {
          recipients: [{ pubkey }],
          amountMsats: params.amountPerViewerMsats,
          comment: params.message,
          relays,
        },
        advertiserPrivkey,
        lnurlEndpoint
      );

      // Pay the viewer
      await advertiserWallet.payInvoice(invoice);
      viewers.push({ pubkey, status: "zapped", amountMsats: params.amountPerViewerMsats });
      reached++;
      totalSpentMsats += params.amountPerViewerMsats;
    } catch {
      viewers.push({ pubkey, status: "failed" });
      failed++;
    }
  }

  return { reached, totalSpentMsats, failed, viewers };
}
