/**
 * license-server.ts - Artist-side "pay link": x402 exact/lnbtc resource server
 * + in-process facilitator that issues a signed licence grant after payment.
 *
 * Request: POST <pay-link> with JSON body
 *   { "offer": "<offer event id>", "buyer": "<hex pubkey>", "project": "...",
 *     "splitProofs": [{ "pubkey", "invoice", "preimage", "amountMsat" }] }
 * The http:1 binding hashes the exact body bytes, so the buyer key, project and
 * split proofs are all bound into the licensor invoice.
 *
 * First call (no payment) → 402 with PaymentRequired { x402Version:2, resource,
 * accepts:[requirements] }. Paid retry carries the PaymentPayload (header
 * `PAYMENT-SIGNATURE`, base64 JSON, per x402 v2 HTTP transport) → settle →
 * 200 with the grant. Also supports the existing L402 module separately.
 *
 * Status: in-process and tested with mock Lightning. Not deployed.
 */
import { createHash } from 'node:crypto';
import type { NostrEvent } from './types.js';
import { parseLicenseOffer, buildLicenseGrant, type SplitProof } from './license.js';
import { createLnbtcChallenge, settleLnbtc, computeRequestHash, type ReceiverAdapter, type ReplayStore, type LnbtcPaymentPayload, type LnbtcPaymentRequirements, type HttpRequestLike, type ServerResourceConfig } from './x402-lnbtc.js';
import { decodeBolt11Strict } from './bolt11-strict.js';

export interface PayLinkConfig {
  url: string; // public pay-link URL (exact spelling used in the binding)
  network: string;
  offers: NostrEvent[];
  receiver: ReceiverAdapter;
  replay: ReplayStore;
  signerSecretKey: Uint8Array; // licence signer (subkey authorized by artist; not the artist nsec)
  authorizationEventId?: string;
  /** Convert an offer price to msat. Required for non-sat currencies (rate source is your choice). */
  priceToMsat?: (price: { amount: string; currency: string }) => Promise<string>;
  maxTimeoutSeconds?: number;
  clock?: () => number;
  allowIssue?: () => boolean;
}

export type PayLinkResponse =
  | { status: 402; body: { x402Version: 2; error?: string; resource: { url: string }; accepts: LnbtcPaymentRequirements[] } }
  | { status: 200; body: { grant: NostrEvent; settlement: { transaction: string; network: string } } }
  | { status: 400 | 404 | 409; body: { error: string } };

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

async function totalMsat(cfg: PayLinkConfig, price: { amount: string; currency: string }): Promise<bigint> {
  const c = price.currency.toUpperCase();
  if (c === 'SAT' || c === 'SATS') return BigInt(Math.round(Number(price.amount) * 1000));
  if (c === 'MSAT') return BigInt(price.amount);
  if (!cfg.priceToMsat) throw new Error(`no converter for ${price.currency}`);
  return BigInt(await cfg.priceToMsat(price));
}

/** Licensor share = total − Σ non-licensor split weights. */
export function licensorShareMsat(total: bigint, splits: { pubkey: string; weight: number }[], artist: string): { licensor: bigint; others: { pubkey: string; msat: bigint }[] } {
  if (!splits.length) return { licensor: total, others: [] };
  const W = splits.reduce((s, x) => s + x.weight, 0);
  const others = splits.filter((s) => s.pubkey !== artist).map((s) => ({ pubkey: s.pubkey, msat: (total * BigInt(Math.round(s.weight * 1e6))) / BigInt(Math.round(W * 1e6)) }));
  return { licensor: total - others.reduce((s, x) => s + x.msat, 0n), others };
}

export async function quoteSplits(cfg: PayLinkConfig, offerId: string) {
  const ev = cfg.offers.find((o) => o.id === offerId); if (!ev) throw new Error('unknown offer');
  const o = parseLicenseOffer(ev);
  return licensorShareMsat(await totalMsat(cfg, o.price), o.splits, o.artist);
}

