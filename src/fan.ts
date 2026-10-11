/**
 * fan.ts - Fan identity v1 for Music License Link.
 *
 *  - Fan keys: ordinary Nostr keys (create in the client, exportable).
 *  - Agent budget authorization: fan-signed, PROPOSED kind 3405. Lets a
 *    subscription/payment agent spend up to a budget per period until expiry.
 *  - Private supporter record: PROPOSED kind 3406 rumor, gift-wrapped (NIP-59)
 *    to the fan's own key. Private by default; the fan can choose to publish.
 *  - Listening attestation: PROPOSED kind 3404, signed by a platform after its
 *    own fraud filtering. Carries distinct listening DAYS and tenure for a
 *    closed period, never per-play counts.
 *  - Reward demo: DEMO ONLY. Capped, computed only after the period closes,
 *    disclosed. There is deliberately no function that takes a play event and
 *    returns a payment.
 *
 * Phase 2 (not here): memberships paid by agents over x402, real platform
 * attestations, real reward payments.
 */
import { finalizeEvent, generateSecretKey, getPublicKey, nip59 } from 'nostr-tools';
import { KIND, type NostrEvent } from './types.js';
import { verifyFresh, tagValue } from './nostr-verify.js';

export const REWARD_DISCLOSURE = 'Thank-you reward for past listening; not payment for plays.';
const now = () => Math.floor(Date.now() / 1000);

export function generateFanIdentity() {
  const secretKey = generateSecretKey();
  return { secretKey, pubkey: getPublicKey(secretKey) };
}

// ─── Agent budget authorization (PROPOSED 3405) ──────────────────────────────

export interface BudgetAuthParams {
  agentPubkey: string;
  budgetMsatPerPeriod: bigint;
  periodSeconds: number; // e.g. 30 days
  expiresAt: number;
  allowedUses?: string[]; // e.g. ['membership']
  allowedArtists?: string[];
  createdAt?: number;
}
export function buildAgentBudgetAuthorization(p: BudgetAuthParams, fanSecretKey: Uint8Array): NostrEvent {
  if (p.budgetMsatPerPeriod <= 0n) throw new Error('budget must be positive');
  const tags: string[][] = [
    ['p', p.agentPubkey, '', 'agent'],
    ['budget', p.budgetMsatPerPeriod.toString(), 'msat', String(p.periodSeconds)],
    ['expiration', String(p.expiresAt)], // NIP-40
    ...(p.allowedUses ?? []).map((u) => ['use', u]),
    ...(p.allowedArtists ?? []).map((a) => ['p', a, '', 'artist']),
  ];
  return finalizeEvent({ kind: KIND.PROPOSED_AGENT_BUDGET_AUTH, created_at: p.createdAt ?? now(), tags, content: 'PROPOSED: fan authorizes this agent to pay within the budget.' }, fanSecretKey) as NostrEvent;
}

export interface SpendCheck { allowed: boolean; reason?: string; remainingMsat?: bigint }
/** Check a proposed agent spend against a fan's authorization. `spentThisPeriodMsat` is tracked by the agent. */
export function checkAgentSpend(auth: NostrEvent, a: { fanPubkey: string; agentPubkey: string; amountMsat: bigint; spentThisPeriodMsat: bigint; use?: string; artist?: string; at?: number }): SpendCheck {
  if (auth.kind !== KIND.PROPOSED_AGENT_BUDGET_AUTH || !verifyFresh(auth) || auth.pubkey !== a.fanPubkey) return { allowed: false, reason: 'invalid-authorization' };
  if (!auth.tags.some((t) => t[0] === 'p' && t[1] === a.agentPubkey && t[3] === 'agent')) return { allowed: false, reason: 'agent-not-authorized' };
  const at = a.at ?? now();
  if (at > Number(tagValue(auth, 'expiration') ?? 0)) return { allowed: false, reason: 'expired' };
  const uses = auth.tags.filter((t) => t[0] === 'use').map((t) => t[1]);
  if (uses.length && (!a.use || !uses.includes(a.use))) return { allowed: false, reason: 'use-not-allowed' };
  const artists = auth.tags.filter((t) => t[0] === 'p' && t[3] === 'artist').map((t) => t[1]);
  if (artists.length && (!a.artist || !artists.includes(a.artist))) return { allowed: false, reason: 'artist-not-allowed' };
  const budget = BigInt(tagValue(auth, 'budget') ?? '0');
  const remaining = budget - a.spentThisPeriodMsat;
  if (a.amountMsat > remaining) return { allowed: false, reason: 'over-budget', remainingMsat: remaining };
  return { allowed: true, remainingMsat: remaining - a.amountMsat };
}

// ─── Private supporter record (PROPOSED 3406, gift-wrapped to self) ──────────

