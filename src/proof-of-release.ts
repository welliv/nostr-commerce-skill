/**
 * proof-of-release.ts - Evidence that a file existed under an artist's key by a date.
 *
 * What it is: SHA-256 of the master → NIP-94 kind 1063 event signed by the
 * artist (`ox` = master hash) → OpenTimestamps proof of that hash, upgraded
 * once a Bitcoin block includes it → optional NIP-03 kind 1040 event.
 *
 * What it is NOT: proof of authorship or ownership, or copyright registration.
 * It shows only that this exact hash existed no later than the block time.
 *
 * Library status (checked Oct 2026): `opentimestamps` npm 0.4.9 (javascript-
 * opentimestamps) was last published in 2021/2022 and is effectively
 * unmaintained. It is pinned here and wrapped behind `OtsBackend` so it can be
 * replaced (e.g. by shelling out to the Python `opentimestamps-client`, which is
 * maintained by the OTS project) without touching callers. Bitcoin
 * verification below is done by our own code against block headers fetched
 * from an Esplora API (injectable), not by the library's verifier.
 *
 * NIP-03 status: the NIP is marked as needing update / "vulnerable to one
 * specific attack"; the standalone `.ots` file is the primary artifact and the
 * kind 1040 event is optional convenience.
 */
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { finalizeEvent } from 'nostr-tools';
import type { NostrEvent } from './types.js';
import { verifyFresh, tagValue } from './nostr-verify.js';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const OTS: any = require('opentimestamps');

export const KIND_FILE_METADATA = 1063; // NIP-94 (standard)
export const KIND_OTS = 1040; // NIP-03 (standard kind, NIP flagged for update)

export function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}
export function hashFile(path: string): string {
  return sha256Hex(fs.readFileSync(path));
}

export interface ReleaseParams {
  masterSha256: string;
  mime: string;
  size?: number;
  url?: string;
  /** SHA-256 of the blob as served (e.g. encrypted). Defaults to master hash. */
  servedSha256?: string;
  title?: string;
  createdAt?: number;
}

/** NIP-94 kind 1063 proof-of-release event (standard kind; release use is a convention). */
export function buildReleaseEvent(p: ReleaseParams, artistSecretKey: Uint8Array): NostrEvent {
  if (!/^[0-9a-f]{64}$/.test(p.masterSha256)) throw new Error('masterSha256 must be 64 hex');
  const tags: string[][] = [['x', p.servedSha256 ?? p.masterSha256], ['ox', p.masterSha256], ['m', p.mime]];
  if (p.size !== undefined) tags.push(['size', String(p.size)]);
  if (p.url) tags.push(['url', p.url]);
  if (p.title) tags.push(['alt', `Proof of release: ${p.title}`]);
  return finalizeEvent({ kind: KIND_FILE_METADATA, created_at: p.createdAt ?? Math.floor(Date.now() / 1000), tags, content: p.title ?? '' }, artistSecretKey) as NostrEvent;
}

// ─── OTS backend ─────────────────────────────────────────────────────────────

export interface BitcoinAttestationInfo { height: number; merkleRootHex: string; blockTime?: number }
export interface OtsInspection {
  digest: string;
  pending: string[]; // calendar URIs
  bitcoin: Array<{ height: number; merkleRootHex: string }>; // merkle root in explorer (display) byte order
}

/** Inspect a serialized .ots file offline. */
export function inspectOts(ots: Uint8Array): OtsInspection {
  const d = OTS.DetachedTimestampFile.deserialize(Array.from(ots));
  const out: OtsInspection = { digest: Buffer.from(d.fileDigest()).toString('hex'), pending: [], bitcoin: [] };
  for (const [msg, att] of d.timestamp.allAttestations()) {
    if (att instanceof OTS.Notary.PendingAttestation) out.pending.push(att.uri);
    else if (att instanceof OTS.Notary.BitcoinBlockHeaderAttestation) {
      out.bitcoin.push({ height: att.height, merkleRootHex: Buffer.from(msg).reverse().toString('hex') });
    }
  }
  return out;
}

export interface BlockHeaderSource { getBlock(height: number): Promise<{ merkleRoot: string; time: number }> }

/** Esplora block header lookup (blockstream.info / mempool.space). Untrusted third party; use ≥2 or your own node. */
export function esploraHeaderSource(base = 'https://blockstream.info/api'): BlockHeaderSource {
  return {
    async getBlock(height) {
      const h = await (await fetch(`${base}/block-height/${height}`)).text();
      const b = await (await fetch(`${base}/block/${h.trim()}`)).json() as any;
      return { merkleRoot: b.merkle_root, time: b.timestamp };
    },
  };
}

export interface OtsVerifyResult {
  status: 'verified' | 'pending' | 'invalid';
  digestMatches: boolean;
  /** Earliest verified block time (unix). */
  attestedTime?: number;
  height?: number;
  pendingCalendars: string[];
  detail?: string;
}

