/**
 * identity.ts - Nostr Identity & Onboarding (Scenarios 1, 5)
 *
 * Covers:
 *   NIP-01  - keypair generation and event signing
 *   NIP-07  - browser extension signer (Alby, nos2x, Flamingo)
 *   NIP-19  - bech32 encoding (npub, nsec, nprofile, naddr)
 *   NIP-05  - DNS-based verification (user@domain.com → pubkey)
 *   NIP-39  - external identity claims (GitHub, Twitter, etc.)
 *
 * AUDIT FIXES APPLIED:
 *   BUG-02: signWithNip07 now fetches pubkey from extension and sets it
 *           on the template before calling signEvent(). NIP-07 spec requires
 *           pubkey to be present in the event before signing.
 */

import {
  generateSecretKey,
  getPublicKey,
  finalizeEvent,
  verifyEvent,
} from "nostr-tools";
import {
  npubEncode,
  nsecEncode,
  naddrEncode,
  decode,
} from "nostr-tools/nip19";
import { fetchEvents, fetchLatestEvent } from "./relays.js";
import {
  type NostrEvent,
  type NostrIdentity,
  type VerificationResult,
  type EventTemplate,
  KIND,
  DEFAULT_RELAYS,
} from "./types.js";

// ─── Key Generation ───────────────────────────────────────────────────────────

/**
 * Generate a fresh Nostr identity (keypair).
 *
 * SECURITY - returned privateKey MUST be stored securely:
 *   Browser  → Use saveIdentityEncrypted() from storage.ts
 *   Server   → Store in secrets manager (AWS Secrets Manager, HashiCorp Vault)
 *   Never    → Log, hardcode, commit, or transmit over HTTP
 */
export function generateIdentity(): NostrIdentity & { privateKey: Uint8Array } {
  const privateKey = generateSecretKey();
  const pubkey = getPublicKey(privateKey);
  return {
    pubkey,
    npub: npubEncode(pubkey),
    privateKey,
  };
}

/**
 * Restore an identity from an existing private key.
 */
export function identityFromPrivateKey(
  privateKey: Uint8Array
): NostrIdentity & { privateKey: Uint8Array } {
  const pubkey = getPublicKey(privateKey);
  return { pubkey, npub: npubEncode(pubkey), privateKey };
}

/**
 * Decode an nsec string (bech32) to a Uint8Array private key.
 * SECURITY: treat the output with the same care as the nsec string.
 */
export function nsecToPrivateKey(nsec: string): Uint8Array {
  const decoded = decode(nsec);
  if (decoded.type !== "nsec") {
    throw new Error(`Expected nsec bech32 string, got: ${decoded.type}`);
  }
  return decoded.data;
}

/**
 * Encode a private key Uint8Array to nsec bech32 string.
 * Only use for display/export - never store the string in plaintext.
 */
export function privateKeyToNsec(privateKey: Uint8Array): string {
  return nsecEncode(privateKey);
}

// ─── Event Signing ────────────────────────────────────────────────────────────

/**
 * Sign an event template with a local private key.
 * Use this server-side or in environments without NIP-07.
 */
export function signEvent(
  template: EventTemplate,
  privateKey: Uint8Array
): NostrEvent {
  return finalizeEvent(template, privateKey) as NostrEvent;
}

// ─── NIP-07 Browser Signer ────────────────────────────────────────────────────

/**
 * Check if a NIP-07 browser extension is available.
 * Compatible with Alby, nos2x, Flamingo, Nostore.
 */
export function hasNip07Signer(): boolean {
  return typeof window !== "undefined" && "nostr" in window;
}

/**
 * Get the authenticated user's public key from the NIP-07 extension.
 * Throws if no extension is installed.
 */
