/**
 * relay-discovery.ts - NIP-65 Relay List Discovery (BLIND-01 Fix)
 *
 * BLIND-01: The build hardcoded 4 relays as defaults. Without NIP-65 support,
 * events published to "the defaults" may never reach a user's actual clients,
 * and a user's events may never be fetched by their contacts' clients.
 *
 * NIP-65 defines kind 10002 as a user's relay list:
 *   ["r", "wss://relay.url"]               → read AND write
 *   ["r", "wss://relay.url", "read"]        → read only
 *   ["r", "wss://relay.url", "write"]       → write only
 *
 * The protocol's answer to "which relay do I use?" is:
 *   For writing to a user → use their WRITE relays
 *   For reading from a user → use their READ relays
 *
 * Without this, all relay selection is guesswork.
 */

import { finalizeEvent } from "nostr-tools";
import { fetchLatestEvent } from "./relays.js";
import { type UserRelays, type NostrEvent, DEFAULT_RELAYS } from "./types.js";

// ─── Fetch User's Relay List ──────────────────────────────────────────────────

const KIND_RELAY_LIST = 10002;

/**
 * Fetch a user's NIP-65 relay list.
 *
 * Falls back to DEFAULT_RELAYS if the user has not published a kind 10002 event.
 *
 * @param pubkey - The user's hex pubkey
 * @param bootstrapRelays - Relays to query for the relay list itself
 *                          (chicken-and-egg: we need some relays to find their relays)
 *
 * @example
 *   const merchantRelays = await fetchUserRelays(merchantPubkey);
 *   // Then publish orders to merchantRelays.write
 *   // And fetch merchant listings from merchantRelays.read
 */
export async function fetchUserRelays(
  pubkey: string,
  bootstrapRelays: string[] = DEFAULT_RELAYS
): Promise<UserRelays> {
  const event = await fetchLatestEvent(pubkey, KIND_RELAY_LIST, bootstrapRelays);

  if (!event) {
    // User has no relay list - fall back to defaults
    return {
      pubkey,
      read: DEFAULT_RELAYS,
      write: DEFAULT_RELAYS,
      both: DEFAULT_RELAYS,
      all: DEFAULT_RELAYS,
    };
  }

  const read: string[] = [];
  const write: string[] = [];
  const both: string[] = [];

  for (const tag of event.tags) {
    if (tag[0] !== "r" || !tag[1]) continue;
    const url = tag[1].trim();
    const marker = tag[2]?.toLowerCase();

    if (marker === "read") {
      read.push(url);
    } else if (marker === "write") {
      write.push(url);
    } else {
      // No marker = both read and write
      both.push(url);
      read.push(url);
      write.push(url);
    }
  }

  // If relay list exists but is empty or malformed, fall back
  const all = [...new Set([...read, ...write])];
  if (all.length === 0) {
    return {
      pubkey,
      read: DEFAULT_RELAYS,
      write: DEFAULT_RELAYS,
      both: DEFAULT_RELAYS,
      all: DEFAULT_RELAYS,
    };
  }

  return { pubkey, read, write, both, all };
}

// ─── Multi-User Relay Aggregation ─────────────────────────────────────────────

/**
 * Build a relay set optimized for reaching multiple users simultaneously.
 *
 * When you need to publish an event visible to multiple recipients (e.g., a
 * group payment request), use the union of all their write relays.
 *
 * @param pubkeys - Array of hex pubkeys to build a relay set for
 * @param mode - "read" (where to fetch their events) or "write" (where they read)
 * @param bootstrapRelays - Relays to use for fetching relay lists
 */
export async function buildRelaySetForUsers(
  pubkeys: string[],
  mode: "read" | "write" = "write",
  bootstrapRelays: string[] = DEFAULT_RELAYS
): Promise<string[]> {
  const relayLists = await Promise.all(
    pubkeys.map((pk) => fetchUserRelays(pk, bootstrapRelays))
  );

  const combined = new Set<string>();
  for (const relayList of relayLists) {
    const relays = mode === "write" ? relayList.write : relayList.read;
    for (const url of relays) combined.add(url);
  }

  return [...combined];
}

// ─── Smart Relay Selection ────────────────────────────────────────────────────

/**
 * Get the best relays to use for sending a message to a specific user.
 *
 * Protocol-correct behaviour:
 *   "To send an event to user X, publish to X's WRITE relays"
 *   (their write relays are where their clients read from)
 *
 * @example
 *   const relays = await getRelaysForUser(merchantPubkey);
 *   await publishToRelays(orderEvent, relays);
 */
export async function getRelaysForUser(
  pubkey: string,
  bootstrapRelays: string[] = DEFAULT_RELAYS
): Promise<string[]> {
  const userRelays = await fetchUserRelays(pubkey, bootstrapRelays);
  return userRelays.write.length > 0 ? userRelays.write : DEFAULT_RELAYS;
}

/**
 * Get the best relays to use for fetching events FROM a specific user.
 *
 * Protocol-correct behaviour:
 *   "To read events from user X, query X's READ relays"
 *
 * @example
 *   const relays = await getRelaysFromUser(merchantPubkey);
 *   const listings = await fetchMerchantListings(merchantPubkey, relays);
 */
export async function getRelaysFromUser(
  pubkey: string,
  bootstrapRelays: string[] = DEFAULT_RELAYS
): Promise<string[]> {
  const userRelays = await fetchUserRelays(pubkey, bootstrapRelays);
  return userRelays.read.length > 0 ? userRelays.read : DEFAULT_RELAYS;
}

// ─── Publish User's Own Relay List ────────────────────────────────────────────

export interface RelayPreference {
  url: string;
  /** undefined = both read and write */
  mode?: "read" | "write";
}

/**
 * Build a kind 10002 relay list event for a user to publish.
 * Call publishToRelays() with the result + their current relays.
 */
export function buildRelayListEvent(
  relayPreferences: RelayPreference[],
  privateKey: Uint8Array
): NostrEvent {
  const tags = relayPreferences.map((r): string[] => {
    if (r.mode) return ["r", r.url, r.mode];
    return ["r", r.url];
  });

  return finalizeEvent(
    {
      kind: KIND_RELAY_LIST,
      created_at: Math.floor(Date.now() / 1000),
      tags,
      content: "",
    },
    privateKey
  ) as NostrEvent;
}
