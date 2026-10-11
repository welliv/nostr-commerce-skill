/**
 * mcp-buyer.ts - MCP server so AI agents can license music.
 *
 * Tools:
 *   find_license_offers { use, topics? }          → signed offers (price, terms hash, track hash)
 *   buy_license         { offer_id, buyer_pubkey, project? } → runs the platform
 *                         settlement agent (caps, allowlists, approvals, kill switch)
 *   verify_license      { grant, offer, artist_pubkey, ... } → third-party checks
 *
 * The MCP server is the BUYER side; it pays artist pay links over x402
 * `exact`/`lnbtc` with the `http:1` binding. (A seller exposing a paid MCP
 * tool would use the `mcp:1` binding implemented in x402-lnbtc.ts.)
 *
 * Status: tested with the SDK's in-memory transport and mock Lightning. The
 * bin/ entry point runs a regtest-style demo with mocks; no real money.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { NostrEvent } from './types.js';
import { SettlementAgent } from './settlement-agent.js';
import { verifyLicense, LICENSE_USES, type LicenseUse, type ParsedOffer } from './license.js';

export interface McpBuyerDeps {
  agent: SettlementAgent;
  priceToMsat: (o: ParsedOffer) => Promise<bigint>;
}

const text = (o: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(o, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2) }] });

export function createMusicLicenseMcpServer(deps: McpBuyerDeps): McpServer {
  const server = new McpServer({ name: 'music-license-link', version: '0.1.0' });
  const cache = new Map<string, ParsedOffer>();

  server.registerTool('find_license_offers', {
    description: 'Find artist-signed Music License Link offers (Nostr kind 30402) for a use: sync-online-video, ai-training, remix, membership.',
    inputSchema: { use: z.enum(LICENSE_USES as unknown as [string, ...string[]]), topics: z.array(z.string()).optional() },
  }, async ({ use, topics }) => {
    const offers = await deps.agent.discover(use as LicenseUse, topics ?? []);
    const out = [];
    for (const o of offers) {
      cache.set(o.event.id, o);
      out.push({ offer_id: o.event.id, artist: o.artist, title: tagTitle(o.event), use: o.use, price: o.price, price_msat: (await deps.priceToMsat(o)).toString(), terms_hash: o.terms.hash, terms_url: o.terms.url, license: o.license, track_sha256: o.trackSha256, splits: o.splits });
    }
    return text({ offers: out });
  });

  server.registerTool('buy_license', {
    description: 'Buy a licence for an offer found with find_license_offers. Subject to the platform\'s spend caps, allowlists, human-approval rules and kill switch. Returns the signed licence or why it was not bought.',
    inputSchema: { offer_id: z.string().regex(/^[0-9a-f]{64}$/), buyer_pubkey: z.string().regex(/^[0-9a-f]{64}$/), project: z.string().max(500).optional(), approval_id: z.string().optional() },
  }, async ({ offer_id, buyer_pubkey, project, approval_id }) => {
    const o = cache.get(offer_id);
    if (!o) return { ...text({ status: 'error', reason: 'unknown offer_id; call find_license_offers first' }), isError: true };
    const r = await deps.agent.buy({ offer: o, buyer: buyer_pubkey, project, priceMsat: await deps.priceToMsat(o), approvalId: approval_id });
    return text(r.status === 'licensed' ? { status: r.status, grant: r.grant, paid_msat: r.paidMsat } : r);
  });

  server.registerTool('verify_license', {
    description: 'Verify a Music License Link licence grant against its offer and artist key. Anyone can run this; it does not need the platform.',
    inputSchema: { grant: z.any(), offer: z.any(), artist_pubkey: z.string(), signer_authorization: z.any().optional(), payto_binding: z.any().optional(), terms_text: z.string().optional() },
  }, async ({ grant, offer, artist_pubkey, signer_authorization, payto_binding, terms_text }) => {
    const r = verifyLicense({ grant: grant as NostrEvent, offer: offer as NostrEvent, artistPubkey: artist_pubkey, signerAuthorization: signer_authorization as NostrEvent | undefined, payToBinding: payto_binding as NostrEvent | undefined, termsText: terms_text });
    return text(r);
  });

  return server;
}

function tagTitle(e: NostrEvent) { return e.tags.find((t) => t[0] === 'title')?.[1]; }