export async function handleLicenseRequest(cfg: PayLinkConfig, req: HttpRequestLike, payment?: LnbtcPaymentPayload): Promise<PayLinkResponse> {
  const now = (cfg.clock ?? (() => Math.floor(Date.now() / 1000)))();
  if (req.method !== 'POST' || req.url !== cfg.url) return { status: 404, body: { error: 'not found' } };
  const bodyBuf = Buffer.from(typeof req.body === 'string' ? req.body : req.body ?? new Uint8Array());
  let body: { offer: string; buyer: string; project?: string; splitProofs?: SplitProof[] };
  try { body = JSON.parse(bodyBuf.toString('utf8')); } catch { return { status: 400, body: { error: 'invalid JSON' } }; }
  if (!/^[0-9a-f]{64}$/.test(body.buyer ?? '')) return { status: 400, body: { error: 'buyer must be hex pubkey' } };
  const offerEv = cfg.offers.find((o) => o.id === body.offer);
  if (!offerEv) return { status: 404, body: { error: 'unknown offer' } };
  const offer = parseLicenseOffer(offerEv);
  const { licensor, others } = licensorShareMsat(await totalMsat(cfg, offer.price), offer.splits, offer.artist);
  // Validate split proofs (non-atomic: paid before the licensor invoice).
  const proofs = body.splitProofs ?? [];
  for (const s of others) {
    const p = proofs.find((x) => x.pubkey === s.pubkey);
    if (!p || !p.preimage) return { status: 400, body: { error: `missing split proof for ${s.pubkey}` } };
    try {
      const d = decodeBolt11Strict(p.invoice);
      if (d.amountMsat !== s.msat.toString() || p.amountMsat !== d.amountMsat) return { status: 400, body: { error: 'split amount mismatch' } };
      if (sha(Buffer.from(p.preimage, 'hex')) !== d.paymentHash) return { status: 400, body: { error: 'split preimage mismatch' } };
    } catch { return { status: 400, body: { error: 'split invoice invalid' } }; }
  }
  const rcfg: ServerResourceConfig = {
    network: cfg.network, amountMsat: licensor.toString(), maxTimeoutSeconds: cfg.maxTimeoutSeconds ?? 300,
    profile: 'http:1', params: { headers: ['content-type'] }, allowIssue: cfg.allowIssue,
  };
  const reqForBinding: HttpRequestLike = { ...req, body: bodyBuf };
  const challenge = async (error?: string): Promise<PayLinkResponse> => ({
    status: 402, body: { x402Version: 2, error, resource: { url: cfg.url }, accepts: [await createLnbtcChallenge(rcfg, cfg.receiver, reqForBinding, now)] },
  });
  if (!payment) return challenge();
  const requestHash = computeRequestHash(rcfg, reqForBinding);
  const requirements: LnbtcPaymentRequirements = {
    scheme: 'exact', network: cfg.network, amount: rcfg.amountMsat, asset: 'BTC', payTo: cfg.receiver.nodePubkey, maxTimeoutSeconds: rcfg.maxTimeoutSeconds,
    extra: { assetTransferMethod: 'bolt11', paymentFlow: 'upfront', requestHash, requestBindingProfile: 'http:1', requestBindingParams: rcfg.params, invoice: payment.accepted?.extra?.invoice ?? '' },
  };
  // Split hashes are consumed too, so one split payment can't back two licences.
  for (const p of proofs) {
    const d = decodeBolt11Strict(p.invoice);
    if (await cfg.replay.has(`${cfg.network}:split:${d.paymentHash}`)) return { status: 409, body: { error: 'duplicate_settlement (split)' } };
  }
  const s = await settleLnbtc(payment, requirements, cfg.replay, { nowUnix: now });
  if (!s.success) return s.errorReason === 'duplicate_settlement' ? { status: 409, body: { error: 'duplicate_settlement' } } : challenge(s.errorReason);
  for (const p of proofs) {
    const d = decodeBolt11Strict(p.invoice);
    if (!(await cfg.replay.insert(`${cfg.network}:split:${d.paymentHash}`, now + 86400 * 365))) return { status: 409, body: { error: 'duplicate_settlement (split)' } };
  }
  const inv = decodeBolt11Strict(payment.accepted.extra.invoice);
  const grant = buildLicenseGrant({
    offer: offerEv, buyerPubkey: body.buyer, project: body.project, authorizationEventId: cfg.authorizationEventId, issuedAt: now,
    payment: { network: cfg.network, paymentHash: inv.paymentHash, amountMsat: inv.amountMsat!, invoice: inv.paymentRequest, preimage: payment.payload.preimage, requestHash, requestProfile: 'http:1' },
    splitProofs: proofs,
  }, cfg.signerSecretKey);
  return { status: 200, body: { grant, settlement: { transaction: s.transaction!, network: s.network! } } };
}

/** x402 v2 HTTP header helpers. */
export const encodePaymentHeader = (p: LnbtcPaymentPayload) => Buffer.from(JSON.stringify(p)).toString('base64');
export const decodePaymentHeader = (h: string): LnbtcPaymentPayload => JSON.parse(Buffer.from(h, 'base64').toString('utf8'));
