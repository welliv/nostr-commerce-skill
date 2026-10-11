/**
 * license.ts - Music License Link: offers, signer authorization, licence grants
 * and a third-party verifier.
 *
 * Standards used:
 *  - Offer: NIP-99 kind 30402 (standard kind + `price`, `t`, `d`, `title`,
 *    `summary`, `x`, `e` tags). Tags `license`, `terms`, `terms-text`,
 *    `pay-link` are PROPOSED conventions. `zap` split tags are NIP-57 Appendix G
 *    (standard tag; use for licence splits is PROPOSED).
 *  - PayTo binding: kind 10133 (NIP-A3, draft) with tag
 *    ["payto","lightning-node","<66-hex node key>"]; that type value is PROPOSED.
 *  - Licence grant: kind 3402, PROPOSED, UNREGISTERED placeholder.
 *  - Licence-signer authorization: kind 3403, PROPOSED, UNREGISTERED placeholder
 *    (NIP-26 delegation is "unrecommended", so we do not use it).
 *
 * The licence text template is a DRAFT. It needs review by a music lawyer
 * before any sale to a buyer who is not a friend.
 */
import { finalizeEvent, getPublicKey } from 'nostr-tools';
import { createHash } from 'node:crypto';
import { KIND, type NostrEvent } from './types.js';
import { verifyFresh, tagValue, tagsOf } from './nostr-verify.js';
import { decodeBolt11Strict } from './bolt11-strict.js';
import { NETWORK_CURRENCY } from './x402-lnbtc.js';

export const LICENSE_USES = ['sync-online-video', 'ai-training', 'remix', 'membership'] as const;
export type LicenseUse = (typeof LICENSE_USES)[number];

const sha = (s: string | Uint8Array) => createHash('sha256').update(s).digest('hex');
/** Terms hash = SHA-256 of the exact UTF-8 licence text bytes (no normalization). */
export const termsHash = (text: string) => sha(Buffer.from(text, 'utf8'));
const now = () => Math.floor(Date.now() / 1000);
const HEX64 = /^[0-9a-f]{64}$/;

export interface Split { pubkey: string; relay?: string; weight: number }

export interface LicenseOfferParams {
  trackId: string; // stable slug, e.g. "2025-flow-3"
  use: LicenseUse;
  trackSha256: string; // master hash (= `ox` of the release event)
  releaseEventId?: string; // kind 1063 id
  title: string;
  summary: string;
  /** NIP-99 price: amount + currency, e.g. {amount:'5',currency:'USD'} or {amount:'5000',currency:'SAT'}. */
  price: { amount: string; currency: string; frequency?: string };
  territory?: string; // default "worldwide"
  term?: string; // e.g. "P1Y-per-video"
  exclusivity?: 'non-exclusive';
  termsText: string;
  termsUrl?: string;
  payLink: string;
  payMethods?: string[]; // default ["x402:exact:lnbtc","l402"]
  splits?: Split[];
  extraTopics?: string[];
  content?: string;
  createdAt?: number;
}

export function buildLicenseOffer(p: LicenseOfferParams, artistSecretKey: Uint8Array): NostrEvent {
  if (!LICENSE_USES.includes(p.use)) throw new Error(`unknown use ${p.use}`);
  if (!HEX64.test(p.trackSha256)) throw new Error('trackSha256 must be 64 hex');
  if (!/^[0-9]+(\.[0-9]+)?$/.test(p.price.amount)) throw new Error('price amount must be a decimal string');
  const th = termsHash(p.termsText);
  const tags: string[][] = [
    ['d', `${p.trackId}:${p.use}`],
    ['title', p.title],
    ['summary', p.summary],
    p.price.frequency ? ['price', p.price.amount, p.price.currency, p.price.frequency] : ['price', p.price.amount, p.price.currency],
    ['t', `license-${p.use}`], ['t', 'music'], ['t', 'music-license-link'],
    ...(p.extraTopics ?? []).map((t) => ['t', t]),
    ['x', p.trackSha256],
    ...(p.releaseEventId ? [['e', p.releaseEventId, '', 'release']] : []),
    ['license', p.use, p.territory ?? 'worldwide', p.term ?? 'perpetual', p.exclusivity ?? 'non-exclusive'], // PROPOSED
    ['terms', th, p.termsUrl ?? ''], // PROPOSED
    ['terms-text', p.termsText], // PROPOSED: exact text inline so the hash is checkable offline
    ['pay-link', p.payLink, ...(p.payMethods ?? ['x402:exact:lnbtc', 'l402'])], // PROPOSED
    ...(p.splits ?? []).map((s) => ['zap', s.pubkey, s.relay ?? '', String(s.weight)]),
  ];
  return finalizeEvent({ kind: KIND.LISTING_ACTIVE, created_at: p.createdAt ?? now(), tags, content: p.content ?? p.summary }, artistSecretKey) as NostrEvent;
}

