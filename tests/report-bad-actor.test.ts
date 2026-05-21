/**
 * Scenario 12: Report Bad Actor (NIP-56, kind 1984)
 * Tests report structure validation, parseReport parsing,
 * and publishReport input validation — all without relay calls.
 */
import { describe, it, expect } from 'vitest';
import { parseReport } from '../src/reports';
import type { NostrEvent } from '../src/types';

const REPORTER_PK = 'a'.repeat(64);
const REPORTED_PK = 'b'.repeat(64);
const EVIDENCE_ID  = 'c'.repeat(64);

function makeReport(overrides: Partial<NostrEvent> = {}): NostrEvent {
  return {
    id: 'd'.repeat(64),
    pubkey: REPORTER_PK,
    created_at: 1_700_000_000,
    kind: 1984,
    tags: [['p', REPORTED_PK, 'scam']],
    content: 'This merchant never shipped my order.',
    sig: 's'.repeat(128),
    ...overrides,
  };
}

describe('Scenario 12: Report Bad Actor (kind 1984)', () => {
  describe('parseReport', () => {
    it('parses a basic report with reporter, reported pubkey, and reason', () => {
      const parsed = parseReport(makeReport());
      expect(parsed).not.toBeNull();
      expect(parsed!.reporter).toBe(REPORTER_PK);
      expect(parsed!.reportedPubkey).toBe(REPORTED_PK);
      expect(parsed!.reason).toBe('scam');
      expect(parsed!.comment).toBe('This merchant never shipped my order.');
    });

    it('returns null when p-tag is missing', () => {
      const event = makeReport({ tags: [] });
      expect(parseReport(event)).toBeNull();
    });

    it('returns null when p-tag has no pubkey value', () => {
      const event = makeReport({ tags: [['p']] });
      expect(parseReport(event)).toBeNull();
    });

    it('includes evidenceEventId when e-tag with evidence marker is present', () => {
      const event = makeReport({
        tags: [
          ['p', REPORTED_PK, 'scam'],
          ['e', EVIDENCE_ID, '', 'evidence'],
        ],
      });
      const parsed = parseReport(event);
      expect(parsed!.evidenceEventId).toBe(EVIDENCE_ID);
    });

    it('evidenceEventId is undefined when no e-tag present', () => {
      const parsed = parseReport(makeReport());
      expect(parsed!.evidenceEventId).toBeUndefined();
    });

    it('does not include evidence from e-tag without "evidence" marker', () => {
      const event = makeReport({
        tags: [
          ['p', REPORTED_PK, 'scam'],
          ['e', EVIDENCE_ID, '', 'reply'], // wrong marker
        ],
      });
      const parsed = parseReport(event);
      expect(parsed!.evidenceEventId).toBeUndefined();
    });

    it('preserves all ReportReason values correctly', () => {
      const reasons = ['nudity', 'malware', 'profanity', 'illegal', 'spam', 'impersonation', 'scam', 'other'] as const;
      reasons.forEach(reason => {
        const event = makeReport({ tags: [['p', REPORTED_PK, reason]] });
        const parsed = parseReport(event);
        expect(parsed!.reason).toBe(reason);
      });
    });

    it('defaults reason to "other" when p-tag has no reason value', () => {
      const event = makeReport({ tags: [['p', REPORTED_PK]] });
      const parsed = parseReport(event);
      expect(parsed!.reason).toBe('other');
    });

    it('preserves reporter pubkey from event.pubkey (not from tags)', () => {
      const parsed = parseReport(makeReport());
      expect(parsed!.reporter).toBe(REPORTER_PK);
    });

    it('preserves eventId and createdAt', () => {
      const event = makeReport({ id: 'e'.repeat(64), created_at: 1_800_000_000 });
      const parsed = parseReport(event);
      expect(parsed!.eventId).toBe('e'.repeat(64));
      expect(parsed!.createdAt).toBe(1_800_000_000);
    });

    it('handles empty comment gracefully', () => {
      const event = makeReport({ content: '' });
      const parsed = parseReport(event);
      expect(parsed!.comment).toBe('');
    });
  });

  describe('publishReport input validation', () => {
    it('throws when reportedPubkey is less than 64 chars', async () => {
      const { publishReport } = await import('../src/reports');
      await expect(
        publishReport({ reportedPubkey: 'short', reason: 'scam' }, new Uint8Array(32))
      ).rejects.toThrow(/reportedPubkey/);
    });

    it('throws when reportedPubkey is empty', async () => {
      const { publishReport } = await import('../src/reports');
      await expect(
        publishReport({ reportedPubkey: '', reason: 'spam' }, new Uint8Array(32))
      ).rejects.toThrow(/reportedPubkey/);
    });

    it('throws when evidenceEventId is not 64 chars', async () => {
      const { publishReport } = await import('../src/reports');
      await expect(
        publishReport(
          { reportedPubkey: REPORTED_PK, reason: 'scam', evidenceEventId: 'short' },
          new Uint8Array(32)
        )
      ).rejects.toThrow(/evidenceEventId/);
    });
  });
});