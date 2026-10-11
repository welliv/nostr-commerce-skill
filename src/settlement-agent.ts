/**
 * settlement-agent.ts - Platform settlement agent for Music License Link.
 *
 * Buys licences for a platform's users within hard limits:
 *   discover → qualify → decide (policy) → pay splits → pay licence (x402
 *   lnbtc) → verify grant → store bundle (grant + offer + release + .ots) →
 *   signed, hash-chained audit log.
 *
 * Controls: per-licence cap, daily cap, artist / terms-hash / use / network
 * allowlists, human-approval rules, kill switch (checked before every payment),
 * per-offer-per-buyer rate limit. Splits are SEPARATE Lightning payments made
 * before the licensor payment; they are NOT atomic (a failure after splits are
 * paid leaves them paid — logged as credit).
 *
 * Status: tested end to end with mock Lightning and an in-process pay link.
 * Never run against mainnet. Mirror the daily cap as an NWC wallet budget too:
 * the in-agent cap alone is only as strong as this process.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getPublicKey } from 'nostr-tools';
import type { NostrEvent } from './types.js';
import { parseLicenseOffer, verifyLicense, type ParsedOffer, type LicenseUse, type SplitProof } from './license.js';
import { payLnbtcChallenge, type PayerAdapter, type LnbtcPaymentRequirements, type LnbtcPaymentPayload, LnbtcError } from './x402-lnbtc.js';
import { verifyOts, type BlockHeaderSource } from './proof-of-release.js';
import { AuditLog } from './audit-log.js';
import { decodeBolt11Strict } from './bolt11-strict.js';
import { verifyFresh, tagValue } from './nostr-verify.js';

export interface SpendPolicy {
  perLicenseCapMsat: bigint;
  dailyCapMsat: bigint;
  artistAllowlist: string[];
  termsAllowlist: string[];
  useAllowlist: LicenseUse[];
  networkAllowlist: string[];
  /** Above this, a human must approve (defaults to perLicenseCapMsat). Over-cap purchases are always refused. */
  approvalThresholdMsat?: bigint;
  requireAnchoredRelease?: boolean; // default true
  rateLimitSeconds?: number; // default 600
}

export interface PayLinkTransport {
  /** POST JSON body to the pay link; include payment payload when given. */
  post(url: string, body: string, payment?: LnbtcPaymentPayload): Promise<{ status: number; body: any }>;
}

export interface AgentDeps {
  platformSecretKey: Uint8Array;
  payer: PayerAdapter;
  transport: PayLinkTransport;
  /** Query relays for kind 30402 events (inject SimplePool in production). */
  fetchEvents: (filter: Record<string, unknown>) => Promise<NostrEvent[]>;
  /** Resolve an invoice for a split recipient (e.g. lud16 / LNURL-pay). */
  splitInvoice: (pubkey: string, amountMsat: bigint) => Promise<string>;
  /** .ots proof for a release event's master hash, if available. */
  fetchOts?: (masterSha256: string) => Promise<Uint8Array | undefined>;
  headers?: BlockHeaderSource;
  /** Kind 10133 binding + signer authorization lookups for the verifier. */
  fetchPayToBinding?: (artist: string) => Promise<NostrEvent | undefined>;
  fetchSignerAuth?: (artist: string, signer: string) => Promise<NostrEvent | undefined>;
  dataDir: string;
  /** Kill switch: returns true to stop all payments. Default: file `<dataDir>/KILL` exists or env SETTLEMENT_KILL=1. */
  killSwitch?: () => boolean;
  clock?: () => number;
}

export type BuyResult =
  | { status: 'licensed'; grant: NostrEvent; bundlePath: string; paidMsat: string }
  | { status: 'needs_approval'; approvalId: string; reasons: string[] }
  | { status: 'rejected'; reasons: string[] }
  | { status: 'failed'; reason: string; splitsPaidMsat?: string };

interface State { daily: Record<string, string>; seenArtists: string[]; seenTerms: string[]; lastBuy: Record<string, number>; approvals: Record<string, { offerId: string; approved: boolean; reasons: string[] }>; credits: Array<{ offer: string; msat: string; hashes: string[] }> }