export interface SupporterRecord { artist: string; since: number; supportedMsat: string; via?: string; note?: string }
export function createPrivateSupporterRecord(r: SupporterRecord, fanSecretKey: Uint8Array): NostrEvent {
  const rumor = {
    kind: KIND.PROPOSED_SUPPORTER_RECORD, created_at: now(), content: r.note ?? '',
    tags: [['p', r.artist, '', 'artist'], ['since', String(r.since)], ['amount', r.supportedMsat, 'msat'], ...(r.via ? [['via', r.via]] : [])],
  };
  return nip59.wrapEvent(rumor, fanSecretKey, getPublicKey(fanSecretKey)) as NostrEvent;
}
export function openPrivateSupporterRecord(wrap: NostrEvent, fanSecretKey: Uint8Array): SupporterRecord {
  const r = nip59.unwrapEvent(wrap as any, fanSecretKey) as any;
  if (r.kind !== KIND.PROPOSED_SUPPORTER_RECORD) throw new Error('not a supporter record');
  const t = (n: string) => r.tags.find((x: string[]) => x[0] === n);
  return { artist: t('p')[1], since: Number(t('since')[1]), supportedMsat: t('amount')[1], via: t('via')?.[1], note: r.content || undefined };
}

// ─── Listening attestation (PROPOSED 3404) ───────────────────────────────────

export interface AttestationParams { fan: string; artist: string; periodStart: number; periodEnd: number; distinctDays: number; tenureDays: number; demo?: boolean }
/** Platform-signed summary for a CLOSED period. No per-play counts by design. */
export function buildListeningAttestation(p: AttestationParams, platformSecretKey: Uint8Array): NostrEvent {
  if (p.periodEnd <= p.periodStart) throw new Error('bad period');
  const maxDays = Math.ceil((p.periodEnd - p.periodStart) / 86400);
  if (p.distinctDays < 0 || p.distinctDays > maxDays) throw new Error('distinctDays out of range');
  const tags: string[][] = [['p', p.fan, '', 'fan'], ['p', p.artist, '', 'artist'], ['period', String(p.periodStart), String(p.periodEnd)], ['distinct-days', String(p.distinctDays)], ['tenure-days', String(p.tenureDays)]];
  if (p.demo !== false) tags.push(['t', 'demo-data']);
  return finalizeEvent({ kind: KIND.PROPOSED_LISTENING_ATTESTATION, created_at: p.periodEnd, tags, content: p.demo !== false ? 'DEMO DATA: listening attestation' : '' }, platformSecretKey) as NostrEvent;
}

// ─── Reward demo ─────────────────────────────────────────────────────────────

export interface RewardRunParams {
  attestations: NostrEvent[];
  trustedPlatforms: string[];
  artist: string;
  periodStart: number;
  periodEnd: number;
  now: number;
  budgetMsat: bigint;
  capPerFanMsat: bigint;
  minDistinctDays?: number;
}
export interface RewardPayout { fan: string; msat: bigint; distinctDays: number; disclosure: string }
export interface RewardRun { demo: true; disclosure: string; payouts: RewardPayout[]; totalMsat: bigint; skipped: Array<{ id: string; reason: string }> }

/**
 * DEMO. Allocates a reward budget across fans by distinct listening days in a
 * closed period, capped per fan. Refuses to run before the period ends.
 * Returns a plan; paying it (e.g. zaps with the disclosure) is the caller's choice.
 */
export function planRewardRun(p: RewardRunParams): RewardRun {
  if (p.now < p.periodEnd) throw new Error('period not closed: rewards are only computed after the period ends');
  const skipped: RewardRun['skipped'] = []; const byFan = new Map<string, number>();
  for (const a of p.attestations) {
    const per = a.tags.find((t) => t[0] === 'period');
    const fan = a.tags.find((t) => t[0] === 'p' && t[3] === 'fan')?.[1];
    const artist = a.tags.find((t) => t[0] === 'p' && t[3] === 'artist')?.[1];
    if (a.kind !== KIND.PROPOSED_LISTENING_ATTESTATION || !verifyFresh(a)) { skipped.push({ id: a.id, reason: 'invalid' }); continue; }
    if (!p.trustedPlatforms.includes(a.pubkey)) { skipped.push({ id: a.id, reason: 'untrusted-platform' }); continue; }
    if (artist !== p.artist || !fan || !per || Number(per[1]) !== p.periodStart || Number(per[2]) !== p.periodEnd) { skipped.push({ id: a.id, reason: 'wrong-artist-or-period' }); continue; }
    const days = Number(tagValue(a, 'distinct-days') ?? 0);
    if (days < (p.minDistinctDays ?? 1)) { skipped.push({ id: a.id, reason: 'below-minimum' }); continue; }
    byFan.set(fan, Math.max(byFan.get(fan) ?? 0, days)); // one per fan; duplicates don't stack
  }
  const totalDays = [...byFan.values()].reduce((s, x) => s + x, 0);
  const payouts: RewardPayout[] = [];
  for (const [fan, days] of [...byFan.entries()].sort((a, b) => b[1] - a[1])) {
    let msat = totalDays ? (p.budgetMsat * BigInt(days)) / BigInt(totalDays) : 0n;
    if (msat > p.capPerFanMsat) msat = p.capPerFanMsat;
    msat = (msat / 1000n) * 1000n; // whole sats
    if (msat > 0n) payouts.push({ fan, msat, distinctDays: days, disclosure: REWARD_DISCLOSURE });
  }
  return { demo: true, disclosure: REWARD_DISCLOSURE, payouts, totalMsat: payouts.reduce((s, x) => s + x.msat, 0n), skipped };
}
