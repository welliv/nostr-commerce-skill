/**
 * x402-lnbtc.ts - x402 v2 `exact` scheme on Bitcoin Lightning (`lnbtc`).
 *
 * Implements x402-foundation/x402 specs/schemes/exact/scheme_exact_lnbtc.md
 * (merged spec): request binding (http:1, mcp:1), server challenge
 * construction, client validation + payment, facilitator /settle validation,
 * paid-but-expired policy and replay protection with the canonical
 * consumption key `network:payment_hash`.
 *
 * Status: implemented against the spec's published test vectors, with mocked
 * Lightning adapters. NOT yet run against a real Lightning node. The official
 * TypeScript mechanism in the x402 repo (PR #3688) was unmerged when this was
 * written; names here follow the spec text, not that PR.
 *
 * The existing L402 module (l402.ts) remains available alongside this.
 */
import canonicalizeMod from 'canonicalize';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { decodeBolt11Strict, type DecodedBolt11, Bolt11Error } from './bolt11-strict.js';

const canonicalize = canonicalizeMod as unknown as (o: unknown) => string | undefined;

export const LNBTC_MAINNET = 'lnbtc:000000000019d6689c085ae165831e93';
export const LNBTC_TESTNET = 'lnbtc:000000000933ea01ad0ee984209779ba';
export const NETWORK_CURRENCY: Record<string, string> = { [LNBTC_MAINNET]: 'bc', [LNBTC_TESTNET]: 'tb' };
export const DEFAULT_SKEW_SECONDS = 60;

export type LnbtcErrorReason =
  | 'unsupported_scheme' | 'network_mismatch' | 'unsupported_network'
  | 'invalid_exact_lnbtc_asset' | 'invalid_exact_lnbtc_amount' | 'invalid_exact_lnbtc_amount_mismatch'
  | 'invalid_exact_lnbtc_pay_to_mismatch' | 'invalid_exact_lnbtc_pay_to_malformed'
  | 'invalid_exact_lnbtc_max_timeout_mismatch' | 'invalid_exact_lnbtc_extra_mismatch'
  | 'invalid_exact_lnbtc_request_binding' | 'invalid_exact_lnbtc_request_mismatch'
  | 'invalid_exact_lnbtc_asset_transfer_method' | 'invalid_exact_lnbtc_payment_flow'
  | 'invalid_exact_lnbtc_invoice_missing' | 'invalid_exact_lnbtc_invoice_decode_failed'
  | 'invalid_exact_lnbtc_invoice_description' | 'invalid_exact_lnbtc_invoice_request_mismatch'
  | 'invalid_exact_lnbtc_invoice_payee_mismatch' | 'invalid_exact_lnbtc_invoice_currency_mismatch'
  | 'invalid_exact_lnbtc_invoice_amount_mismatch' | 'invalid_exact_lnbtc_max_timeout'
  | 'invalid_exact_lnbtc_invoice_expiry_mismatch' | 'invalid_exact_lnbtc_invoice_created_in_future'
  | 'duplicate_settlement' | 'invalid_exact_lnbtc_preimage_missing' | 'invalid_exact_lnbtc_preimage_malformed'
  | 'invalid_exact_lnbtc_preimage_length' | 'invalid_exact_lnbtc_preimage_hash_mismatch'
  | 'invalid_exact_lnbtc_invoice_expired'
  // local client/server reasons
  | 'exact_lnbtc_invoice_issuance_denied' | 'invalid_exact_lnbtc_payer_invoice_mismatch'
  | 'invalid_exact_lnbtc_payer_payment_hash_mismatch' | 'invalid_exact_lnbtc_payer_amount_mismatch'
  | 'exact_lnbtc_payment_in_flight' | 'exact_lnbtc_payment_not_paid'
  | 'invalid_exact_lnbtc_payer_preimage_required' | 'invalid_exact_lnbtc_payer_preimage_malformed'
  | 'invalid_exact_lnbtc_payer_preimage_hash_mismatch';

export class LnbtcError extends Error {
  constructor(public reason: LnbtcErrorReason, msg?: string) { super(msg ? `${reason}: ${msg}` : reason); }
}