export class SettlementAgent {
  readonly log: AuditLog; readonly pubkey: string; private statePath: string; private st: State;
  constructor(private policy: SpendPolicy, private d: AgentDeps) {
    fs.mkdirSync(path.join(d.dataDir, 'bundles'), { recursive: true });
    this.log = new AuditLog(path.join(d.dataDir, 'audit.jsonl'), d.platformSecretKey);
    this.pubkey = getPublicKey(d.platformSecretKey);
    this.statePath = path.join(d.dataDir, 'state.json');
    this.st = fs.existsSync(this.statePath) ? JSON.parse(fs.readFileSync(this.statePath, 'utf8')) : { daily: {}, seenArtists: [], seenTerms: [], lastBuy: {}, approvals: {}, credits: [] };
  }
  private save() { fs.writeFileSync(this.statePath, JSON.stringify(this.st, null, 2)); }
  private now() { return (this.d.clock ?? (() => Math.floor(Date.now() / 1000)))(); }
  private day() { return new Date(this.now() * 1000).toISOString().slice(0, 10); }
  private spentToday() { return BigInt(this.st.daily[this.day()] ?? '0'); }
  private addSpend(m: bigint) { this.st.daily[this.day()] = (this.spentToday() + m).toString(); this.save(); }
  killed(): boolean {
    if (this.d.killSwitch) return this.d.killSwitch();
    return process.env.SETTLEMENT_KILL === '1' || fs.existsSync(path.join(this.d.dataDir, 'KILL'));
  }

  /** Discover offers for a use; dedupe by coordinate keeping newest; only valid signatures. */
  async discover(use: LicenseUse, topics: string[] = []): Promise<ParsedOffer[]> {
    const evs = await this.d.fetchEvents({ kinds: [30402], '#t': [`license-${use}`, ...topics].slice(0, 1), limit: 200 });
    const best = new Map<string, ParsedOffer>();
    for (const e of evs) {
      try { const o = parseLicenseOffer(e); if (o.use !== use) continue; const cur = best.get(o.coordinate); if (!cur || cur.event.created_at < e.created_at) best.set(o.coordinate, o); } catch { /* skip invalid */ }
    }
    const out = [...best.values()].filter((o) => topics.every((t) => o.event.tags.some((x) => x[0] === 't' && x[1] === t)));
    this.log.append('discover', { use, topics, found: out.length, offers: out.map((o) => o.event.id) }, this.now());
    return out;
  }

  /** Hard policy (reject) + soft policy (needs human approval). */
  async evaluate(o: ParsedOffer, priceMsat: bigint, buyer: string): Promise<{ reject: string[]; approve: string[] }> {
    const p = this.policy; const reject: string[] = []; const approve: string[] = [];
    if (!p.artistAllowlist.includes(o.artist)) reject.push('artist-not-allowlisted');
    if (!p.termsAllowlist.includes(o.terms.hash)) reject.push('terms-hash-not-allowlisted');
    if (!p.useAllowlist.includes(o.use)) reject.push('use-not-allowlisted');
    if (!o.payLink.methods.includes('x402:exact:lnbtc')) reject.push('no-x402-lnbtc-pay-method');
    if (priceMsat > p.perLicenseCapMsat) reject.push('over-per-licence-cap');
    if (this.spentToday() + priceMsat > p.dailyCapMsat) reject.push('over-daily-cap');
    const rl = p.rateLimitSeconds ?? 600; const last = this.st.lastBuy[`${o.coordinate}|${buyer}`];
    if (last && this.now() - last < rl) reject.push('rate-limited');
    if (priceMsat > (p.approvalThresholdMsat ?? p.perLicenseCapMsat)) approve.push('above-approval-threshold');
    if (!this.st.seenArtists.includes(o.artist)) approve.push('first-purchase-from-artist');
    if (!this.st.seenTerms.includes(o.terms.hash)) approve.push('new-terms-template');
    if (this.now() - o.event.created_at < 86400) approve.push('offer-changed-in-last-24h');
    // proof of release
    if (p.requireAnchoredRelease !== false) {
      let anchored = false;
      if (this.d.fetchOts && this.d.headers) {
        const ots = await this.d.fetchOts(o.trackSha256);
        if (ots) anchored = (await verifyOts(ots, o.trackSha256, this.d.headers)).status === 'verified';
      }
      if (!anchored) approve.push('proof-of-release-missing-or-unanchored');
    }
    return { reject, approve };
  }

  /** Human approval of a queued purchase (call from your admin UI). */
  approve(approvalId: string): void {
    const a = this.st.approvals[approvalId]; if (!a) throw new Error('unknown approval');
    a.approved = true; this.save();
    this.log.append('approval', { approvalId, offer: a.offerId }, this.now());
  }

