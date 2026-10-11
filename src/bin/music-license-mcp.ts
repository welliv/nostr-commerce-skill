#!/usr/bin/env node
/**
 * music-license-mcp - stdio MCP server exposing find_license_offers /
 * buy_license / verify_license.
 *
 * DEMO MODE ONLY in this release: it runs against the in-process demo world
 * (mock Lightning, one demo offer). No real money, no relays. Wiring a real
 * NWC payer, relay pool and pay-link HTTP transport is Step 1 integration work.
 * Approvals in demo mode: set MLL_DEMO_AUTO_APPROVE=1 to auto-approve (demo only).
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMusicLicenseMcpServer } from '../mcp-buyer.js';
import { createDemoWorld } from '../music-demo.js';

const w = createDemoWorld();
const origBuy = w.agent.buy.bind(w.agent);
if (process.env.MLL_DEMO_AUTO_APPROVE === '1') {
  w.agent.buy = async (a) => { const r = await origBuy(a); if (r.status !== 'needs_approval') return r; w.agent.approve(r.approvalId); return origBuy({ ...a, approvalId: r.approvalId }); };
}
const server = createMusicLicenseMcpServer({ agent: w.agent, priceToMsat: async (o) => BigInt(Math.round(Number(o.price.amount) * 1000)) });
await server.connect(new StdioServerTransport());
console.error(`music-license-link MCP (DEMO, mock Lightning). Buyer pubkey for testing: ${w.buyer}`);
