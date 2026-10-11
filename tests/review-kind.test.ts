import { describe, it, expect, vi } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { generateSecretKey } from 'nostr-tools';

vi.mock('../src/relays.js', () => ({
  publishToRelays: vi.fn(async (event: unknown) => ({ event, accepted: ['wss://x'], rejected: [] })),
  fetchEvents: vi.fn(async () => []),
}));

import { publishReview, REVIEW_LABEL_NAMESPACE } from '../src/reviews';
import { publishToRelays } from '../src/relays.js';
import { KIND } from '../src/types';

describe('Fix 5: reviews are NIP-32 labels, not NIP-89 handler info', () => {
  it('KIND.REVIEW is 1985 and differs from NIP-89 handler info', () => {
    expect(KIND.REVIEW).toBe(1985);
    expect(KIND.HANDLER_INFO).toBe(31990);
  });

  it('publishReview emits kind 1985 with L/l namespace tags', async () => {
    const preimage = randomBytes(32).toString('hex');
    const paymentHash = createHash('sha256').update(Buffer.from(preimage, 'hex')).digest('hex');
    await publishReview({
      subject: 'a'.repeat(64), subjectType: 'pubkey', rating: 5, content: 'great',
      preimage, paymentHash, listingEventId: 'b'.repeat(64),
    } as any, generateSecretKey(), ['wss://x']);
    const ev = (publishToRelays as any).mock.calls[0][0];
    expect(ev.kind).toBe(1985);
    expect(ev.kind).not.toBe(31990);
    expect(ev.tags).toContainEqual(['L', REVIEW_LABEL_NAMESPACE]);
    expect(ev.tags).toContainEqual(['l', 'verified-purchase', REVIEW_LABEL_NAMESPACE]);
  });
});
