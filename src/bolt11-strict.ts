/**
 * bolt11-strict.ts - Strict BOLT11 encode/decode with signature recovery.
 *
 * Why this exists: x402 `exact`/`lnbtc` requires the facilitator to strictly
 * decode the invoice, verify its signature and recover (or check `n`) the
 * signing node key. `light-bolt11-decoder` does not verify signatures, so
 * this module implements the subset of BOLT11 needed for that, using
 * @noble/curves for secp256k1 recovery.
 *
 * The encoder exists for tests and regtest mocks (a "receiver adapter" that
 * signs invoices with a test node key). Real deployments create invoices on
 * their own Lightning node (NWC make_invoice with description_hash).
 */
import { bech32 } from '@scure/base';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';

export type Bolt11Currency = 'bc' | 'tb' | 'bcrt' | 'tbs';

export interface DecodedBolt11 {
  paymentRequest: string;
  currency: Bolt11Currency;
  /** Amount in millisatoshis as a decimal string, or null if amountless. */
  amountMsat: string | null;
  timestamp: number;
  expiry: number; // seconds, default 3600
  paymentHash: string;
  paymentSecret?: string;
  descriptionHash?: string;
  /** Inline description; present => x402 lnbtc must reject. */
  description?: string;
  descriptionCount: number;
  descriptionHashCount: number;
  /** Signing node key (66 hex), from `n` if present (and verified) or recovered. */
  payeeNodeKey: string;
  minFinalCltvExpiry?: number;
}

export class Bolt11Error extends Error {}

const MULT: Record<string, bigint> = { m: 100_000_000n, u: 100_000n, n: 100n, p: 1n };
// msat per unit: 1 BTC = 1e11 msat. m = 1e8 msat, u = 1e5, n = 100, p = 0.1 msat
function parseHrpAmount(amt: string): string | null {
  if (amt === '') return null;
  const m = /^([0-9]+)([munp]?)$/.exec(amt);
  if (!m) throw new Bolt11Error('bad amount');
  if (m[1].length > 1 && m[1].startsWith('0')) throw new Bolt11Error('leading zero in amount');
  const n = BigInt(m[1]);
  if (!m[2]) return (n * 100_000_000_000n).toString();
  if (m[2] === 'p') {
    if (n % 10n !== 0n) throw new Bolt11Error('sub-millisatoshi amount');
    return (n / 10n).toString();
  }
  return (n * MULT[m[2]]).toString();
}

function encodeHrpAmount(msat: bigint): string {
  if (msat % 100_000_000_000n === 0n) return (msat / 100_000_000_000n).toString();
  if (msat % 100_000_000n === 0n) return (msat / 100_000_000n).toString() + 'm';
  if (msat % 100_000n === 0n) return (msat / 100_000n).toString() + 'u';
  if (msat % 100n === 0n) return (msat / 100n).toString() + 'n';
  return (msat * 10n).toString() + 'p';
}

function wordsToInt(w: number[]): number {
  return w.reduce((a, x) => a * 32 + x, 0);
}
function intToWords(n: number, len?: number): number[] {
  const out: number[] = [];
  do { out.unshift(n % 32); n = Math.floor(n / 32); } while (n > 0);
  if (len !== undefined) { while (out.length < len) out.unshift(0); }
  return out;
}
/** 5-bit words -> bytes, padding with zero bits at the end (BOLT11 signing). */
function wordsToBytesPadded(words: number[]): Uint8Array {
  let acc = 0, bits = 0; const out: number[] = [];
  for (const w of words) { acc = (acc << 5) | w; bits += 5; while (bits >= 8) { bits -= 8; out.push((acc >> bits) & 0xff); } acc &= (1 << bits) - 1; }
  if (bits > 0) out.push((acc << (8 - bits)) & 0xff);
  return new Uint8Array(out);
}

