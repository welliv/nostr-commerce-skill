/**
 * Scenario 11: Product Q&A (NIP-22 Threaded Comments)
 * Tests kind 1111 question/answer tagging logic and
 * thread parsing into a structured Q&A view.
 */
import { describe, it, expect } from 'vitest';
import { parseQAThread, buildQAThreads } from '../src/qa';
import type { NostrEvent } from '../src/types';

const LISTING_ID = 'e'.repeat(64);
const MERCHANT_PK = 'a'.repeat(64);
const BUYER_PK = 'b'.repeat(64);

function makeEvent(overrides: Partial<NostrEvent>): NostrEvent {
  return {
    id: 'f'.repeat(64),
    pubkey: BUYER_PK,
    created_at: 1_700_000_000,
    kind: 1111,
    tags: [],
    content: '',
    sig: 's'.repeat(128),
    ...overrides,
  };
}

/** A question event: has an uppercase "E" root tag referencing the listing */
function makeQuestion(id: string, content: string, createdAt = 1_700_000_000): NostrEvent {
  return makeEvent({
    id,
    content,
    created_at: createdAt,
    tags: [
      ['K', '30402'],
      ['E', LISTING_ID, 'wss://relay.test', MERCHANT_PK],
      ['p', MERCHANT_PK],
    ],
  });
}

/** An answer event: has a lowercase "e" reply tag referencing the question */
function makeAnswer(id: string, questionId: string, content: string, createdAt = 1_700_001_000): NostrEvent {
  return makeEvent({
    id,
    pubkey: MERCHANT_PK,
    content,
    created_at: createdAt,
    tags: [
      ['e', questionId, 'wss://relay.test', 'reply'],
      ['p', BUYER_PK],
    ],
  });
}

describe('Scenario 11: Product Q&A', () => {
  describe('parseQAThread', () => {
    it('identifies a question by uppercase E root tag', () => {
      const q = makeQuestion('q1'.padEnd(64, '0'), 'What material is this?');
      const entries = parseQAThread([q]);
      expect(entries).toHaveLength(1);
      expect(entries[0].type).toBe('question');
    });

    it('identifies an answer by lowercase e reply tag', () => {
      const a = makeAnswer('a1'.padEnd(64, '0'), 'q1'.padEnd(64, '0'), 'It is 100% cotton.');
      const entries = parseQAThread([a]);
      expect(entries).toHaveLength(1);
      expect(entries[0].type).toBe('answer');
      expect(entries[0].replyToId).toBe('q1'.padEnd(64, '0'));
    });

    it('returns entries sorted chronologically', () => {
      const q = makeQuestion('q1'.padEnd(64, '0'), 'First?', 1_000);
      const a = makeAnswer('a1'.padEnd(64, '0'), 'q1'.padEnd(64, '0'), 'Yes.', 2_000);
      const entries = parseQAThread([a, q]); // intentionally out of order
      expect(entries[0].createdAt).toBe(1_000);
      expect(entries[1].createdAt).toBe(2_000);
    });

    it('returns empty array for empty input', () => {
      expect(parseQAThread([])).toHaveLength(0);
    });

    it('preserves content verbatim', () => {
      const q = makeQuestion('q2'.padEnd(64, '0'), 'Does it come in red? 🔴');
      const entries = parseQAThread([q]);
      expect(entries[0].content).toBe('Does it come in red? 🔴');
    });
  });

  describe('buildQAThreads', () => {
    it('nests answers under their question', () => {
      const q = makeQuestion('q1'.padEnd(64, '0'), 'What size?');
      const a1 = makeAnswer('a1'.padEnd(64, '0'), 'q1'.padEnd(64, '0'), 'S/M/L available.');
      const a2 = makeAnswer('a2'.padEnd(64, '0'), 'q1'.padEnd(64, '0'), 'Also XL now.');
      const entries = parseQAThread([q, a1, a2]);
      const threads = buildQAThreads(entries);

      expect(threads).toHaveLength(1);
      expect(threads[0].question.content).toBe('What size?');
      expect(threads[0].answers).toHaveLength(2);
    });

    it('handles multiple independent questions each with answers', () => {
      const q1 = makeQuestion('q1'.padEnd(64, '0'), 'Q1', 1_000);
      const q2 = makeQuestion('q2'.padEnd(64, '0'), 'Q2', 1_001);
      const a1 = makeAnswer('a1'.padEnd(64, '0'), 'q1'.padEnd(64, '0'), 'A1', 1_002);
      const a2 = makeAnswer('a2'.padEnd(64, '0'), 'q2'.padEnd(64, '0'), 'A2', 1_003);
      const entries = parseQAThread([q1, q2, a1, a2]);
      const threads = buildQAThreads(entries);

      expect(threads).toHaveLength(2);
      threads.forEach(t => expect(t.answers).toHaveLength(1));
    });

    it('unanswered questions have empty answers array', () => {
      const q = makeQuestion('q1'.padEnd(64, '0'), 'Unanswered?');
      const threads = buildQAThreads(parseQAThread([q]));
      expect(threads[0].answers).toHaveLength(0);
    });

    it('returns empty array for empty input', () => {
      expect(buildQAThreads([])).toHaveLength(0);
    });
  });
});