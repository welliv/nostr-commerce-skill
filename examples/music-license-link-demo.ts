/**
 * Music License Link - regtest-style walkthrough (MOCK Lightning, no money, no relays).
 * Run: npx tsx examples/music-license-link-demo.ts
 */
import { createDemoWorld } from '../src/music-demo.js';
import { verifyLicense } from '../src/license.js';
import { verifyRelease } from '../src/proof-of-release.js';
import { verifyAuditLog } from '../src/audit-log.js';
import { planRewardRun, buildListeningAttestation, generateFanIdentity } from '../src/fan.js';
import { getPublicKey } from 'nostr-tools';
import { join } from 'node:path';

const w = createDemoWorld();
console.log('1. Artist published: release (kind 1063), offer (30402), signer auth (3403, PROPOSED), payTo binding (10133)');
const rel = await verifyRelease(w.release, { artistPubkey: w.artist, ots: w.ots, headers: w.headers });
console.log('   proof of release:', rel.ots?.status, '-', rel.statement);

const [offer] = await w.agent.discover('sync-online-video');
console.log(`2. Platform agent found offer ${offer.event.id.slice(0, 12)}… price ${offer.price.amount} ${offer.price.currency}, splits`, offer.splits.map((s) => s.weight));

let r = await w.agent.buy({ offer, buyer: w.buyer, project: 'demo vlog', priceMsat: 5_000_000n });
console.log('3. First attempt:', r.status, r.status === 'needs_approval' ? r.reasons : '');
if (r.status === 'needs_approval') { w.agent.approve(r.approvalId); r = await w.agent.buy({ offer, buyer: w.buyer, project: 'demo vlog', priceMsat: 5_000_000n, approvalId: r.approvalId }); }
console.log('4. After human approval:', r.status, r.status === 'licensed' ? `paid ${r.paidMsat} msat in ${w.net.payments.length} separate payments` : r);
if (r.status !== 'licensed') process.exit(1);

const v = verifyLicense({ grant: r.grant, offer: w.offer, artistPubkey: w.artist, signerAuthorization: w.auth, payToBinding: w.binding, releaseEvent: w.release, releaseAnchoredAt: rel.ots?.attestedTime });
console.log('5. Third-party verification:', v.valid ? 'VALID' : 'INVALID'); for (const c of v.checks) console.log(`   ${c.ok ? '✓' : '✗'} ${c.id}`);
console.log('   limits:', v.limits[1]);
console.log('6. Audit log:', verifyAuditLog(join(w.dataDir, 'agent', 'audit.jsonl'), w.agent.pubkey));

const P0 = w.clock.now - 30 * 86400, P1 = w.clock.now;
const fans = [generateFanIdentity(), generateFanIdentity()];
const atts = fans.map((f, i) => buildListeningAttestation({ fan: f.pubkey, artist: w.artist, periodStart: P0, periodEnd: P1, distinctDays: [20, 5][i], tenureDays: 90 }, w.platformSk));
const run = planRewardRun({ attestations: atts, trustedPlatforms: [getPublicKey(w.platformSk)], artist: w.artist, periodStart: P0, periodEnd: P1, now: P1, budgetMsat: 2_000_000n, capPerFanMsat: 1_000_000n });
console.log('7. DEMO reward plan (after period, capped):', run.payouts.map((p) => `${p.msat} msat for ${p.distinctDays} days`), `"${run.disclosure}"`);