export interface ParsedOffer {
  event: NostrEvent;
  artist: string;
  coordinate: string; // 30402:<pubkey>:<d>
  d: string;
  trackId: string;
  use: LicenseUse;
  price: { amount: string; currency: string; frequency?: string };
  trackSha256: string;
  releaseEventId?: string;
  terms: { hash: string; url?: string; text?: string; textMatches: boolean };
  license: { territory: string; term: string; exclusivity: string };
  payLink: { url: string; methods: string[] };
  splits: Split[];
}

/** Parse + validate an offer. Throws on bad signature, missing tags, or terms text/hash mismatch. */
export function parseLicenseOffer(ev: NostrEvent): ParsedOffer {
  if (ev.kind !== KIND.LISTING_ACTIVE) throw new Error('not a kind 30402 event');
  if (!verifyFresh(ev)) throw new Error('bad signature');
  const d = tagValue(ev, 'd'); const lic = ev.tags.find((t) => t[0] === 'license'); const terms = ev.tags.find((t) => t[0] === 'terms');
  const price = ev.tags.find((t) => t[0] === 'price'); const pay = ev.tags.find((t) => t[0] === 'pay-link'); const x = tagValue(ev, 'x');
  if (!d || !lic || !terms || !price || !pay || !x) throw new Error('missing Music License Link tags');
  if (!LICENSE_USES.includes(lic[1] as LicenseUse)) throw new Error('unknown use');
  if (!HEX64.test(terms[1]) || !HEX64.test(x)) throw new Error('bad hash');
  const text = tagValue(ev, 'terms-text');
  const textMatches = text !== undefined && termsHash(text) === terms[1];
  if (text !== undefined && !textMatches) throw new Error('terms text does not match terms hash');
  const releaseEventId = ev.tags.find((t) => t[0] === 'e' && t[3] === 'release')?.[1];
  return {
    event: ev, artist: ev.pubkey, coordinate: `${KIND.LISTING_ACTIVE}:${ev.pubkey}:${d}`, d,
    trackId: d.split(':')[0], use: lic[1] as LicenseUse,
    price: { amount: price[1], currency: price[2], frequency: price[3] },
    trackSha256: x, releaseEventId,
    terms: { hash: terms[1], url: terms[2] || undefined, text, textMatches },
    license: { territory: lic[2], term: lic[3], exclusivity: lic[4] },
    payLink: { url: pay[1], methods: pay.slice(2) },
    splits: tagsOf(ev, 'zap').map((t) => ({ pubkey: t[1], relay: t[2] || undefined, weight: Number(t[3] ?? 1) })),
  };
}

// ─── PayTo binding (NIP-A3 draft, proposed type) ─────────────────────────────

export function buildPayToBinding(nodePubkey: string, artistSecretKey: Uint8Array, createdAt = now()): NostrEvent {
  if (!/^0[23][0-9a-f]{64}$/.test(nodePubkey)) throw new Error('node key must be 66-hex compressed');
  return finalizeEvent({ kind: KIND.PAYTO_BINDING, created_at: createdAt, tags: [['payto', 'lightning-node', nodePubkey]], content: '' }, artistSecretKey) as NostrEvent;
}
export function payToNodes(binding: NostrEvent, artistPubkey: string): string[] {
  if (binding.kind !== KIND.PAYTO_BINDING || binding.pubkey !== artistPubkey || !verifyFresh(binding)) return [];
  return binding.tags.filter((t) => t[0] === 'payto' && t[1] === 'lightning-node').map((t) => t[2]);
}

// ─── Licence-signer authorization (PROPOSED kind 3403) ───────────────────────

/** Artist authorizes a subkey (or NIP-46 bunker key) to sign licence grants, optionally until an expiry. */
export function buildSignerAuthorization(signerPubkey: string, artistSecretKey: Uint8Array, opts: { expiresAt?: number; createdAt?: number } = {}): NostrEvent {
  const tags: string[][] = [['p', signerPubkey], ['k', String(KIND.PROPOSED_LICENSE_GRANT)]];
  if (opts.expiresAt) tags.push(['expiration', String(opts.expiresAt)]);
  return finalizeEvent({ kind: KIND.PROPOSED_LICENSE_SIGNER_AUTH, created_at: opts.createdAt ?? now(), tags, content: 'PROPOSED: authorizes this key to sign Music License Link grants.' }, artistSecretKey) as NostrEvent;
}

// ─── Licence grant / signed receipt (PROPOSED kind 3402) ─────────────────────

