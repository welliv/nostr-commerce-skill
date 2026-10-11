import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools';
import { createDemoWorld, DEMO_TERMS_TEXT } from '../src/music-demo.js';
import { buildLicenseOffer, parseLicenseOffer, verifyLicense, termsHash, buildLicenseGrant } from '../src/license.js';
import { buildReleaseEvent, buildTestOts, verifyOts, verifyRelease, inspectOts, buildOtsEvent, sha256Hex } from '../src/proof-of-release.js';
import { verifyAuditLog, AuditLog } from '../src/audit-log.js';
import { handleLicenseRequest } from '../src/license-server.js';
import { KIND } from '../src/types.js';
import { LNBTC_TESTNET } from '../src/x402-lnbtc.js';

const H = 'ab'.repeat(32);

describe('licence offer (NIP-99 30402 + PROPOSED tags)', () => {
  const sk = generateSecretKey();
  const base = { trackId: 't', use: 'ai-training' as const, trackSha256: H, title: 'T', summary: 'S', price: { amount: '5', currency: 'USD' }, termsText: 'TEXT v1', payLink: 'https://a/x' };
  it('round-trips and checks terms hash', () => {
    const o = parseLicenseOffer(buildLicenseOffer(base, sk));
    expect(o.use).toBe('ai-training'); expect(o.terms.hash).toBe(termsHash('TEXT v1')); expect(o.terms.textMatches).toBe(true);
    expect(o.event.tags).toContainEqual(['t', 'license-ai-training']);
    expect(o.coordinate).toBe(`30402:${getPublicKey(sk)}:t:ai-training`);
  });
  it('rejects tampered terms text', () => {
    const ev = buildLicenseOffer(base, sk); const t = ev.tags.find((x) => x[0] === 'terms-text')!; t[1] = 'TEXT v2';
    expect(() => parseLicenseOffer(ev)).toThrow();
  });
  it('rejects re-signed offer whose text does not match hash', () => {
    const ev = buildLicenseOffer(base, sk);
    const tags = ev.tags.map((t) => (t[0] === 'terms-text' ? ['terms-text', 'other'] : t));
    expect(() => parseLicenseOffer(finalizeEvent({ kind: 30402, created_at: ev.created_at, tags, content: '' }, sk) as any)).toThrow(/terms text/);
  });
  it('rejects unknown use', () => { expect(() => buildLicenseOffer({ ...base, use: 'streaming' as any }, sk)).toThrow(); });
  it('marks custom kinds PROPOSED', () => { expect(KIND.PROPOSED_LICENSE_GRANT).toBe(3402); expect(KIND.PROPOSED_LICENSE_SIGNER_AUTH).toBe(3403); });
});