export type BindingProfile = 'http:1' | 'mcp:1';
export interface LnbtcExtra {
  assetTransferMethod?: 'bolt11';
  paymentFlow: 'upfront';
  requestHash: string;
  requestBindingProfile: BindingProfile;
  requestBindingParams: { headers: string[] } | { server: string; metadata: string[] };
  invoice: string;
  [k: string]: unknown;
}
export interface LnbtcPaymentRequirements {
  scheme: 'exact';
  network: string;
  amount: string;
  asset: 'BTC';
  payTo: string;
  maxTimeoutSeconds: number;
  extra: LnbtcExtra;
}
export interface LnbtcPaymentPayload {
  x402Version: 2;
  accepted: LnbtcPaymentRequirements;
  payload: { preimage: string };
  resource?: unknown;
}
export interface SettlementResponse {
  success: boolean;
  transaction?: string;
  network?: string;
  errorReason?: LnbtcErrorReason;
}

// ─── Request binding ─────────────────────────────────────────────────────────

const HEX64 = /^[0-9a-f]{64}$/;
const HEX66 = /^0[23][0-9a-f]{64}$/;
const sha256hex = (b: Uint8Array) => bytesToHex(sha256(b));
export const jcs = (o: unknown): string => {
  const s = canonicalize(o);
  if (s === undefined) throw new LnbtcError('invalid_exact_lnbtc_request_binding', 'not JCS-serializable');
  return s;
};

export interface HttpRequestLike {
  method: string;
  url: string;
  body?: Uint8Array | string;
  headers?: Record<string, string | undefined>;
}

function validateHttpParams(p: unknown): { headers: string[] } {
  if (!p || typeof p !== 'object' || Array.isArray(p)) throw new LnbtcError('invalid_exact_lnbtc_request_binding');
  const keys = Object.keys(p);
  if (keys.length !== 1 || keys[0] !== 'headers') throw new LnbtcError('invalid_exact_lnbtc_request_binding');
  const h = (p as any).headers;
  if (!Array.isArray(h)) throw new LnbtcError('invalid_exact_lnbtc_request_binding');
  for (let i = 0; i < h.length; i++) {
    if (typeof h[i] !== 'string' || !/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(h[i])) throw new LnbtcError('invalid_exact_lnbtc_request_binding');
    if (h[i] === 'payment-signature') throw new LnbtcError('invalid_exact_lnbtc_request_binding');
    if (i > 0 && !(h[i - 1] < h[i])) throw new LnbtcError('invalid_exact_lnbtc_request_binding');
  }
  return { headers: h };
}

function validateMcpParams(p: unknown): { server: string; metadata: string[] } {
  if (!p || typeof p !== 'object' || Array.isArray(p)) throw new LnbtcError('invalid_exact_lnbtc_request_binding');
  const keys = Object.keys(p).sort();
  if (keys.length !== 2 || keys[0] !== 'metadata' || keys[1] !== 'server') throw new LnbtcError('invalid_exact_lnbtc_request_binding');
  const { server, metadata } = p as any;
  if (typeof server !== 'string' || !/^[\x21-\x7e]+$/.test(server)) throw new LnbtcError('invalid_exact_lnbtc_request_binding');
  let u: URL; try { u = new URL(server); } catch { throw new LnbtcError('invalid_exact_lnbtc_request_binding'); }
  if (u.username || u.password || server.includes('#')) throw new LnbtcError('invalid_exact_lnbtc_request_binding');
  if (!Array.isArray(metadata)) throw new LnbtcError('invalid_exact_lnbtc_request_binding');
  const sorted = [...metadata].sort(); // JCS orders by UTF-16 code units = JS default sort
  for (let i = 0; i < metadata.length; i++) {
    const m = metadata[i];
    if (typeof m !== 'string' || m === '' || m === 'x402/payment' || m === 'progressToken') throw new LnbtcError('invalid_exact_lnbtc_request_binding');
    if (sorted[i] !== m || (i > 0 && metadata[i - 1] === m)) throw new LnbtcError('invalid_exact_lnbtc_request_binding');
  }
  return { server, metadata };
}

export function validateBindingParams(profile: unknown, params: unknown): void {
  if (profile === 'http:1') validateHttpParams(params);
  else if (profile === 'mcp:1') validateMcpParams(params);
  else throw new LnbtcError('invalid_exact_lnbtc_request_binding', 'unknown profile');
}