  async buy(args: { offer: ParsedOffer; buyer: string; project?: string; priceMsat: bigint; approvalId?: string }): Promise<BuyResult> {
    const { offer: o, buyer } = args;
    
    const { reject, approve } = await this.evaluate(o, args.priceMsat, buyer);
    this.log.append('qualify', { offer: o.event.id, coordinate: o.coordinate, reject, approve, priceMsat: args.priceMsat.toString() }, this.now());
    if (reject.length) { this.log.append('decision', { offer: o.event.id, decision: 'reject', rules: reject }, this.now()); return { status: 'rejected', reasons: reject }; }
    const appr = args.approvalId ? this.st.approvals[args.approvalId] : undefined;
    if (approve.length && !(appr && appr.approved && appr.offerId === o.event.id)) {
      const approvalId = `ap-${o.event.id.slice(0, 12)}-${this.now()}`;
      this.st.approvals[approvalId] = { offerId: o.event.id, approved: false, reasons: approve }; this.save();
      this.log.append('approval_request', { approvalId, offer: o.event.id, rules: approve }, this.now());
      return { status: 'needs_approval', approvalId, reasons: approve };
    }
    this.log.append('decision', { offer: o.event.id, decision: 'buy', rules: approve }, this.now());

    // 1. initial request → 402 to learn licensor share; split amounts from offer.
    const quoteBody = (proofs: SplitProof[]) => JSON.stringify({ offer: o.event.id, buyer, project: args.project, splitProofs: proofs });
    const W = o.splits.reduce((s, x) => s + x.weight, 0);
    const others = o.splits.filter((s) => s.pubkey !== o.artist).map((s) => ({ pubkey: s.pubkey, msat: (args.priceMsat * BigInt(Math.round(s.weight * 1e6))) / BigInt(Math.round(W * 1e6)) }));
    const proofs: SplitProof[] = []; let splitsPaid = 0n;
    for (const s of others) {
      if (this.killed()) { this.log.append('kill_switch', { offer: o.event.id, stage: 'split' }, this.now()); return { status: 'failed', reason: 'kill-switch', splitsPaidMsat: splitsPaid.toString() }; }
      const inv = await this.d.splitInvoice(s.pubkey, s.msat);
      const dec = decodeBolt11Strict(inv);
      if (dec.amountMsat !== s.msat.toString()) return this.fail(o, 'split-invoice-amount-mismatch', splitsPaid);
      if (!this.policy.networkAllowlist.some((n) => (n.endsWith('19d6689c085ae165831e93') ? 'bc' : 'tb') === dec.currency)) return this.fail(o, 'split-invoice-wrong-network', splitsPaid);
      this.log.append('invoice_received', { offer: o.event.id, kind: 'split', to: s.pubkey, payment_hash: dec.paymentHash, msat: s.msat.toString() }, this.now());
      const r = await this.d.payer.payInvoice(inv);
      if (r.status !== 'paid' || !r.preimage) return this.fail(o, `split-payment-${r.status}`, splitsPaid);
      splitsPaid += s.msat; this.addSpend(s.msat);
      this.log.append('payment_sent', { offer: o.event.id, kind: 'split', to: s.pubkey, payment_hash: dec.paymentHash, msat: s.msat.toString() }, this.now());
      proofs.push({ pubkey: s.pubkey, invoice: inv, preimage: r.preimage, amountMsat: s.msat.toString() });
    }
    const body = quoteBody(proofs);
    const first = await this.d.transport.post(o.payLink.url, body);
    if (first.status !== 402) return this.fail(o, `pay-link-unexpected-${first.status}`, splitsPaid);
    const req: LnbtcPaymentRequirements | undefined = first.body.accepts?.find((a: any) => a.scheme === 'exact' && this.policy.networkAllowlist.includes(a.network));
    if (!req) return this.fail(o, 'no-acceptable-network', splitsPaid);
    const licMsat = BigInt(req.amount);
    if (licMsat + splitsPaid > args.priceMsat || licMsat + splitsPaid > this.policy.perLicenseCapMsat) return this.fail(o, 'challenge-amount-above-quoted-price', splitsPaid);
    // payTo must match artist's kind 10133 binding when available
    const binding = this.d.fetchPayToBinding ? await this.d.fetchPayToBinding(o.artist) : undefined;
    if (binding) {
      const nodes = binding.tags.filter((t) => t[0] === 'payto' && t[1] === 'lightning-node').map((t) => t[2]);
      if (!verifyFresh(binding) || binding.pubkey !== o.artist || !nodes.includes(req.payTo)) return this.fail(o, 'payee-not-artist-node', splitsPaid);
    }
    this.log.append('invoice_received', { offer: o.event.id, kind: 'licensor', payment_hash: decodeBolt11Strict(req.extra.invoice).paymentHash, msat: req.amount, consumption_key: `${req.network}:${decodeBolt11Strict(req.extra.invoice).paymentHash}` }, this.now());
    if (this.killed()) { this.log.append('kill_switch', { offer: o.event.id, stage: 'licensor' }, this.now()); return { status: 'failed', reason: 'kill-switch', splitsPaidMsat: splitsPaid.toString() }; }
    let payload: LnbtcPaymentPayload;
    try {
      payload = await payLnbtcChallenge(req, { expectedProfile: 'http:1', request: { method: 'POST', url: o.payLink.url, body, headers: { 'content-type': 'application/json' } }, resourceUrl: first.body.resource?.url, allowedNetworks: this.policy.networkAllowlist, maxAmountMsat: (args.priceMsat - splitsPaid).toString(), nowUnix: this.now() }, this.d.payer);
    } catch (e) { return this.fail(o, e instanceof LnbtcError ? e.reason : 'payment-error', splitsPaid); }
    this.addSpend(licMsat);
    this.log.append('payment_sent', { offer: o.event.id, kind: 'licensor', payment_hash: decodeBolt11Strict(req.extra.invoice).paymentHash, msat: req.amount }, this.now());
    const second = await this.d.transport.post(o.payLink.url, body, payload);
    if (second.status !== 200) return this.fail(o, `licence-not-issued-${second.status}:${second.body?.error ?? ''}`, splitsPaid + licMsat);
    const grant: NostrEvent = second.body.grant;
    this.log.append('license_received', { offer: o.event.id, grant: grant.id }, this.now());
    // verify
    const auth = grant.pubkey !== o.artist && this.d.fetchSignerAuth ? await this.d.fetchSignerAuth(o.artist, grant.pubkey) : undefined;
    const ots = this.d.fetchOts ? await this.d.fetchOts(o.trackSha256) : undefined;
    const otsRes = ots && this.d.headers ? await verifyOts(ots, o.trackSha256, this.d.headers) : undefined;
    const v = verifyLicense({ grant, offer: o.event, artistPubkey: o.artist, signerAuthorization: auth, payToBinding: binding, releaseAnchoredAt: otsRes?.status === 'verified' ? otsRes.attestedTime : undefined });
    if (tagValue(grant, 'p') !== buyer) v.checks.push({ id: 'licensee-is-buyer', ok: false }), (v.valid = false);
    this.log.append('license_verified', { grant: grant.id, valid: v.valid, failed: v.checks.filter((c) => !c.ok).map((c) => c.id) }, this.now());
    const bundle = { version: 1, grant, offer: o.event, verification: v, ots: ots ? Buffer.from(ots).toString('base64') : null, otsResult: otsRes ?? null, splitProofs: proofs, savedAt: this.now() };
    const bundlePath = path.join(this.d.dataDir, 'bundles', `${grant.id}.json`);
    fs.writeFileSync(bundlePath, JSON.stringify(bundle, null, 2), { mode: 0o600 });
    this.st.seenArtists = [...new Set([...this.st.seenArtists, o.artist])];
    this.st.seenTerms = [...new Set([...this.st.seenTerms, o.terms.hash])];
    this.st.lastBuy[`${o.coordinate}|${buyer}`] = this.now(); this.save();
    if (!v.valid) return { status: 'failed', reason: 'licence-verification-failed' };
    return { status: 'licensed', grant, bundlePath, paidMsat: (licMsat + splitsPaid).toString() };
  }

  private fail(o: ParsedOffer, reason: string, paid: bigint): BuyResult {
    this.log.append(paid > 0n ? 'payment_failed' : 'error', { offer: o.event.id, reason, paid_msat: paid.toString() }, this.now());
    if (paid > 0n) { this.st.credits.push({ offer: o.event.id, msat: paid.toString(), hashes: [] }); this.save(); }
    return { status: 'failed', reason, splitsPaidMsat: paid.toString() };
  }
}