export interface LicensePayment {
  network: string; // e.g. lnbtc:000000000019d6689c085ae165831e93
  paymentHash: string;
  amountMsat: string;
  invoice: string;
  /** Revealed only after settlement (the replay store has consumed it). Never logged. */
  preimage?: string;
  requestHash?: string;
  requestProfile?: string;
}
export interface SplitProof { pubkey: string; invoice: string; preimage?: string; amountMsat: string }

export interface GrantParams {
  offer: NostrEvent;
  buyerPubkey: string;
  project?: string;
  payment: LicensePayment;
  splitProofs?: SplitProof[];
  authorizationEventId?: string;
  issuedAt?: number;
}

export function buildLicenseGrant(p: GrantParams, signerSecretKey: Uint8Array): NostrEvent {
  const o = parseLicenseOffer(p.offer);
  const tags: string[][] = [
    ['a', o.coordinate], ['e', o.event.id, '', 'offer'],
    ['p', p.buyerPubkey, '', 'licensee'], ['p', o.artist, '', 'licensor'],
    ['use', o.use], ['terms', o.terms.hash], ['x', o.trackSha256],
    ['license', o.use, o.license.territory, o.license.term, o.license.exclusivity],
    ['payment', p.payment.network, p.payment.paymentHash, p.payment.amountMsat, p.payment.invoice],
  ];
  if (p.payment.preimage) tags.push(['preimage', p.payment.preimage]);
  if (p.payment.requestHash) tags.push(['request', p.payment.requestHash, p.payment.requestProfile ?? 'http:1']);
  if (o.releaseEventId) tags.push(['e', o.releaseEventId, '', 'release']);
  if (p.authorizationEventId) tags.push(['e', p.authorizationEventId, '', 'signer-auth']);
  if (p.project) tags.push(['project', p.project]);
  for (const s of p.splitProofs ?? []) tags.push(['split-payment', s.pubkey, s.amountMsat, s.invoice, s.preimage ?? '']);
  return finalizeEvent({
    kind: KIND.PROPOSED_LICENSE_GRANT, created_at: p.issuedAt ?? now(), tags,
    content: `Licence granted (${o.use}) under terms ${o.terms.hash}. PROPOSED event kind; see offer for full text.`,
  }, signerSecretKey) as NostrEvent;
}

// ─── Verifier ────────────────────────────────────────────────────────────────

export interface VerifyLicenseInput {
  grant: NostrEvent;
  offer: NostrEvent;
  artistPubkey: string;
  /** Required if the grant is signed by a key other than the artist. */
  signerAuthorization?: NostrEvent;
  /** Artist's kind 10133 binding; required to check the invoice payee. */
  payToBinding?: NostrEvent;
  /** Licence text fetched from terms URL, if not inline. */
  termsText?: string;
  /** Proof-of-release event and (optional) its verified OTS time. */
  releaseEvent?: NostrEvent;
  releaseAnchoredAt?: number;
  /** Recompute requestHash from the published request (verifier supplies the hash computed via x402-lnbtc). */
  recomputedRequestHash?: string;
  /** Optional: SHA-256 of a master file the verifier hashed themselves. */
  masterSha256?: string;
  splitTolerancesMsat?: number;
}
export interface VerifyCheck { id: string; ok: boolean; detail?: string }
export interface VerifyLicenseResult { valid: boolean; checks: VerifyCheck[]; limits: string[] }