export async function getNip07Pubkey(): Promise<string> {
  if (!hasNip07Signer()) {
    throw new Error(
      "No NIP-07 browser extension found.\n" +
        "Install one of: Alby (getalby.com), nos2x, Flamingo, Nostore"
    );
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (window as any).nostr.getPublicKey();
}

/**
 * Sign an event template using the NIP-07 browser extension.
 *
 * BUG-02 FIX: NIP-07 specification requires the event to have `pubkey` set
 * before passing to signEvent(). Previous implementation passed a bare
 * EventTemplate (no pubkey field) - extensions throw or produce invalid events.
 *
 * Fix: fetch pubkey from extension first, inject it, then sign.
 * The extension prompts the user to approve.
 */
export async function signWithNip07(
  template: EventTemplate
): Promise<NostrEvent> {
  if (!hasNip07Signer()) {
    throw new Error("No NIP-07 extension found.");
  }

  // BUG-02 FIX: Fetch pubkey from extension and inject before signing
  const pubkey = await getNip07Pubkey();
  const eventWithPubkey = { ...template, pubkey };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const signed = await (window as any).nostr.signEvent(eventWithPubkey);

  if (!verifyEvent(signed)) {
    throw new Error(
      "NIP-07 extension returned an event with an invalid signature. " +
        "This may indicate a buggy or malicious extension."
    );
  }

  return signed as NostrEvent;
}

// ─── NIP-05 Verification ──────────────────────────────────────────────────────

/**
 * Verify a NIP-05 identifier against a pubkey.
 *
 * Fetches https://domain.com/.well known/nostr.json?name=<username>
 * and checks that names[username] === pubkey.
 *
 * @example verifyNip05("alice@shopstr.store", "abc123pubkeyhex...")
 */
export async function verifyNip05(
  identifier: string,
  pubkey: string
): Promise<boolean> {
  const [name, domain] = identifier.split("@");
  if (!name || !domain) return false;

  try {
    const url = `https://${domain}/.well known/nostr.json?name=${encodeURIComponent(name)}`;
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return false;
    const data = await res.json();
    return data?.names?.[name] === pubkey;
  } catch {
    return false;
  }
}

// ─── Multi-Signal Identity Verification (Scenario 5) ─────────────────────────

/**
 * Perform full identity verification for a pubkey:
 *   NIP-05  - DNS domain verification
 *   NIP-39  - external identity links (GitHub, Twitter, etc.)
 *   NIP-85  - third party trust attestations
 *
 * Returns a structured result the UI can use to display trust signals.
 */
export async function verifyIdentity(
  pubkey: string,
  relays: string[] = DEFAULT_RELAYS
): Promise<VerificationResult> {
  const metadata = await fetchLatestEvent(pubkey, KIND.METADATA, relays);

  let nip05Valid = false;
  let nip05Identifier: string | undefined;
  const externalLinks: VerificationResult["externalLinks"] = [];

  if (metadata) {
    try {
      const content = JSON.parse(metadata.content);

      if (content.nip05 && typeof content.nip05 === "string") {
        nip05Identifier = content.nip05;
        nip05Valid = await verifyNip05(content.nip05, pubkey);
      }
    } catch {
      // malformed profile content - skip
    }

    // NIP-39: external identity claims from "i" tags on kind 0
    for (const tag of metadata.tags) {
      if (tag[0] === "i" && tag[1] && tag[2]) {
        const colonIdx = tag[1].indexOf(":");
        if (colonIdx !== -1) {
          externalLinks.push({
            platform: tag[1].slice(0, colonIdx),
            handle: tag[1].slice(colonIdx + 1),
            proofUrl: tag[2],
          });
        }
      }
    }
  }

  // NIP-85: trusted third party attestations for this pubkey
  const attestations = await fetchEvents(
    [{ kinds: [KIND.TRUSTED_ASSERTION], "#d": [pubkey], limit: 20 }],
    relays
  ) as NostrEvent[];

  return { nip05Valid, nip05Identifier, externalLinks, attestations };
}

// ─── Profile Publishing ───────────────────────────────────────────────────────

export interface ProfileData {
  name?: string;
  displayName?: string;
  about?: string;
  picture?: string;
  banner?: string;
  website?: string;
  /** Lightning address for zaps: user@domain.com */
  lud16?: string;
  /** NIP-05 identifier: user@domain.com */
  nip05?: string;
}

/**
 * Build a kind 0 metadata event template.
 * Pass to signEvent() or signWithNip07(), then publishToRelays().
 */
export function buildProfileEvent(profile: ProfileData): EventTemplate {
  // Filter out undefined values - JSON.stringify omits them anyway,
  // but being explicit prevents confusion
  const content: Record<string, string> = {};
  if (profile.name) content.name = profile.name;
  if (profile.displayName) content.display_name = profile.displayName;
  if (profile.about) content.about = profile.about;
  if (profile.picture) content.picture = profile.picture;
  if (profile.banner) content.banner = profile.banner;
  if (profile.website) content.website = profile.website;
  if (profile.lud16) content.lud16 = profile.lud16;
  if (profile.nip05) content.nip05 = profile.nip05;

  return {
    kind: KIND.METADATA,
    created_at: Math.floor(Date.now() / 1000),
    tags: [],
    content: JSON.stringify(content),
  };
}

// ─── NIP-19 Encoding Utilities ────────────────────────────────────────────────

/**
 * Encode a listing event as a shareable naddr string.
 * naddr links are stable across relay changes (identifies by dTag, not event ID).
 *
 * @example
 *   const link = encodeListingAddress("candle-001", merchantPubkey, relays);
 *   // → "naddr1..."  - shareable link to this listing
 */
export function encodeListingAddress(
  dTag: string,
  merchantPubkey: string,
  relays: string[] = []
): string {
  return naddrEncode({
    kind: KIND.LISTING_ACTIVE,
    pubkey: merchantPubkey,
    identifier: dTag,
    relays,
  });
}
