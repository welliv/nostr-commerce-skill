/**
 * nostr-verify.ts - signature check that never trusts nostr-tools' cached
 * `verifiedSymbol` (a mutated, previously verified object would otherwise pass).
 */
import { verifyEvent } from 'nostr-tools';
import type { NostrEvent } from './types.js';

export function verifyFresh(ev: NostrEvent | undefined | null): boolean {
  if (!ev) return false;
  try {
    const clean = JSON.parse(JSON.stringify({ id: ev.id, pubkey: ev.pubkey, created_at: ev.created_at, kind: ev.kind, tags: ev.tags, content: ev.content, sig: ev.sig }));
    return verifyEvent(clean);
  } catch { return false; }
}
export const tagValue = (ev: { tags: string[][] }, name: string, idx = 1): string | undefined => ev.tags.find((t) => t[0] === name)?.[idx];
export const tagsOf = (ev: { tags: string[][] }, name: string): string[][] => ev.tags.filter((t) => t[0] === name);