/** Build the http:1 binding object from an actual request. */
export function httpBinding(req: HttpRequestLike, params: { headers: string[] }) {
  validateHttpParams(params);
  const u = new URL(req.url);
  if (!/^https?:$/.test(u.protocol) || u.username || u.password || req.url.includes('#')) throw new LnbtcError('invalid_exact_lnbtc_request_binding', 'bad url');
  const body = req.body === undefined ? new Uint8Array() : typeof req.body === 'string' ? utf8ToBytes(req.body) : req.body;
  const lower: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(req.headers ?? {})) lower[k.toLowerCase()] = v;
  return {
    domain: 'x402:exact:lnbtc:bolt11:http:1',
    method: req.method,
    url: req.url,
    bodyHash: sha256hex(body),
    headers: params.headers.map((name) => {
      const v = lower[name];
      if (v !== undefined && !/^[\x20-\x7e]*$/.test(v)) throw new LnbtcError('invalid_exact_lnbtc_request_binding', 'unsupported header value');
      const vh = v === undefined ? sha256hex(new Uint8Array([0])) : sha256hex(new Uint8Array([1, ...utf8ToBytes(v.trim())]));
      return { name, valueHash: vh };
    }),
  };
}

export interface McpToolCallLike {
  name: string;
  arguments?: unknown;
  _meta?: unknown;
}
/** Build the mcp:1 binding object from an actual tools/call. */
export function mcpBinding(call: McpToolCallLike, params: { server: string; metadata: string[] }) {
  validateMcpParams(params);
  if (typeof call.name !== 'string' || call.name === '') throw new LnbtcError('invalid_exact_lnbtc_request_binding', 'tool name');
  const args = call.arguments === undefined ? {} : call.arguments;
  if (args === null || typeof args !== 'object' || Array.isArray(args)) throw new LnbtcError('invalid_exact_lnbtc_request_binding', 'arguments');
  const meta = call._meta === undefined ? {} : call._meta;
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) throw new LnbtcError('invalid_exact_lnbtc_request_binding', '_meta');
  return {
    domain: 'x402:exact:lnbtc:bolt11:mcp:1',
    server: params.server,
    method: 'tools/call',
    name: call.name,
    arguments: args,
    metadata: params.metadata.map((name) => {
      const has = Object.prototype.hasOwnProperty.call(meta, name);
      return { name, valueHash: has ? sha256hex(new Uint8Array([1, ...utf8ToBytes(jcs((meta as any)[name]))])) : sha256hex(new Uint8Array([0])) };
    }),
  };
}

export const requestHashOf = (binding: object): string => sha256hex(utf8ToBytes(jcs(binding)));

// ─── Amount parsing ──────────────────────────────────────────────────────────

/** Parse an explicit price to msat. Accepts {asset:'BTC',amount:'<msat>'} or "21 sat(s)". Bare numbers rejected. */
export function parseLnbtcPrice(p: { asset: string; amount: string } | string): string {
  if (typeof p === 'object') {
    if (p.asset !== 'BTC' || !/^[1-9][0-9]*$/.test(p.amount)) throw new LnbtcError('invalid_exact_lnbtc_amount', 'use {asset:"BTC",amount:"<msat>"}');
    return p.amount;
  }
  const m = /^([0-9]+)(?:\.([0-9]{1,3}))? sats?$/.exec(p);
  if (!m) throw new LnbtcError('invalid_exact_lnbtc_amount', 'bare or unsupported price; use explicit atomic AssetAmount');
  const msat = BigInt(m[1]) * 1000n + BigInt((m[2] ?? '').padEnd(3, '0') || '0');
  if (msat <= 0n) throw new LnbtcError('invalid_exact_lnbtc_amount');
  return msat.toString();
}

// ─── Adapters ────────────────────────────────────────────────────────────────

/** Receiver: creates an invoice for exact msat with caller-supplied description hash (NWC make_invoice). */
export interface ReceiverAdapter {
  nodePubkey: string;
  makeInvoice(args: { amountMsat: string; descriptionHash: string; expirySeconds: number }): Promise<string>;
}
export type PayResult =
  | { status: 'paid'; invoice: string; paymentHash: string; amountMsat: string; preimage?: string; feeMsat?: string }
  | { status: 'in_flight' }
  | { status: 'failed'; error?: string };