export function decodeBolt11Strict(invoice: string): DecodedBolt11 {
  if (typeof invoice !== 'string' || invoice.length === 0) throw new Bolt11Error('empty invoice');
  if (invoice !== invoice.toLowerCase()) throw new Bolt11Error('invoice must be lowercase');
  let dec: { prefix: string; words: number[] };
  try { dec = bech32.decode(invoice as `${string}1${string}`, 7089) as any; } catch (e) { throw new Bolt11Error('bech32 decode failed'); }
  const hm = /^ln(bcrt|tbs|bc|tb)([0-9]*[munp]?)$/.exec(dec.prefix);
  if (!hm) throw new Bolt11Error('bad hrp');
  const currency = hm[1] as Bolt11Currency;
  const amountMsat = parseHrpAmount(hm[2]);
  const words = Array.from(dec.words);
  if (words.length < 35 + 104) throw new Bolt11Error('too short');
  const sigWords = words.slice(-104);
  const dataWords = words.slice(0, -104);
  const timestamp = wordsToInt(dataWords.slice(0, 7));
  let i = 7;
  const out: Partial<DecodedBolt11> = { descriptionCount: 0, descriptionHashCount: 0 };
  let paymentHashCount = 0; let nKey: string | undefined;
  while (i < dataWords.length) {
    if (i + 3 > dataWords.length) throw new Bolt11Error('truncated field');
    const type = dataWords[i]; const len = dataWords[i + 1] * 32 + dataWords[i + 2];
    const fw = dataWords.slice(i + 3, i + 3 + len);
    if (fw.length !== len) throw new Bolt11Error('truncated field data');
    i += 3 + len;
    const asBytes = () => bech32.fromWordsUnsafe(fw) ?? (() => { throw new Bolt11Error('bad padding'); })();
    switch (type) {
      case 1: if (len === 52) { out.paymentHash = bytesToHex(asBytes()); paymentHashCount++; } break; // p
      case 16: if (len === 52) out.paymentSecret = bytesToHex(asBytes()); break; // s
      case 23: if (len === 52) { out.descriptionHash = bytesToHex(asBytes()); out.descriptionHashCount!++; } break; // h
      case 13: out.description = new TextDecoder('utf-8', { fatal: true }).decode(asBytes()); out.descriptionCount!++; break; // d
      case 19: if (len === 53) nKey = bytesToHex(asBytes()); break; // n
      case 6: out.expiry = wordsToInt(fw); break; // x
      case 24: out.minFinalCltvExpiry = wordsToInt(fw); break; // c
      default: break;
    }
  }
  if (paymentHashCount !== 1 || !out.paymentHash) throw new Bolt11Error('missing payment hash');
  const sigBytes = bech32.fromWordsUnsafe(sigWords);
  if (!sigBytes || sigBytes.length !== 65) throw new Bolt11Error('bad signature length');
  const msgHash = sha256(new Uint8Array([...utf8ToBytes(dec.prefix), ...wordsToBytesPadded(dataWords)]));
  const rec = sigBytes[64];
  if (rec > 3) throw new Bolt11Error('bad recovery id');
  let payee: string;
  try {
    const sig = secp256k1.Signature.fromBytes(sigBytes.slice(0, 64), 'compact');
    if (sig.hasHighS()) throw new Bolt11Error('high-S signature');
    const pub = sig.addRecoveryBit(rec).recoverPublicKey(msgHash).toBytes(true);
    payee = bytesToHex(pub);
    if (nKey) {
      if (!secp256k1.verify(sigBytes.slice(0, 64), msgHash, hexToBytes(nKey), { prehash: false })) throw new Bolt11Error('signature does not verify against n');
      payee = nKey;
    }
  } catch (e) {
    if (e instanceof Bolt11Error) throw e;
    throw new Bolt11Error('signature recovery failed');
  }
  return {
    paymentRequest: invoice, currency, amountMsat, timestamp,
    expiry: out.expiry ?? 3600, paymentHash: out.paymentHash, paymentSecret: out.paymentSecret,
    descriptionHash: out.descriptionHash, description: out.description,
    descriptionCount: out.descriptionCount!, descriptionHashCount: out.descriptionHashCount!,
    payeeNodeKey: payee, minFinalCltvExpiry: out.minFinalCltvExpiry,
  };
}

export interface EncodeBolt11Params {
  currency: Bolt11Currency;
  amountMsat: bigint | string;
  timestamp: number;
  paymentHash: string;
  paymentSecret?: string;
  descriptionHash?: string;
  description?: string;
  expiry?: number;
  minFinalCltvExpiry?: number;
  /** Node private key (hex). TEST/REGTEST ONLY: real invoices come from a node. */
  nodePrivateKey: string;
}

function tagged(type: number, words: number[]): number[] {
  return [type, ...intToWords(words.length, 2), ...words];
}

/** Encode and sign a BOLT11 invoice. For tests and regtest mocks. */
export function encodeBolt11(p: EncodeBolt11Params): string {
  const hrp = 'ln' + p.currency + encodeHrpAmount(BigInt(p.amountMsat));
  const data: number[] = [...intToWords(p.timestamp, 7)];
  data.push(...tagged(1, bech32.toWords(hexToBytes(p.paymentHash))));
  if (p.paymentSecret) data.push(...tagged(16, bech32.toWords(hexToBytes(p.paymentSecret))));
  if (p.descriptionHash) data.push(...tagged(23, bech32.toWords(hexToBytes(p.descriptionHash))));
  if (p.description !== undefined) data.push(...tagged(13, bech32.toWords(utf8ToBytes(p.description))));
  if (p.expiry !== undefined) data.push(...tagged(6, intToWords(p.expiry)));
  data.push(...tagged(24, intToWords(p.minFinalCltvExpiry ?? 18)));
  const msgHash = sha256(new Uint8Array([...utf8ToBytes(hrp), ...wordsToBytesPadded(data)]));
  const sig = secp256k1.sign(msgHash, hexToBytes(p.nodePrivateKey), { prehash: false, format: 'recovered' });
  // noble 'recovered' format = [rec, r(32), s(32)]; BOLT11 wants r||s||rec
  const sig65 = new Uint8Array([...sig.slice(1), sig[0]]);
  return bech32.encode(hrp, [...data, ...bech32.toWords(sig65)], 7089);
}

export function nodePublicKey(privHex: string): string {
  return bytesToHex(secp256k1.getPublicKey(hexToBytes(privHex), true));
}
