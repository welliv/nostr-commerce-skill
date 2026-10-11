import { describe, it, expect } from 'vitest';
import { lightningAddressToLnurlp } from '../src/zaps';

describe('Fix 1: .well-known paths', () => {
  it('builds the LUD-16 lnurlp URL with a hyphenated .well-known', () => {
    expect(lightningAddressToLnurlp('hello@getalby.com'))
      .toBe('https://getalby.com/.well-known/lnurlp/hello');
  });
  it('never contains ".well known" with a space', () => {
    expect(lightningAddressToLnurlp('a@b.c')).not.toContain('.well known');
  });
  it('returns null for malformed addresses', () => {
    expect(lightningAddressToLnurlp('nope')).toBeNull();
    expect(lightningAddressToLnurlp('@x.com')).toBeNull();
    expect(lightningAddressToLnurlp(undefined)).toBeNull();
  });
});
