/**
 * audit-log.ts - Tamper-evident, signed, append-only JSONL audit log.
 *
 * entry_hash = SHA-256(JCS(entry without sig, entry_hash)); each entry carries
 * prev_hash, so deleting, reordering or editing an entry breaks the chain.
 * sig = BIP-340 Schnorr signature by the platform key over entry_hash.
 * Preimages must never be written here; reference payments by payment hash.
 *
 * Limitation: the operator holding the key can rewrite the whole chain. Anchor
 * the head hash periodically (e.g. OTS-stamp it daily) to bound that.
 */
import * as fs from 'node:fs';
import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { jcs } from './x402-lnbtc.js';

export type AuditEventType = 'discover' | 'qualify' | 'decision' | 'approval_request' | 'approval' | 'invoice_received' |
  'payment_sent' | 'payment_in_flight' | 'payment_failed' | 'license_received' | 'license_verified' | 'statement_sent' |
  'kill_switch' | 'reward_run' | 'error';

export interface AuditEntry {
  seq: number; ts: number; prev_hash: string; event_type: AuditEventType;
  data: Record<string, unknown>; entry_hash: string; sig: string; signer: string;
}

const GENESIS = '0'.repeat(64);
const FORBIDDEN = /preimage/i;

function assertNoSecrets(data: unknown, path = ''): void {
  if (data && typeof data === 'object') {
    for (const [k, v] of Object.entries(data)) {
      if (FORBIDDEN.test(k)) throw new Error(`audit log refuses secret-like field ${path}${k}`);
      assertNoSecrets(v, `${path}${k}.`);
    }
  }
}

export class AuditLog {
  private head = GENESIS; private seq = 0; readonly signer: string;
  constructor(private file: string, private secretKey: Uint8Array) {
    this.signer = bytesToHex(schnorr.getPublicKey(secretKey));
    if (fs.existsSync(file)) {
      const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
      if (lines.length) { const last = JSON.parse(lines[lines.length - 1]) as AuditEntry; this.head = last.entry_hash; this.seq = last.seq; }
    }
  }
  append(event_type: AuditEventType, data: Record<string, unknown>, ts = Math.floor(Date.now() / 1000)): AuditEntry {
    assertNoSecrets(data);
    const body = { seq: this.seq + 1, ts, prev_hash: this.head, event_type, data, signer: this.signer };
    const entry_hash = bytesToHex(sha256(utf8ToBytes(jcs(body))));
    const sig = bytesToHex(schnorr.sign(hexToBytes(entry_hash), this.secretKey));
    const entry: AuditEntry = { ...body, entry_hash, sig };
    fs.appendFileSync(this.file, JSON.stringify(entry) + '\n');
    this.head = entry_hash; this.seq++;
    return entry;
  }
  headHash() { return this.head; }
}

export interface AuditVerifyResult { valid: boolean; entries: number; head: string; error?: string; badSeq?: number }

/** Third-party check of a whole log file against an expected signer pubkey. */
export function verifyAuditLog(file: string, expectedSigner: string): AuditVerifyResult {
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  let prev = GENESIS;
  for (let i = 0; i < lines.length; i++) {
    let e: AuditEntry;
    try { e = JSON.parse(lines[i]); } catch { return { valid: false, entries: i, head: prev, error: 'unparseable line', badSeq: i + 1 }; }
    const { entry_hash, sig, ...body } = e;
    if (e.seq !== i + 1) return { valid: false, entries: i, head: prev, error: 'sequence gap or reorder', badSeq: e.seq };
    if (e.prev_hash !== prev) return { valid: false, entries: i, head: prev, error: 'broken chain', badSeq: e.seq };
    if (e.signer !== expectedSigner) return { valid: false, entries: i, head: prev, error: 'unexpected signer', badSeq: e.seq };
    const h = bytesToHex(sha256(utf8ToBytes(jcs(body))));
    if (h !== entry_hash) return { valid: false, entries: i, head: prev, error: 'entry hash mismatch (edited)', badSeq: e.seq };
    if (!schnorr.verify(hexToBytes(sig), hexToBytes(h), hexToBytes(expectedSigner))) return { valid: false, entries: i, head: prev, error: 'bad signature', badSeq: e.seq };
    prev = h;
  }
  return { valid: true, entries: lines.length, head: prev };
}
