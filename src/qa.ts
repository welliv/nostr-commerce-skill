/**
 * qa.ts - Product Q&A via NIP-22 Comments (Scenario 11)
 *
 * NIP-22 defines kind 1111 for comment threads on any root event.
 * Here we use it for Q&A threads on kind 30402 product listings.
 *
 * Why public Q&A matters (game theory):
 *   Without it: buyers DM merchants, questions are answered privately,
 *               the same question is asked 100 times, returns increase.
 *   With it: every answered question is public, permanent, and searchable.
 *            The knowledge base compounds - future buyers benefit from
 *            questions asked by previous buyers.
 *   This is a positive externality: answering one question helps everyone.
 *   Protocol-native, no CMS required, no moderation needed.
 */

import { finalizeEvent, verifyEvent } from "nostr-tools";
import { publishToRelays, fetchEvents } from "./relays.js";
import {
  type QuestionData,
  type AnswerData,
  type NostrEvent,
  type PublishResult,
  KIND,
  DEFAULT_RELAYS,
} from "./types.js";

// ─── Post a Question ──────────────────────────────────────────────────────────

/**
 * Post a public question on a product listing.
 *
 * The question is a kind 1111 comment event referencing:
 *   K - the root event kind (30402)
 *   E - the listing event ID + relay hint + listing author pubkey
 *
 * Anyone can see the question. The merchant is notified via their p-tag.
 *
 * @param data       - Question content + listing reference
 * @param askerKey   - Buyer's private key
 * @param relays     - Relays to publish to
 */
export async function postQuestion(
  data: QuestionData,
  askerKey: Uint8Array,
  relays: string[] = DEFAULT_RELAYS
): Promise<PublishResult> {
  if (!data.question.trim()) {
    throw new Error("Question cannot be empty.");
  }
  if (!data.listingEventId || data.listingEventId.length !== 64) {
    throw new Error("listingEventId must be a valid 64-char hex event ID.");
  }
  if (!data.listingAuthorPubkey || data.listingAuthorPubkey.length !== 64) {
    throw new Error("listingAuthorPubkey must be a valid 64-char hex pubkey.");
  }

  const relayHint = data.relayHint ?? relays[0] ?? "";

  const event = finalizeEvent(
    {
      kind: KIND.COMMENT, // 1111
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        // Root event kind - required by NIP-22
        ["K", String(KIND.LISTING_ACTIVE)],
        // Root event reference with relay hint and author pubkey
        ["E", data.listingEventId, relayHint, data.listingAuthorPubkey],
        // Tag the merchant so they receive the notification
        ["p", data.listingAuthorPubkey],
      ],
      content: data.question,
    },
    askerKey
  );

  if (!verifyEvent(event)) {
    throw new Error("Generated question event has an invalid signature.");
  }

  return publishToRelays(event, relays);
}

// ─── Post an Answer ───────────────────────────────────────────────────────────

/**
 * Post a reply to a buyer's question.
 *
 * The answer is a kind 1111 comment referencing the question event.
 * Typically published by the merchant, but any knowledgeable user can answer.
 *
 * @param data        - Answer content + question reference
 * @param answererKey - Merchant's (or community member's) private key
 * @param relays      - Relays to publish to
 */
export async function postAnswer(
  data: AnswerData,
  answererKey: Uint8Array,
  relays: string[] = DEFAULT_RELAYS
): Promise<PublishResult> {
  if (!data.answer.trim()) {
    throw new Error("Answer cannot be empty.");
  }
  if (!data.questionEventId || data.questionEventId.length !== 64) {
    throw new Error("questionEventId must be a valid 64-char hex event ID.");
  }
  if (!data.questionAuthorPubkey || data.questionAuthorPubkey.length !== 64) {
    throw new Error("questionAuthorPubkey must be a valid 64-char hex pubkey.");
  }

  const event = finalizeEvent(
    {
      kind: KIND.COMMENT, // 1111
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        // Parent event reference (the question)
        ["e", data.questionEventId, "", "reply"],
        // Tag the questioner so they get notified
        ["p", data.questionAuthorPubkey],
      ],
      content: data.answer,
    },
    answererKey
  );

  if (!verifyEvent(event)) {
    throw new Error("Generated answer event has an invalid signature.");
  }

  return publishToRelays(event, relays);
}

// ─── Fetch Q&A Thread ─────────────────────────────────────────────────────────

/**
 * Fetch all questions (and their answers) for a listing event.
 *
 * Returns all kind 1111 events that reference the listing as their root.
 */
export async function fetchQAThread(
  listingEventId: string,
  relays: string[] = DEFAULT_RELAYS
): Promise<NostrEvent[]> {
  return fetchEvents(
    [
      {
        kinds: [KIND.COMMENT],
        "#E": [listingEventId],
        limit: 200,
      },
    ],
    relays
  ) as Promise<NostrEvent[]>;
}

/**
 * Fetch unread questions sent to a merchant (tagged with their pubkey).
 */
export async function fetchMerchantQuestions(
  merchantPubkey: string,
  relays: string[] = DEFAULT_RELAYS,
  since?: number
): Promise<NostrEvent[]> {
  const filter: any = {
    kinds: [KIND.COMMENT],
    "#p": [merchantPubkey],
    limit: 100,
  };
  if (since != null) filter.since = since;

  return fetchEvents([filter], relays) as Promise<NostrEvent[]>;
}

// ─── Parse Q&A Thread ─────────────────────────────────────────────────────────

export interface ParsedQAEntry {
  type: "question" | "answer";
  authorPubkey: string;
  content: string;
  eventId: string;
  createdAt: number;
  /** For answers: the question event ID this replies to */
  replyToId?: string;
}

/**
 * Parse raw kind 1111 events into a structured Q&A thread.
 * Separates questions (referencing the listing via E tag) from
 * answers (referencing a question via e tag with "reply" marker).
 */
export function parseQAThread(events: NostrEvent[]): ParsedQAEntry[] {
  return events
    .map((event): ParsedQAEntry => {
      // Answers reference a parent via lowercase "e" with "reply" marker
      const replyTag = event.tags.find(
        (t) => t[0] === "e" && t[3] === "reply"
      );

      // Questions reference the root listing via uppercase "E"
      const isQuestion = event.tags.some((t) => t[0] === "E");

      return {
        type: replyTag ? "answer" : isQuestion ? "question" : "question",
        authorPubkey: event.pubkey,
        content: event.content,
        eventId: event.id,
        createdAt: event.created_at,
        replyToId: replyTag?.[1],
      };
    })
    .sort((a, b) => a.createdAt - b.createdAt); // chronological order
}

/**
 * Organize a flat Q&A list into a threaded structure.
 * Returns questions with their answers nested underneath.
 */
export interface QAThread {
  question: ParsedQAEntry;
  answers: ParsedQAEntry[];
}

export function buildQAThreads(entries: ParsedQAEntry[]): QAThread[] {
  const questions = entries.filter((e) => e.type === "question");
  const answers = entries.filter((e) => e.type === "answer");

  return questions.map((question) => ({
    question,
    answers: answers
      .filter((a) => a.replyToId === question.eventId)
      .sort((a, b) => a.createdAt - b.createdAt),
  }));
}