describe('proof of release (NIP-94 1063 + OpenTimestamps)', () => {
  const sk = generateSecretKey(); const pk = getPublicKey(sk);
  it('verifies an OTS proof against (mocked) block headers', async () => {
    const { ots, merkleRootHex } = buildTestOts(H, 800000);
    const r = await verifyOts(ots, H, { getBlock: async () => ({ merkleRoot: merkleRootHex, time: 1700000000 }) });
    expect(r.status).toBe('verified'); expect(r.attestedTime).toBe(1700000000); expect(r.height).toBe(800000);
  });
  it('fails on wrong merkle root, wrong digest; pending without bitcoin attestation', async () => {
    const { ots } = buildTestOts(H, 800000);
    expect((await verifyOts(ots, H, { getBlock: async () => ({ merkleRoot: '00'.repeat(32), time: 1 }) })).status).toBe('invalid');
    expect((await verifyOts(ots, 'cd'.repeat(32), { getBlock: async () => ({ merkleRoot: '', time: 1 }) })).status).toBe('invalid');
    const p = buildTestOts(H, 0);
    const r = await verifyOts(p.ots, H, { getBlock: async () => { throw new Error(); } });
    expect(r.status).toBe('pending'); expect(r.pendingCalendars.length).toBe(1);
    expect(inspectOts(p.ots).digest).toBe(H);
  });
  it('release event + verifyRelease statement says existence, not authorship', async () => {
    const rel = buildReleaseEvent({ masterSha256: H, mime: 'audio/flac' }, sk);
    expect(rel.kind).toBe(1063); expect(rel.tags).toContainEqual(['ox', H]);
    const { ots, merkleRootHex } = buildTestOts(H, 1);
    const r = await verifyRelease(rel, { artistPubkey: pk, masterSha256: H, ots, headers: { getBlock: async () => ({ merkleRoot: merkleRootHex, time: 1700000000 }) } });
    expect(r.ok).toBe(true); expect(r.statement).toMatch(/not of authorship/);
    expect((await verifyRelease(rel, { artistPubkey: getPublicKey(generateSecretKey()) })).ok).toBe(false);
  });
  it('NIP-03 kind 1040 event', () => {
    const rel = buildReleaseEvent({ masterSha256: H, mime: 'audio/flac' }, sk);
    const e = buildOtsEvent(rel, buildTestOts(H, 1).ots, sk);
    expect(e.kind).toBe(1040); expect(e.tags).toContainEqual(['k', '1063']);
  });
  it('sha256Hex', () => { expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'); });
});

describe('settlement agent end to end (mock Lightning)', () => {
  async function approveAndBuy(w: ReturnType<typeof createDemoWorld>, priceMsat = 5_000_000n) {
    const [o] = await w.agent.discover('sync-online-video');
    const r1 = await w.agent.buy({ offer: o, buyer: w.buyer, project: 'vlog #12', priceMsat });
    if (r1.status !== 'needs_approval') return r1;
    w.agent.approve(r1.approvalId);
    return w.agent.buy({ offer: o, buyer: w.buyer, project: 'vlog #12', priceMsat, approvalId: r1.approvalId });
  }
  it('first purchase needs approval (new artist, new template), then licenses; splits paid separately', async () => {
    const w = createDemoWorld();
    const [o] = await w.agent.discover('sync-online-video');
    const r1 = await w.agent.buy({ offer: o, buyer: w.buyer, priceMsat: 5_000_000n });
    expect(r1.status).toBe('needs_approval');
    if (r1.status === 'needs_approval') expect(r1.reasons).toEqual(expect.arrayContaining(['first-purchase-from-artist', 'new-terms-template']));
    const r = await approveAndBuy(w);
    expect(r.status).toBe('licensed');
    expect(w.net.payments.length).toBe(2);
    expect(w.net.payments.map((p) => p.amountMsat).sort()).toEqual(['1000000', '4000000']);
    if (r.status !== 'licensed') return;
    // third-party verification with only public data
    const v = verifyLicense({ grant: r.grant, offer: w.offer, artistPubkey: w.artist, signerAuthorization: w.auth, payToBinding: w.binding, releaseEvent: w.release, releaseAnchoredAt: w.clock.now - 6 * 86400 });
    expect(v.valid).toBe(true);
    expect(v.limits.join(' ')).toMatch(/self-dealing/);
    expect(fs.existsSync(r.bundlePath)).toBe(true);
    // audit log verifies and contains no preimages
    const logFile = join(w.dataDir, 'agent', 'audit.jsonl');
    expect(verifyAuditLog(logFile, w.agent.pubkey).valid).toBe(true);
    const preimages = [r.grant.tags.find((t) => t[0] === 'preimage')![1]];
    expect(preimages.every((p) => !fs.readFileSync(logFile, 'utf8').includes(p))).toBe(true);
  });
  it('rejects: over cap, daily cap, non-allowlisted artist, changed terms hash, wrong network', async () => {
    let w = createDemoWorld({ policy: { perLicenseCapMsat: 1_000_000n } });
    let [o] = await w.agent.discover('sync-online-video');
    let r = await w.agent.buy({ offer: o, buyer: w.buyer, priceMsat: 5_000_000n });
    expect(r.status === 'rejected' && r.reasons).toContain('over-per-licence-cap');
    w = createDemoWorld({ policy: { dailyCapMsat: 1_000n } }); [o] = await w.agent.discover('sync-online-video');
    r = await w.agent.buy({ offer: o, buyer: w.buyer, priceMsat: 5_000_000n }); expect(r.status === 'rejected' && r.reasons).toContain('over-daily-cap');
    w = createDemoWorld({ policy: { artistAllowlist: [] } }); [o] = await w.agent.discover('sync-online-video');
    r = await w.agent.buy({ offer: o, buyer: w.buyer, priceMsat: 5_000_000n }); expect(r.status === 'rejected' && r.reasons).toContain('artist-not-allowlisted');
    w = createDemoWorld({ policy: { termsAllowlist: [termsHash(DEMO_TERMS_TEXT + ' changed')] } }); [o] = await w.agent.discover('sync-online-video');
    r = await w.agent.buy({ offer: o, buyer: w.buyer, priceMsat: 5_000_000n }); expect(r.status === 'rejected' && r.reasons).toContain('terms-hash-not-allowlisted');
    w = createDemoWorld({ policy: { networkAllowlist: [LNBTC_TESTNET] } });
    r = await approveAndBuy(w); expect(r.status).toBe('failed');
    expect(w.net.payments.length).toBe(0);
  });
  it('missing proof of release requires approval', async () => {
    const w = createDemoWorld();
    (w.agent as any).d.fetchOts = async () => undefined;
    const [o] = await w.agent.discover('sync-online-video');
    const r = await w.agent.buy({ offer: o, buyer: w.buyer, priceMsat: 5_000_000n });
    expect(r.status === 'needs_approval' && r.reasons).toContain('proof-of-release-missing-or-unanchored');
  });
  it('kill switch stops before any payment', async () => {
    const w = createDemoWorld();
    fs.writeFileSync(join(w.dataDir, 'agent', 'KILL'), '');
    const r = await approveAndBuy(w);
    expect(r.status === 'failed' && r.reason).toBe('kill-switch');
    expect(w.net.payments.length).toBe(0);
  });
  it('payee-key mismatch (binding names another node) fails before licensor payment', async () => {
    const w = createDemoWorld();
    const other = (await import('../src/license.js')).buildPayToBinding('02' + '11'.repeat(32), w.artistSk);
    (w.agent as any).d.fetchPayToBinding = async () => other;
    const r = await approveAndBuy(w);
    expect(r.status === 'failed' && r.reason).toBe('payee-not-artist-node');
    expect(w.net.payments.length).toBe(1); // split already paid: non-atomic, logged as credit
  });
  it('rate limit blocks a second buy within 10 minutes', async () => {
    const w = createDemoWorld();
    expect((await approveAndBuy(w)).status).toBe('licensed');
    const [o] = await w.agent.discover('sync-online-video');
    const r = await w.agent.buy({ offer: o, buyer: w.buyer, priceMsat: 5_000_000n });
    expect(r.status === 'rejected' && r.reasons).toContain('rate-limited');
  });
  it('pay link refuses a replayed payment and a replayed split proof', async () => {
    const w = createDemoWorld();
    const r = await approveAndBuy(w); expect(r.status).toBe('licensed');
    if (r.status !== 'licensed') return;
    const bundle = JSON.parse(fs.readFileSync(r.bundlePath, 'utf8'));
    const body = JSON.stringify({ offer: w.offer.id, buyer: getPublicKey(generateSecretKey()), splitProofs: bundle.splitProofs });
    const res = await handleLicenseRequest(w.payLink, { method: 'POST', url: w.payLink.url, body, headers: { 'content-type': 'application/json' } }, { x402Version: 2, accepted: { scheme: 'exact' } as any, payload: { preimage: '00'.repeat(32) } });
    expect(res.status).not.toBe(200);
  });
  it('verifier rejects grant from unauthorized signer and tampered grant', async () => {
    const w = createDemoWorld(); const r = await approveAndBuy(w); if (r.status !== 'licensed') throw new Error(r.status);
    expect(verifyLicense({ grant: r.grant, offer: w.offer, artistPubkey: w.artist }).valid).toBe(false); // no auth supplied
    const t = JSON.parse(JSON.stringify(r.grant)); t.tags.find((x: string[]) => x[0] === 'use')[1] = 'ai-training';
    expect(verifyLicense({ grant: t, offer: w.offer, artistPubkey: w.artist, signerAuthorization: w.auth }).valid).toBe(false);
    const forged = buildLicenseGrant({ offer: w.offer, buyerPubkey: w.buyer, payment: { network: 'x', paymentHash: '00'.repeat(32), amountMsat: '1', invoice: 'lnbc1' } }, generateSecretKey());
    expect(verifyLicense({ grant: forged, offer: w.offer, artistPubkey: w.artist, signerAuthorization: w.auth }).valid).toBe(false);
  });
});

describe('audit log', () => {
  it('detects edits, deletions and reorders; refuses preimage fields', () => {
    const sk = generateSecretKey(); const dir = fs.mkdtempSync(join(tmpdir(), 'al-')); const f = join(dir, 'a.jsonl');
    const log = new AuditLog(f, sk);
    log.append('discover', { n: 1 }); log.append('decision', { n: 2 }); log.append('payment_sent', { payment_hash: 'aa' });
    expect(() => log.append('payment_sent', { preimage: 'x' })).toThrow();
    const pk = log.signer;
    expect(verifyAuditLog(f, pk).valid).toBe(true);
    const lines = fs.readFileSync(f, 'utf8').trim().split('\n');
    fs.writeFileSync(f, [lines[0], lines[2]].join('\n') + '\n'); expect(verifyAuditLog(f, pk).valid).toBe(false);
    fs.writeFileSync(f, lines[0].replace('"n":1', '"n":9') + '\n'); expect(verifyAuditLog(f, pk).error).toMatch(/edited/);
    fs.writeFileSync(f, lines.join('\n') + '\n'); expect(verifyAuditLog(f, getPublicKey(generateSecretKey())).valid).toBe(false);
  });
});