/** Payer: must return the preimage when paid (NWC pay_invoice returns `preimage`). */
export interface PayerAdapter { payInvoice(invoice: string): Promise<PayResult> }

// ─── Replay store ────────────────────────────────────────────────────────────

export interface ReplayStore {
  /** Atomically insert. Returns false if key already exists. */
  insert(key: string, keepUntilUnix: number): Promise<boolean>;
  has(key: string): Promise<boolean>;
}
/** NOT spec-compliant for production (lost on restart). Tests only. */
export class InMemoryReplayStore implements ReplayStore {
  private m = new Map<string, number>();
  async insert(key: string, until: number) { if (this.m.has(key)) return false; this.m.set(key, until); return true; }
  async has(key: string) { return this.m.has(key); }
}
/**
 * Restart-durable replay store: one file per key created with O_EXCL ('wx'),
 * which the OS makes atomic across processes on the same filesystem. Keys are
 * hashed into file names. Never deletes before keepUntil.
 */
export class FileReplayStore implements ReplayStore {
  constructor(private dir: string) { fs.mkdirSync(dir, { recursive: true }); }
  private file(key: string) { return path.join(this.dir, sha256hex(utf8ToBytes(key)) + '.json'); }
  async insert(key: string, until: number) {
    try {
      const fd = fs.openSync(this.file(key), 'wx');
      fs.writeSync(fd, JSON.stringify({ key, keepUntil: until }));
      fs.fsyncSync(fd); fs.closeSync(fd);
      return true;
    } catch (e: any) { if (e.code === 'EEXIST') return false; throw e; }
  }
  async has(key: string) { return fs.existsSync(this.file(key)); }
  /** Remove entries whose keepUntil has passed. */
  prune(nowUnix: number) {
    for (const f of fs.readdirSync(this.dir)) {
      try { const j = JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf8')); if (j.keepUntil < nowUnix) fs.unlinkSync(path.join(this.dir, f)); } catch { /* skip */ }
    }
  }
}

// ─── Shared invoice checks ───────────────────────────────────────────────────

function checkCore(r: any) {
  if (r?.scheme !== 'exact') throw new LnbtcError('unsupported_scheme');
  if (!NETWORK_CURRENCY[r.network]) throw new LnbtcError('unsupported_network');
  if (r.asset !== 'BTC') throw new LnbtcError('invalid_exact_lnbtc_asset');
  if (typeof r.amount !== 'string' || !/^[1-9][0-9]*$/.test(r.amount)) throw new LnbtcError('invalid_exact_lnbtc_amount');
  if (typeof r.payTo !== 'string' || !HEX66.test(r.payTo)) throw new LnbtcError('invalid_exact_lnbtc_pay_to_malformed');
  if (!Number.isInteger(r.maxTimeoutSeconds) || r.maxTimeoutSeconds <= 0) throw new LnbtcError('invalid_exact_lnbtc_max_timeout');
}
function checkExtraFlow(e: any) {
  if (!e || typeof e !== 'object') throw new LnbtcError('invalid_exact_lnbtc_request_binding');
  if (e.assetTransferMethod !== undefined && e.assetTransferMethod !== 'bolt11') throw new LnbtcError('invalid_exact_lnbtc_asset_transfer_method');
  if (e.paymentFlow !== 'upfront') throw new LnbtcError('invalid_exact_lnbtc_payment_flow');
  if (typeof e.requestHash !== 'string' || !HEX64.test(e.requestHash)) throw new LnbtcError('invalid_exact_lnbtc_request_binding');
  if (e.requestBindingProfile === undefined || e.requestBindingParams === undefined) throw new LnbtcError('invalid_exact_lnbtc_request_binding');
  validateBindingParams(e.requestBindingProfile, e.requestBindingParams);
}

/** Decode + check an invoice against requirements. Returns decoded invoice. */
export function checkInvoice(invoice: string, req: LnbtcPaymentRequirements, expectedRequestHash: string, nowUnix: number, skew = DEFAULT_SKEW_SECONDS, enforceUnexpired = true): DecodedBolt11 {
  let d: DecodedBolt11;
  try { d = decodeBolt11Strict(invoice); } catch (e) {
    throw new LnbtcError('invalid_exact_lnbtc_invoice_decode_failed', (e as Error).message);
  }
  if (d.amountMsat === null) throw new LnbtcError('invalid_exact_lnbtc_invoice_decode_failed', 'amountless');
  if (d.descriptionHashCount !== 1 || d.descriptionCount !== 0) throw new LnbtcError('invalid_exact_lnbtc_invoice_description');
  if (d.descriptionHash !== expectedRequestHash) throw new LnbtcError('invalid_exact_lnbtc_invoice_request_mismatch');
  if (d.payeeNodeKey !== req.payTo) throw new LnbtcError('invalid_exact_lnbtc_invoice_payee_mismatch');
  if (d.currency !== NETWORK_CURRENCY[req.network]) throw new LnbtcError('invalid_exact_lnbtc_invoice_currency_mismatch');
  if (d.amountMsat !== req.amount) throw new LnbtcError('invalid_exact_lnbtc_invoice_amount_mismatch');
  if (d.expiry !== req.maxTimeoutSeconds) throw new LnbtcError('invalid_exact_lnbtc_invoice_expiry_mismatch');
  if (d.timestamp > nowUnix + skew) throw new LnbtcError('invalid_exact_lnbtc_invoice_created_in_future');
  if (enforceUnexpired && nowUnix >= d.timestamp + d.expiry) throw new LnbtcError('invalid_exact_lnbtc_invoice_expired');
  return d;
}

// ─── Server ──────────────────────────────────────────────────────────────────

export interface ServerResourceConfig {
  network: string;
  amountMsat: string;
  maxTimeoutSeconds: number;
  profile: BindingProfile;
  /** http:1 → {headers}; mcp:1 → {server, metadata}. From server config, never from the client. */
  params: { headers: string[] } | { server: string; metadata: string[] };
  skewSeconds?: number;
  /** Optional issuance limiter (DoS). Return false to deny. */
  allowIssue?: () => boolean;
}

export function computeRequestHash(cfg: Pick<ServerResourceConfig, 'profile' | 'params'>, request: HttpRequestLike | McpToolCallLike): string {
  if (cfg.profile === 'http:1') return requestHashOf(httpBinding(request as HttpRequestLike, cfg.params as any));
  if (cfg.profile === 'mcp:1') return requestHashOf(mcpBinding(request as McpToolCallLike, cfg.params as any));
  throw new LnbtcError('invalid_exact_lnbtc_request_binding');
}

/** Server: build a fresh challenge for the actual request. Validates the invoice before returning it. */
export async function createLnbtcChallenge(cfg: ServerResourceConfig, receiver: ReceiverAdapter, request: HttpRequestLike | McpToolCallLike, nowUnix = Math.floor(Date.now() / 1000)): Promise<LnbtcPaymentRequirements> {
  if (cfg.allowIssue && !cfg.allowIssue()) throw new LnbtcError('exact_lnbtc_invoice_issuance_denied');
  const requestHash = computeRequestHash(cfg, request);
  const invoice = await receiver.makeInvoice({ amountMsat: cfg.amountMsat, descriptionHash: requestHash, expirySeconds: cfg.maxTimeoutSeconds });
  const req: LnbtcPaymentRequirements = {
    scheme: 'exact', network: cfg.network, amount: cfg.amountMsat, asset: 'BTC', payTo: receiver.nodePubkey,
    maxTimeoutSeconds: cfg.maxTimeoutSeconds,
    extra: { assetTransferMethod: 'bolt11', paymentFlow: 'upfront', requestHash, requestBindingProfile: cfg.profile, requestBindingParams: cfg.params, invoice },
  };
  checkCore(req); checkExtraFlow(req.extra);
  checkInvoice(invoice, req, requestHash, nowUnix, cfg.skewSeconds ?? DEFAULT_SKEW_SECONDS);
  return req;
}

/**
 * Server paid retry: recompute requirements from the *actual* request (never
 * from accepted.extra), then call settle. invoice in requirements may be fresh.
 */
export async function serverHandlePaidRetry(cfg: ServerResourceConfig, request: HttpRequestLike | McpToolCallLike, payload: LnbtcPaymentPayload, payTo: string, freshInvoice: string, store: ReplayStore, nowUnix = Math.floor(Date.now() / 1000)): Promise<SettlementResponse> {
  let requestHash: string;
  try { requestHash = computeRequestHash(cfg, request); } catch (e) { return { success: false, errorReason: (e as LnbtcError).reason ?? 'invalid_exact_lnbtc_request_binding' }; }
  const requirements: LnbtcPaymentRequirements = {
    scheme: 'exact', network: cfg.network, amount: cfg.amountMsat, asset: 'BTC', payTo, maxTimeoutSeconds: cfg.maxTimeoutSeconds,
    extra: { assetTransferMethod: 'bolt11', paymentFlow: 'upfront', requestHash, requestBindingProfile: cfg.profile, requestBindingParams: cfg.params, invoice: freshInvoice },
  };
  return settleLnbtc(payload, requirements, store, { nowUnix, skewSeconds: cfg.skewSeconds });
}

// ─── Client ──────────────────────────────────────────────────────────────────

export interface ClientIntent {
  /** Profile the client expects for this operation (MCP tool call ⇒ mcp:1). */
  expectedProfile: BindingProfile;
  request: HttpRequestLike | McpToolCallLike;
  /** For mcp:1: the server URI from client's own trusted configuration. */
  trustedMcpServer?: string;
  /** For http:1: PaymentRequired.resource.url must equal request url. */
  resourceUrl?: string;
  allowedNetworks?: string[];
  maxAmountMsat?: string;
  nowUnix?: number;
  skewSeconds?: number;
}

/** Client: validate a challenge (spec "Client Payment Construction" 1–9) without paying. */
export function validateLnbtcChallenge(req: LnbtcPaymentRequirements, intent: ClientIntent): DecodedBolt11 {
  checkCore(req);
  if (intent.allowedNetworks && !intent.allowedNetworks.includes(req.network)) throw new LnbtcError('unsupported_network');
  if (intent.maxAmountMsat && BigInt(req.amount) > BigInt(intent.maxAmountMsat)) throw new LnbtcError('invalid_exact_lnbtc_amount', 'above client cap');
  if (!req.extra?.invoice) throw new LnbtcError('invalid_exact_lnbtc_invoice_missing');
  checkExtraFlow(req.extra);
  if (req.extra.requestBindingProfile !== intent.expectedProfile) throw new LnbtcError('invalid_exact_lnbtc_request_binding', 'profile does not match operation');
  let params = req.extra.requestBindingParams as any;
  if (intent.expectedProfile === 'mcp:1') {
    if (!intent.trustedMcpServer || params.server !== intent.trustedMcpServer) throw new LnbtcError('invalid_exact_lnbtc_request_binding', 'server identity');
  } else if (intent.resourceUrl !== undefined && intent.resourceUrl !== (intent.request as HttpRequestLike).url) {
    throw new LnbtcError('invalid_exact_lnbtc_request_binding', 'resource url');
  }
  const computed = computeRequestHash({ profile: intent.expectedProfile, params }, intent.request);
  if (req.extra.requestHash !== computed) throw new LnbtcError('invalid_exact_lnbtc_request_mismatch');
  return checkInvoice(req.extra.invoice, req, computed, intent.nowUnix ?? Math.floor(Date.now() / 1000), intent.skewSeconds ?? DEFAULT_SKEW_SECONDS);
}

/** Client: validate, pay, verify the payer result and build the PaymentPayload. */
export async function payLnbtcChallenge(req: LnbtcPaymentRequirements, intent: ClientIntent, payer: PayerAdapter): Promise<LnbtcPaymentPayload> {
  const d = validateLnbtcChallenge(req, intent);
  const r = await payer.payInvoice(req.extra.invoice);
  if (r.status === 'in_flight') throw new LnbtcError('exact_lnbtc_payment_in_flight');
  if (r.status !== 'paid') throw new LnbtcError('exact_lnbtc_payment_not_paid');
  if (r.invoice !== req.extra.invoice) throw new LnbtcError('invalid_exact_lnbtc_payer_invoice_mismatch');
  if (r.paymentHash !== d.paymentHash) throw new LnbtcError('invalid_exact_lnbtc_payer_payment_hash_mismatch');
  if (r.amountMsat !== req.amount) throw new LnbtcError('invalid_exact_lnbtc_payer_amount_mismatch');
  if (!r.preimage) throw new LnbtcError('invalid_exact_lnbtc_payer_preimage_required');
  if (!HEX64.test(r.preimage)) throw new LnbtcError('invalid_exact_lnbtc_payer_preimage_malformed');
  if (sha256hex(hexToBytes(r.preimage)) !== d.paymentHash) throw new LnbtcError('invalid_exact_lnbtc_payer_preimage_hash_mismatch');
  return { x402Version: 2, accepted: req, payload: { preimage: r.preimage } };
}

// ─── Facilitator ─────────────────────────────────────────────────────────────

const BINDING_KEYS = new Set(['invoice', 'requestHash', 'requestBindingProfile', 'requestBindingParams']);

/** Facilitator /settle. Treats payload and requirements as untrusted. Never logs the preimage. */
export async function settleLnbtc(payload: LnbtcPaymentPayload, requirements: LnbtcPaymentRequirements, store: ReplayStore, opts: { nowUnix?: number; skewSeconds?: number } = {}): Promise<SettlementResponse> {
  const now = opts.nowUnix ?? Math.floor(Date.now() / 1000);
  const skew = opts.skewSeconds ?? DEFAULT_SKEW_SECONDS;
  try {
    const a = payload?.accepted as any; const r = requirements as any;
    if (!a) throw new LnbtcError('invalid_exact_lnbtc_invoice_missing');
    // 1
    if (a.scheme !== r.scheme) throw new LnbtcError('unsupported_scheme');
    if (a.network !== r.network) throw new LnbtcError('network_mismatch');
    if (a.amount !== r.amount) throw new LnbtcError('invalid_exact_lnbtc_amount_mismatch');
    if (a.asset !== r.asset) throw new LnbtcError('invalid_exact_lnbtc_asset');
    if (a.payTo !== r.payTo) throw new LnbtcError('invalid_exact_lnbtc_pay_to_mismatch');
    if (a.maxTimeoutSeconds !== r.maxTimeoutSeconds) throw new LnbtcError('invalid_exact_lnbtc_max_timeout_mismatch');
    // 2
    checkCore(r);
    // 3
    checkExtraFlow(r.extra); checkExtraFlow(a.extra);
    if (a.extra.requestHash !== r.extra.requestHash || a.extra.requestBindingProfile !== r.extra.requestBindingProfile ||
        jcs(a.extra.requestBindingParams) !== jcs(r.extra.requestBindingParams)) throw new LnbtcError('invalid_exact_lnbtc_request_mismatch');
    for (const k of Object.keys(r.extra)) {
      if (BINDING_KEYS.has(k)) continue;
      const av = k === 'assetTransferMethod' ? (a.extra[k] ?? 'bolt11') : a.extra[k];
      const rv = k === 'assetTransferMethod' ? (r.extra[k] ?? 'bolt11') : r.extra[k];
      if (jcs(av ?? null) !== jcs(rv ?? null)) throw new LnbtcError('invalid_exact_lnbtc_extra_mismatch');
    }
    // 4
    if (!r.extra.invoice || !a.extra.invoice) throw new LnbtcError('invalid_exact_lnbtc_invoice_missing');
    // 5 (expiry handled in 7 with grace)
    const d = checkInvoice(a.extra.invoice, r, r.extra.requestHash, now, skew, false);
    // 6
    const pre = payload.payload?.preimage;
    if (pre === undefined || pre === null) throw new LnbtcError('invalid_exact_lnbtc_preimage_missing');
    if (typeof pre !== 'string' || !/^[0-9a-f]*$/.test(pre)) throw new LnbtcError('invalid_exact_lnbtc_preimage_malformed');
    if (pre.length !== 64) throw new LnbtcError('invalid_exact_lnbtc_preimage_length');
    if (sha256hex(hexToBytes(pre)) !== d.paymentHash) throw new LnbtcError('invalid_exact_lnbtc_preimage_hash_mismatch');
    // 7
    const invoiceEnd = d.timestamp + d.expiry;
    if (now > invoiceEnd + skew) throw new LnbtcError('invalid_exact_lnbtc_invoice_expired');
    const key = `${r.network}:${d.paymentHash}`;
    const ok = await store.insert(key, invoiceEnd + skew + 3600);
    if (!ok) throw new LnbtcError('duplicate_settlement');
    return { success: true, transaction: d.paymentHash, network: r.network };
  } catch (e) {
    if (e instanceof LnbtcError) return { success: false, errorReason: e.reason };
    if (e instanceof Bolt11Error) return { success: false, errorReason: 'invalid_exact_lnbtc_invoice_decode_failed' };
    throw e;
  }
}

// ─── Mock adapters (tests / regtest demos only) ──────────────────────────────

import { encodeBolt11, nodePublicKey } from './bolt11-strict.js';

/**
 * In-process mock Lightning: a receiver that signs real BOLT11 invoices with a
 * test node key and a payer that "pays" by returning the stored preimage.
 * Moves no money. For CI and the README regtest walkthrough.
 */
export class MockLightning {
  private preimages = new Map<string, string>();
  readonly receiver: ReceiverAdapter;
  readonly payer: PayerAdapter;
  public paid: string[] = [];
  constructor(nodePrivHex: string, currency: 'bc' | 'tb' = 'bc', clock: () => number = () => Math.floor(Date.now() / 1000)) {
    const nodePubkey = nodePublicKey(nodePrivHex);
    this.receiver = {
      nodePubkey,
      makeInvoice: async ({ amountMsat, descriptionHash, expirySeconds }) => {
        const pre = bytesToHex(randomBytes(32)); const ph = sha256hex(hexToBytes(pre));
        this.preimages.set(ph, pre);
        return encodeBolt11({ currency, amountMsat, timestamp: clock(), paymentHash: ph, paymentSecret: bytesToHex(randomBytes(32)), descriptionHash, expiry: expirySeconds, nodePrivateKey: nodePrivHex });
      },
    };
    this.payer = {
      payInvoice: async (invoice) => {
        const d = decodeBolt11Strict(invoice);
        const pre = this.preimages.get(d.paymentHash);
        if (!pre) return { status: 'failed', error: 'unknown invoice (mock)' };
        this.paid.push(d.paymentHash);
        return { status: 'paid', invoice, paymentHash: d.paymentHash, amountMsat: d.amountMsat!, preimage: pre };
      },
    };
  }
}

/** Several mock nodes sharing one "network" so one payer can pay any of them. Tests/demos only. */
export class MockLightningNetwork {
  private preimages = new Map<string, string>();
  public payments: Array<{ paymentHash: string; amountMsat: string; payee: string }> = [];
  public failNext = 0;
  constructor(private currency: 'bc' | 'tb' = 'bc', private clock: () => number = () => Math.floor(Date.now() / 1000)) {}
  receiver(nodePrivHex: string): ReceiverAdapter & { invoice(amountMsat: bigint): Promise<string> } {
    const nodePubkey = nodePublicKey(nodePrivHex);
    const make = async (amountMsat: string, descriptionHash: string, expiry: number) => {
      const pre = bytesToHex(randomBytes(32)); const ph = sha256hex(hexToBytes(pre));
      this.preimages.set(ph, pre);
      return encodeBolt11({ currency: this.currency, amountMsat, timestamp: this.clock(), paymentHash: ph, paymentSecret: bytesToHex(randomBytes(32)), descriptionHash, expiry, nodePrivateKey: nodePrivHex });
    };
    return {
      nodePubkey,
      makeInvoice: ({ amountMsat, descriptionHash, expirySeconds }) => make(amountMsat, descriptionHash, expirySeconds),
      invoice: (amountMsat: bigint) => make(amountMsat.toString(), sha256hex(utf8ToBytes('split payment')), 600),
    };
  }
  payer(): PayerAdapter {
    return {
      payInvoice: async (invoice) => {
        if (this.failNext > 0) { this.failNext--; return { status: 'failed', error: 'mock failure' }; }
        const d = decodeBolt11Strict(invoice);
        const pre = this.preimages.get(d.paymentHash);
        if (!pre) return { status: 'failed', error: 'unknown invoice (mock)' };
        this.payments.push({ paymentHash: d.paymentHash, amountMsat: d.amountMsat!, payee: d.payeeNodeKey });
        return { status: 'paid', invoice, paymentHash: d.paymentHash, amountMsat: d.amountMsat!, preimage: pre };
      },
    };
  }
}