/** Verify an .ots proof for a hash against Bitcoin block headers. */
export async function verifyOts(ots: Uint8Array, expectedSha256: string, headers: BlockHeaderSource): Promise<OtsVerifyResult> {
  let info: OtsInspection;
  try { info = inspectOts(ots); } catch (e) { return { status: 'invalid', digestMatches: false, pendingCalendars: [], detail: 'ots decode failed' }; }
  const digestMatches = info.digest === expectedSha256;
  if (!digestMatches) return { status: 'invalid', digestMatches, pendingCalendars: info.pending, detail: 'digest mismatch' };
  let best: { time: number; height: number } | undefined;
  for (const b of info.bitcoin) {
    try {
      const blk = await headers.getBlock(b.height);
      if (blk.merkleRoot === b.merkleRootHex && (!best || blk.time < best.time)) best = { time: blk.time, height: b.height };
    } catch { /* lookup failure → not verified via this attestation */ }
  }
  if (best) return { status: 'verified', digestMatches, attestedTime: best.time, height: best.height, pendingCalendars: info.pending };
  if (info.bitcoin.length) return { status: 'invalid', digestMatches, pendingCalendars: info.pending, detail: 'bitcoin attestation does not match block header' };
  return { status: 'pending', digestMatches, pendingCalendars: info.pending };
}

export interface OtsBackend {
  stamp(sha256hex: string): Promise<Uint8Array>;
  upgrade(ots: Uint8Array): Promise<{ ots: Uint8Array; changed: boolean }>;
}

/** Real backend using public OTS calendars (network). Free; calendars are third parties. */
export const openTimestampsBackend: OtsBackend = {
  async stamp(hex) {
    const d = OTS.DetachedTimestampFile.fromHash(new OTS.Ops.OpSHA256(), Buffer.from(hex, 'hex'));
    await OTS.stamp(d);
    return Uint8Array.from(d.serializeToBytes());
  },
  async upgrade(ots) {
    const d = OTS.DetachedTimestampFile.deserialize(Array.from(ots));
    const changed = await OTS.upgrade(d);
    return { ots: Uint8Array.from(d.serializeToBytes()), changed: !!changed };
  },
};

/** NIP-03 kind 1040 event (optional). content = base64 .ots; e = target event; k = its kind. */
export function buildOtsEvent(target: NostrEvent, ots: Uint8Array, signerSecretKey: Uint8Array, relayHint = ''): NostrEvent {
  return finalizeEvent({
    kind: KIND_OTS, created_at: Math.floor(Date.now() / 1000),
    tags: [['e', target.id, relayHint], ['k', String(target.kind)]],
    content: Buffer.from(ots).toString('base64'),
  }, signerSecretKey) as NostrEvent;
}

/**
 * NOTE on what gets stamped: NIP-03 stamps the *event id*; this module stamps
 * the *master file hash* (`ox`) as the primary artifact because it is what a
 * court or buyer can recompute from the audio. Stamp both if you want both.
 */
export interface ReleaseCheck {
  ok: boolean;
  signatureValid: boolean;
  masterHashMatches: boolean;
  ots: OtsVerifyResult | null;
  statement: string;
}

export async function verifyRelease(release: NostrEvent, opts: { artistPubkey: string; masterSha256?: string; ots?: Uint8Array; headers?: BlockHeaderSource }): Promise<ReleaseCheck> {
  const signatureValid = verifyFresh(release) && release.pubkey === opts.artistPubkey && release.kind === KIND_FILE_METADATA;
  const ox = tagValue(release, 'ox');
  const masterHashMatches = !!ox && (opts.masterSha256 === undefined || ox === opts.masterSha256);
  let ots: OtsVerifyResult | null = null;
  if (opts.ots && ox && opts.headers) ots = await verifyOts(opts.ots, ox, opts.headers);
  const ok = signatureValid && masterHashMatches && (!opts.ots || ots?.status === 'verified');
  return {
    ok, signatureValid, masterHashMatches, ots,
    statement: ots?.status === 'verified'
      ? `The file with SHA-256 ${ox} existed no later than ${new Date(ots.attestedTime! * 1000).toISOString()} (Bitcoin block ${ots.height}). This is evidence of existence, not of authorship or ownership.`
      : 'Not anchored in Bitcoin yet (or no proof supplied). Signature only shows the artist key signed this hash.',
  };
}

/** Build a test .ots proof offline (tests/regtest only): hash → append nonce → sha256 → Bitcoin attestation. */
export function buildTestOts(sha256hex: string, height: number, nonceHex = 'aa'): { ots: Uint8Array; merkleRootHex: string } {
  const d = OTS.DetachedTimestampFile.fromHash(new OTS.Ops.OpSHA256(), Buffer.from(sha256hex, 'hex'));
  d.timestamp.attestations.push(new OTS.Notary.PendingAttestation('https://alice.btc.calendar.opentimestamps.org'));
  if (height > 0) {
    const leaf = d.timestamp.add(new OTS.Ops.OpAppend(Buffer.from(nonceHex, 'hex'))).add(new OTS.Ops.OpSHA256());
    leaf.attestations.push(new OTS.Notary.BitcoinBlockHeaderAttestation(height));
  }
  const root = createHash('sha256').update(Buffer.concat([Buffer.from(sha256hex, 'hex'), Buffer.from(nonceHex, 'hex')])).digest();
  return { ots: Uint8Array.from(d.serializeToBytes()), merkleRootHex: Buffer.from(root).reverse().toString('hex') };
}
