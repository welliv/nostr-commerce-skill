import { describe, it, expect } from 'vitest';
import {
  generateIdentity,
  nsecToPrivateKey,
  privateKeyToNsec,
  identityFromPrivateKey,
} from '../src/identity.js';
import { nip19 } from 'nostr-tools';

describe('Identity (Scenarios 1, 5)', () => {
  it('generateIdentity creates valid keypair', () => {
    const identity = generateIdentity();
    expect(identity.pubkey).toHaveLength(64);
    expect(identity.npub).toMatch(/^npub1/);
    expect(identity.privateKey).toBeInstanceOf(Uint8Array);
  });

  it('privateKeyToNsec and nsecToPrivateKey are inverses', () => {
    const identity = generateIdentity();
    const nsec = privateKeyToNsec(identity.privateKey);
    expect(nsec).toMatch(/^nsec1/);
    const restored = nsecToPrivateKey(nsec);
    expect(restored).toEqual(identity.privateKey);
  });

  it('identityFromPrivateKey restores identity correctly', () => {
    const original = generateIdentity();
    const restored = identityFromPrivateKey(original.privateKey);
    expect(restored.pubkey).toBe(original.pubkey);
    expect(restored.npub).toBe(original.npub);
  });
});
