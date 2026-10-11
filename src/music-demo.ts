/**
 * music-demo.ts - DEMO WORLD for Music License Link (regtest-style, mocks only).
 *
 * Wires an artist, a licence-signing subkey, a collaborator split, a pay link,
 * a platform settlement agent and fake Bitcoin headers together in-process.
 * Moves no money and touches no relay. Used by tests, the README walkthrough
 * (examples/music-license-link-demo.ts) and the MCP demo entry point.
 */
import { generateSecretKey, getPublicKey } from 'nostr-tools';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { NostrEvent } from './types.js';
import { buildLicenseOffer, buildPayToBinding, buildSignerAuthorization, termsHash, type LicenseUse } from './license.js';
import { buildReleaseEvent, buildTestOts, sha256Hex, type BlockHeaderSource } from './proof-of-release.js';
import { handleLicenseRequest, decodePaymentHeader, encodePaymentHeader, type PayLinkConfig } from './license-server.js';
import { MockLightningNetwork, FileReplayStore, LNBTC_MAINNET } from './x402-lnbtc.js';
import { SettlementAgent, type SpendPolicy } from './settlement-agent.js';

export const DEMO_TERMS_TEXT = `DRAFT - NOT LEGAL ADVICE - DEMO ONLY
Music License Link: non-exclusive sync licence for one online video.
Licensor grants Licensee a worldwide, non-exclusive licence to synchronise the Work in one online video for one year.
No resale, no standalone audio distribution, no use in AI training unless stated.`;

export interface DemoWorld {
  artistSk: Uint8Array; artist: string; signerSk: Uint8Array; collaborator: string; platformSk: Uint8Array; buyer: string;
  release: NostrEvent; ots: Uint8Array; offer: NostrEvent; auth: NostrEvent; binding: NostrEvent;
  net: MockLightningNetwork; agent: SettlementAgent; payLink: PayLinkConfig; headers: BlockHeaderSource; dataDir: string;
  policy: SpendPolicy; clock: { now: number };
}

export function createDemoWorld(opts: { priceSats?: number; use?: LicenseUse; policy?: Partial<SpendPolicy>; now?: number } = {}): DemoWorld {
  const clock = { now: opts.now ?? 1_790_000_000 };
  const tick = () => clock.now;
  const artistSk = generateSecretKey(); const artist = getPublicKey(artistSk);
  const signerSk = generateSecretKey();
  const collabSk = generateSecretKey(); const collaborator = getPublicKey(collabSk);
  const platformSk = generateSecretKey(); const buyer = getPublicKey(generateSecretKey());
  const net = new MockLightningNetwork('bc', tick);
  const artistNode = net.receiver(randomBytes(32).toString('hex'));
  const collabNode = net.receiver(randomBytes(32).toString('hex'));
  const master = randomBytes(1024); // stand-in for the audio master
  const masterSha = sha256Hex(master);
  const release = buildReleaseEvent({ masterSha256: masterSha, mime: 'audio/flac', size: master.length, title: 'Demo Track', createdAt: clock.now - 7 * 86400 }, artistSk);
  const { ots, merkleRootHex } = buildTestOts(masterSha, 900_000);
  const headers: BlockHeaderSource = { async getBlock(h) { if (h !== 900_000) throw new Error('unknown block'); return { merkleRoot: merkleRootHex, time: clock.now - 6 * 86400 }; } };
  const url = 'https://artist.example/license/demo-track/' + (opts.use ?? 'sync-online-video');
  const offer = buildLicenseOffer({
    trackId: 'demo-track', use: opts.use ?? 'sync-online-video', trackSha256: masterSha, releaseEventId: release.id,
    title: 'Demo Track - sync licence', summary: 'Non-exclusive sync licence for one online video',
    price: { amount: String(opts.priceSats ?? 5000), currency: 'SAT' }, term: 'P1Y-per-video', termsText: DEMO_TERMS_TEXT,
    payLink: url, splits: [{ pubkey: artist, weight: 80 }, { pubkey: collaborator, weight: 20 }], createdAt: clock.now - 3 * 86400,
  }, artistSk);
  const auth = buildSignerAuthorization(getPublicKey(signerSk), artistSk, { createdAt: clock.now - 3 * 86400, expiresAt: clock.now + 365 * 86400 });
  const binding = buildPayToBinding(artistNode.nodePubkey, artistSk, clock.now - 3 * 86400);
  const dataDir = mkdtempSync(join(tmpdir(), 'mll-demo-'));
  const payLink: PayLinkConfig = { url, network: LNBTC_MAINNET, offers: [offer], receiver: artistNode, replay: new FileReplayStore(join(dataDir, 'replay')), signerSecretKey: signerSk, authorizationEventId: auth.id, clock: tick };
  const policy: SpendPolicy = {
    perLicenseCapMsat: 10_000_000n, dailyCapMsat: 50_000_000n, artistAllowlist: [artist], termsAllowlist: [termsHash(DEMO_TERMS_TEXT)],
    useAllowlist: ['sync-online-video', 'ai-training'], networkAllowlist: [LNBTC_MAINNET], ...opts.policy,
  };
  const agent = new SettlementAgent(policy, {
    platformSecretKey: platformSk, payer: net.payer(), dataDir: join(dataDir, 'agent'), clock: tick, headers,
    fetchEvents: async () => [offer],
    splitInvoice: async (pk, msat) => { if (pk !== collaborator) throw new Error('unknown split recipient'); return collabNode.invoice(msat); },
    fetchOts: async (h) => (h === masterSha ? ots : undefined),
    fetchPayToBinding: async (a) => (a === artist ? binding : undefined),
    fetchSignerAuth: async (a, s) => (a === artist && s === getPublicKey(signerSk) ? auth : undefined),
    // in-process "HTTP": serialize the payment header like a real client would
    transport: { post: async (u, body, payment) => handleLicenseRequest(payLink, { method: 'POST', url: u, body, headers: { 'content-type': 'application/json' } }, payment ? decodePaymentHeader(encodePaymentHeader(payment)) : undefined) },
  });
  return { artistSk, artist, signerSk, collaborator, platformSk, buyer, release, ots, offer, auth, binding, net, agent, payLink, headers, dataDir, policy, clock };
}
