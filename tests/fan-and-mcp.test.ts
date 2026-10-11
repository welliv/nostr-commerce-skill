import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import { generateSecretKey, getPublicKey } from 'nostr-tools';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import * as fan from '../src/fan.js';
import { createMusicLicenseMcpServer } from '../src/mcp-buyer.js';
import { createDemoWorld } from '../src/music-demo.js';

describe('fan identity v1', () => {
  const f = fan.generateFanIdentity(); const agent = getPublicKey(generateSecretKey()); const artist = getPublicKey(generateSecretKey());
  const auth = fan.buildAgentBudgetAuthorization({ agentPubkey: agent, budgetMsatPerPeriod: 10_000_000n, periodSeconds: 30 * 86400, expiresAt: 2_000_000_000, allowedUses: ['membership'], allowedArtists: [artist] }, f.secretKey);
  it('budget authorization enforces agent, budget, use, artist, expiry', () => {
    const base = { fanPubkey: f.pubkey, agentPubkey: agent, amountMsat: 3_000_000n, spentThisPeriodMsat: 0n, use: 'membership', artist, at: 1_900_000_000 };
    expect(fan.checkAgentSpend(auth, base).allowed).toBe(true);
    expect(fan.checkAgentSpend(auth, { ...base, spentThisPeriodMsat: 8_000_000n }).reason).toBe('over-budget');
    expect(fan.checkAgentSpend(auth, { ...base, agentPubkey: artist }).reason).toBe('agent-not-authorized');
    expect(fan.checkAgentSpend(auth, { ...base, use: 'sync-online-video' }).reason).toBe('use-not-allowed');
    expect(fan.checkAgentSpend(auth, { ...base, artist: agent }).reason).toBe('artist-not-allowed');
    expect(fan.checkAgentSpend(auth, { ...base, at: 2_000_000_001 }).reason).toBe('expired');
    expect(fan.checkAgentSpend(auth, { ...base, fanPubkey: agent }).reason).toBe('invalid-authorization');
  });
  it('private supporter record is gift-wrapped and only the fan can open it', () => {
    const w = fan.createPrivateSupporterRecord({ artist, since: 1_700_000_000, supportedMsat: '21000', via: 'demo' }, f.secretKey);
    expect(w.kind).toBe(1059); expect(w.content).not.toContain(artist);
    expect(fan.openPrivateSupporterRecord(w, f.secretKey)).toMatchObject({ artist, supportedMsat: '21000' });
    expect(() => fan.openPrivateSupporterRecord(w, generateSecretKey())).toThrow();
  });
  it('reward demo: only after period, capped, disclosed, distinct days not plays', () => {
    const plat = generateSecretKey(); const P0 = 1_700_000_000, P1 = P0 + 30 * 86400;
    const fans = [fan.generateFanIdentity(), fan.generateFanIdentity(), fan.generateFanIdentity()];
    const atts = [fan.buildListeningAttestation({ fan: fans[0].pubkey, artist, periodStart: P0, periodEnd: P1, distinctDays: 28, tenureDays: 400 }, plat),
      fan.buildListeningAttestation({ fan: fans[1].pubkey, artist, periodStart: P0, periodEnd: P1, distinctDays: 2, tenureDays: 3 }, plat),
      fan.buildListeningAttestation({ fan: fans[2].pubkey, artist, periodStart: P0, periodEnd: P1, distinctDays: 10, tenureDays: 30 }, generateSecretKey())];
    expect(atts[0].tags).toContainEqual(['t', 'demo-data']);
    const params = { attestations: atts, trustedPlatforms: [getPublicKey(plat)], artist, periodStart: P0, periodEnd: P1, budgetMsat: 5_000_000n, capPerFanMsat: 1_000_000n };
    expect(() => fan.planRewardRun({ ...params, now: P1 - 1 })).toThrow(/period not closed/);
    const run = fan.planRewardRun({ ...params, now: P1 });
    expect(run.demo).toBe(true); expect(run.disclosure).toMatch(/not payment for plays/);
    expect(run.payouts.every((p) => p.msat <= 1_000_000n)).toBe(true);
    expect(run.payouts.length).toBe(2); expect(run.skipped.map((s) => s.reason)).toContain('untrusted-platform');
    expect(() => fan.buildListeningAttestation({ fan: fans[0].pubkey, artist, periodStart: P0, periodEnd: P1, distinctDays: 31, tenureDays: 1 }, plat)).toThrow();
  });
  it('code search: no per-play payment path in Music License Link modules', () => {
    for (const f of ['src/fan.ts', 'src/settlement-agent.ts', 'src/license.ts', 'src/license-server.ts', 'src/mcp-buyer.ts']) {
      const src = fs.readFileSync(f, 'utf8');
      expect(src).not.toMatch(/function\s+\w*(perPlay|PerPlay|payPerListen|onPlay)\w*/);
      expect(src).not.toMatch(/play[_-]?count/i);
    }
  });
});

describe('MCP buyer tool', () => {
  it('find_license_offers → buy_license (approval) → verify_license', async () => {
    const w = createDemoWorld();
    const server = createMusicLicenseMcpServer({ agent: w.agent, priceToMsat: async (o) => BigInt(o.price.amount) * 1000n });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st); const client = new Client({ name: 't', version: '1' }); await client.connect(ct);
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual(['buy_license', 'find_license_offers', 'verify_license']);
    const parse = (r: any) => JSON.parse(r.content[0].text);
    const found = parse(await client.callTool({ name: 'find_license_offers', arguments: { use: 'sync-online-video' } }));
    expect(found.offers.length).toBe(1); expect(found.offers[0].price_msat).toBe('5000000');
    const id = found.offers[0].offer_id;
    const first = parse(await client.callTool({ name: 'buy_license', arguments: { offer_id: id, buyer_pubkey: w.buyer, project: 'agent video' } }));
    expect(first.status).toBe('needs_approval');
    w.agent.approve(first.approvalId); // the human step
    const bought = parse(await client.callTool({ name: 'buy_license', arguments: { offer_id: id, buyer_pubkey: w.buyer, approval_id: first.approvalId } }));
    expect(bought.status).toBe('licensed');
    const v = parse(await client.callTool({ name: 'verify_license', arguments: { grant: bought.grant, offer: w.offer, artist_pubkey: w.artist, signer_authorization: w.auth, payto_binding: w.binding } }));
    expect(v.valid).toBe(true);
  });
});