export function verifyLicense(i: VerifyLicenseInput): VerifyLicenseResult {
  const checks: VerifyCheck[] = [];
  const add = (id: string, ok: boolean, detail?: string) => checks.push({ id, ok, detail });
  const g = i.grant;
  // 1. signatures + signer authority
  add('grant-signature', g.kind === KIND.PROPOSED_LICENSE_GRANT && verifyFresh(g));
  if (g.pubkey === i.artistPubkey) add('signer-authorized', true, 'signed by artist key');
  else {
    const a = i.signerAuthorization;
    const exp = a ? Number(tagValue(a, 'expiration') ?? Infinity) : 0;
    const ok = !!a && a.kind === KIND.PROPOSED_LICENSE_SIGNER_AUTH && a.pubkey === i.artistPubkey && verifyFresh(a) &&
      tagValue(a, 'p') === g.pubkey && tagValue(a, 'k') === String(KIND.PROPOSED_LICENSE_GRANT) && g.created_at <= exp && a.created_at <= g.created_at;
    add('signer-authorized', ok, ok ? 'artist-signed authorization' : 'signer not authorized by artist');
  }
  // 2. offer
  let o: ParsedOffer | undefined;
  try { o = parseLicenseOffer(i.offer); add('offer-valid', o.artist === i.artistPubkey, o.artist === i.artistPubkey ? undefined : 'offer not by artist'); } catch (e) { add('offer-valid', false, (e as Error).message); }
  if (o) {
    add('grant-references-offer', tagValue(g, 'a') === o.coordinate && g.tags.some((t) => t[0] === 'e' && t[1] === o!.event.id));
    const text = o.terms.text ?? i.termsText;
    add('terms-hash', tagValue(g, 'terms') === o.terms.hash && text !== undefined && termsHash(text) === o.terms.hash, text === undefined ? 'no terms text supplied' : undefined);
    add('use-matches', tagValue(g, 'use') === o.use);
    // 3. track hash
    const gx = tagValue(g, 'x');
    let xok = gx === o.trackSha256;
    if (i.releaseEvent) xok = xok && verifyFresh(i.releaseEvent) && i.releaseEvent.pubkey === i.artistPubkey && tagValue(i.releaseEvent, 'ox') === gx;
    if (i.masterSha256) xok = xok && i.masterSha256 === gx;
    add('track-hash', xok);
    // 4. anchor time before licence
    if (i.releaseAnchoredAt !== undefined) add('release-anchored-before-licence', i.releaseAnchoredAt <= g.created_at);
  }
  // 5. payment
  const pay = g.tags.find((t) => t[0] === 'payment');
  const pre = tagValue(g, 'preimage');
  if (!pay) add('payment', false, 'no payment tag');
  else {
    const [, network, ph, msat, invoice] = pay;
    try {
      const d = decodeBolt11Strict(invoice);
      add('invoice-decodes', true);
      add('invoice-hash-matches', d.paymentHash === ph);
      add('invoice-amount', d.amountMsat === msat);
      add('invoice-network', NETWORK_CURRENCY[network] === d.currency || (network.startsWith('regtest') && d.currency === 'bcrt'));
      if (i.payToBinding) add('invoice-payee-is-artist-node', payToNodes(i.payToBinding, i.artistPubkey).includes(d.payeeNodeKey));
      add('preimage', !!pre && sha(Buffer.from(pre, 'hex')) === ph, pre ? undefined : 'preimage not revealed');
      const rq = g.tags.find((t) => t[0] === 'request');
      if (rq) {
        add('invoice-commits-to-request', d.descriptionHash === rq[1]);
        if (i.recomputedRequestHash) add('request-recomputed', i.recomputedRequestHash === rq[1]);
      }
      if (o) {
        // price check only when offer is priced in sats
        if (o.price.currency.toUpperCase() === 'SAT' || o.price.currency.toUpperCase() === 'SATS') {
          const totalSplit = tagsOf(g, 'split-payment').reduce((s, t) => s + BigInt(t[2]), 0n);
          add('amount-covers-price', BigInt(msat) + totalSplit >= BigInt(Math.round(Number(o.price.amount) * 1000)));
        }
      }
    } catch (e) { add('invoice-decodes', false, (e as Error).message); }
  }
  // 7. splits
  if (o && o.splits.length) {
    const total = o.splits.reduce((s, x) => s + x.weight, 0);
    const sp = tagsOf(g, 'split-payment');
    const licMsat = BigInt(pay?.[3] ?? '0');
    const sum = licMsat + sp.reduce((s, t) => s + BigInt(t[2]), 0n);
    const tol = BigInt(i.splitTolerancesMsat ?? 1000);
    for (const s of o.splits) {
      if (s.pubkey === o.artist) continue; // licensor share = main payment
      const t = sp.find((x) => x[1] === s.pubkey);
      if (!t) { add(`split:${s.pubkey.slice(0, 8)}`, false, 'missing split payment'); continue; }
      let ok = false;
      try {
        const d = decodeBolt11Strict(t[3]);
        const expected = (sum * BigInt(Math.round(s.weight * 1e6))) / BigInt(Math.round(total * 1e6));
        const diff = BigInt(t[2]) > expected ? BigInt(t[2]) - expected : expected - BigInt(t[2]);
        ok = d.amountMsat === t[2] && diff <= tol && !!t[4] && sha(Buffer.from(t[4], 'hex')) === d.paymentHash;
      } catch { ok = false; }
      add(`split:${s.pubkey.slice(0, 8)}`, ok);
    }
  }
  return {
    valid: checks.every((c) => c.ok),
    checks,
    limits: [
      'Proves an invoice from the bound node was paid and a licence was issued by an artist-authorized key.',
      'Cannot prove the payer was not the artist (self-dealing passes every check).',
      'Proof of release shows the file existed by a date; it does not prove authorship or ownership.',
      'Licence terms are a PROPOSED draft pending legal review; event kinds 3402/3403 are PROPOSED.',
    ],
  };
}

export { getPublicKey };
