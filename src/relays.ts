/**
 * relays.ts - Relay connection, publish, and fetch utilities
 *
 * All modules use these helpers. Never call pool methods directly
 * outside this file - connection management stays in one place.
 *
 * AUDIT FIXES APPLIED:
 *   BUG-01: pool.publish() returns Promise<string>[], not Promise<string>.
 *           Fixed by destructuring the array before awaiting.
 *   BLIND-02: Added verifyEvent() check inside onevent handler.
 *             Malicious relays cannot inject forged events.
 */

import { SimplePool, verifyEvent, type Event, type Filter } from "nostr-tools";
import { type PublishResult, type RelayResult, DEFAULT_RELAYS } from "./types.js";

// ─── Pool Singleton ───────────────────────────────────────────────────────────

let _pool: SimplePool | null = null;

export function getPool(): SimplePool {
  if (!_pool) _pool = new SimplePool();
  return _pool;
}

export function closePool(relays: string[]): void {
  if (_pool) {
    _pool.close(relays);
    _pool = null;
  }
}

// ─── Publish ──────────────────────────────────────────────────────────────────

const PUBLISH_TIMEOUT_MS = 8_000;

/**
 * Publish a finalized event to multiple relays.
 *
 * BUG-01 FIX: SimplePool.publish(relays, event) returns Promise<string>[]
 * - an array of promises, NOT a single promise. Previous code passed the
 * array to Promise.race as if it were a single thenable. It never resolved.
 *
 * Fix: publish to one relay at a time, destructure the single-element array.
 *
 * Returns a per-relay result summary. Never throws unless ALL relays fail.
 */
export async function publishToRelays(
  event: Event,
  relays: string[] = DEFAULT_RELAYS
): Promise<PublishResult> {
  const pool = getPool();

  const results: RelayResult[] = await Promise.all(
    relays.map(async (relay): Promise<RelayResult> => {
      try {
        // BUG-01 FIX: pool.publish([relay], event) → Promise<string>[]
        // Destructure to get the single promise for this one relay.
        const [publishPromise] = pool.publish([relay], event);

        await Promise.race([
          publishPromise,
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error(`Relay ${relay} timed out after ${PUBLISH_TIMEOUT_MS}ms`)),
              PUBLISH_TIMEOUT_MS
            )
          ),
        ]);

        return { relay, success: true };
      } catch (err) {
        return {
          relay,
          success: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    })
  );

  const successCount = results.filter((r) => r.success).length;

  if (successCount === 0) {
    const detail = results
      .map((r) => `  ${r.relay}: ${r.error}`)
      .join("\n");
    throw new Error(`Failed to publish event ${event.id} to any relay:\n${detail}`);
  }

  return { eventId: event.id, published: results, successCount };
}

// ─── Fetch ────────────────────────────────────────────────────────────────────

const FETCH_TIMEOUT_MS = 6_000;

/**
 * Fetch events matching a filter from multiple relays.
 * Deduplicates by event ID.
 *
 * BLIND-02 FIX: Added verifyEvent() check. Malicious relays can forge events
 * - without signature verification, a corrupt listing or fake review from a
 * relay operator would be indistinguishable from a legitimate one.
 * Events failing verification are silently dropped.
 */
export async function fetchEvents(
  filters: Filter[],
  relays: string[] = DEFAULT_RELAYS
): Promise<Event[]> {
  const pool = getPool();

  return new Promise((resolve) => {
    const events = new Map<string, Event>();

    const done = () => {
      sub.close();
      resolve([...events.values()]);
    };

    const timer = setTimeout(done, FETCH_TIMEOUT_MS);

    const sub = pool.subscribeMany(relays, filters as any, {
      onevent(event: Event) {
        // BLIND-02 FIX: verify signature before accepting
        if (!verifyEvent(event)) return;
        if (!events.has(event.id)) {
          events.set(event.id, event);
        }
      },
      oneose() {
        clearTimeout(timer);
        done();
      },
    });
  });
}

/**
 * Fetch a single event by ID. Returns null if not found within timeout.
 */
export async function fetchEventById(
  id: string,
  relays: string[] = DEFAULT_RELAYS
): Promise<Event | null> {
  const events = await fetchEvents([{ ids: [id] }], relays);
  return events[0] ?? null;
}

/**
 * Fetch events by author pubkey and kind(s).
 */
export async function fetchEventsByAuthor(
  pubkey: string,
  kinds: number[],
  relays: string[] = DEFAULT_RELAYS,
  limit = 50
): Promise<Event[]> {
  return fetchEvents([{ authors: [pubkey], kinds, limit }], relays);
}

/**
 * Fetch the most recent event of a kind from a pubkey.
 * Useful for kind 0 (metadata) and kind 10002 (relay list).
 */
export async function fetchLatestEvent(
  pubkey: string,
  kind: number,
  relays: string[] = DEFAULT_RELAYS
): Promise<Event | null> {
  const events = await fetchEvents(
    [{ authors: [pubkey], kinds: [kind], limit: 1 }],
    relays
  );
  if (events.length === 0) return null;
  return events.sort((a, b) => b.created_at - a.created_at)[0];
}

// ─── Relay Health ─────────────────────────────────────────────────────────────

/**
 * Check if a relay WebSocket endpoint is reachable within 3 seconds.
 */
export async function isRelayReachable(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const ws = new WebSocket(url);
      const timer = setTimeout(() => {
        ws.close();
        resolve(false);
      }, 3_000);
      ws.onopen = () => {
        clearTimeout(timer);
        ws.close();
        resolve(true);
      };
      ws.onerror = () => {
        clearTimeout(timer);
        resolve(false);
      };
    } catch {
      resolve(false);
    }
  });
}

/**
 * Filter a relay list to only reachable relays.
 * Call before publishing critical events (escrow release, payment requests).
 */
export async function filterReachableRelays(
  relays: string[]
): Promise<string[]> {
  const checks = await Promise.all(
    relays.map(async (url) => ({ url, ok: await isRelayReachable(url) }))
  );
  return checks.filter((c) => c.ok).map((c) => c.url);
}
