/**
 * storage.ts — Encrypted Identity Storage (BLIND-03 Fix)
 *
 * Non-technical merchants cannot manage raw Uint8Array private keys.
 * This module provides password-based encrypted storage for both
 * browser (WebCrypto) and Node.js (node:crypto) environments.
 *
 * Encryption: AES-256-GCM
 * Key derivation: PBKDF2 with SHA-256, 310,000 iterations (NIST recommendation)
 * Storage format: JSON blob safe for localStorage, files, or databases
 *
 * SECURITY MODEL:
 *   - The password never leaves the device
 *   - The encrypted blob is safe to store anywhere (it requires the password)
 *   - A lost password = lost identity. There is no recovery. Warn users.
 *   - This is better than plaintext storage. It is not a HSM.
 */

import { identityFromPrivateKey } from "./identity.js";
import type { NostrIdentity } from "./types.js";

// ─── Encrypted Identity Format ────────────────────────────────────────────────

export interface EncryptedIdentity {
  /** Version for future migration */
  version: 1;
  /** PBKDF2 salt, base64 encoded */
  salt: string;
  /** AES-GCM IV, base64 encoded */
  iv: string;
  /** Encrypted private key (hex), base64 encoded */
  ciphertext: string;
  /** Public key (hex) — stored unencrypted for quick identity display */
  pubkey: string;
  /** npub for display */
  npub: string;
  /** Human-readable label for this identity */
  label?: string;
  createdAt: number;
}

// ─── Crypto Utilities ─────────────────────────────────────────────────────────

function getSubtle(): SubtleCrypto {
  if (typeof globalThis.crypto?.subtle !== "undefined") {
    return globalThis.crypto.subtle;
  }
  throw new Error(
    "Web Crypto API not available. Node.js 18+ or modern browser required."
  );
}

function toBase64(buf: ArrayBuffer | Uint8Array): string {
  return Buffer.from(buf instanceof Uint8Array ? buf : new Uint8Array(buf))
    .toString("base64");
}

function fromBase64(str: string): Uint8Array {
  return new Uint8Array(Buffer.from(str, "base64"));
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function deriveKey(
  password: string,
  salt: BufferSource
): Promise<CryptoKey> {
  const subtle = getSubtle();
  const encoder = new TextEncoder();

  const baseKey = await subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveKey"]
  );

  return subtle.deriveKey(
    {
      name: "PBKDF2",
      salt,
      iterations: 310_000,   // NIST SP 800-132 recommendation for SHA-256
      hash: "SHA-256",
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

// ─── Save Identity ────────────────────────────────────────────────────────────

/**
 * Encrypt and save a Nostr identity with a password.
 *
 * Returns an EncryptedIdentity object. Store this in:
 *   Browser  → localStorage.setItem("nostr-identity", JSON.stringify(blob))
 *   Node.js  → fs.writeFileSync("identity.json", JSON.stringify(blob))
 *   Database → any text column
 *
 * @example
 *   const identity = generateIdentity();
 *   const blob = await saveIdentityEncrypted(identity, "my-strong-password");
 *   localStorage.setItem("nostr-id", JSON.stringify(blob));
 */
export async function saveIdentityEncrypted(
  identity: NostrIdentity & { privateKey: Uint8Array },
  password: string,
  label?: string
): Promise<EncryptedIdentity> {
  if (!password || password.length < 8) {
    throw new Error("Password must be at least 8 characters.");
  }

  const subtle = getSubtle();
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(32));
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt as BufferSource);

  const encoder = new TextEncoder();
  const privateKeyHex = bytesToHex(identity.privateKey);

  const ciphertext = await subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoder.encode(privateKeyHex)
  );

  return {
    version: 1,
    salt: toBase64(salt),
    iv: toBase64(iv),
    ciphertext: toBase64(ciphertext),
    pubkey: identity.pubkey,
    npub: identity.npub,
    label,
    createdAt: Math.floor(Date.now() / 1000),
  };
}

// ─── Load Identity ────────────────────────────────────────────────────────────

/**
 * Decrypt and load a Nostr identity from an EncryptedIdentity blob.
 *
 * Throws if the password is wrong or the blob is corrupted.
 *
 * @example
 *   const blob = JSON.parse(localStorage.getItem("nostr-id") ?? "");
 *   const identity = await loadIdentityDecrypted(blob, "my-strong-password");
 *   // identity.privateKey is ready to use
 */
export async function loadIdentityDecrypted(
  blob: EncryptedIdentity,
  password: string
): Promise<NostrIdentity & { privateKey: Uint8Array }> {
  if (blob.version !== 1) {
    throw new Error(`Unknown encrypted identity version: ${blob.version}`);
  }

  const subtle = getSubtle();
  const salt = fromBase64(blob.salt);
  const iv = fromBase64(blob.iv);
  const ciphertext = fromBase64(blob.ciphertext);
  const key = await deriveKey(password, salt as BufferSource);

  let decrypted: ArrayBuffer;
  try {
    decrypted = await subtle.decrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, ciphertext as unknown as BufferSource);
  } catch {
    throw new Error(
      "Decryption failed. The password may be incorrect, or the identity file is corrupted."
    );
  }

  const privateKeyHex = new TextDecoder().decode(decrypted);
  const privateKey = hexToBytes(privateKeyHex);
  const identity = identityFromPrivateKey(privateKey);

  // Sanity check: derived pubkey must match stored pubkey
  if (identity.pubkey !== blob.pubkey) {
    throw new Error(
      "Decrypted key does not match stored public key. Identity file may be corrupted."
    );
  }

  return identity;
}

// ─── Browser Convenience Functions ───────────────────────────────────────────

const STORAGE_KEY = "nostr-commerce-identity";

/**
 * Save an identity to browser localStorage (encrypted).
 * For browser environments only.
 */
export async function saveIdentityToLocalStorage(
  identity: NostrIdentity & { privateKey: Uint8Array },
  password: string,
  label?: string
): Promise<void> {
  if (typeof localStorage === "undefined") {
    throw new Error("localStorage is not available in this environment.");
  }
  const blob = await saveIdentityEncrypted(identity, password, label);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(blob));
}

/**
 * Load an identity from browser localStorage.
 * Returns null if no identity is stored.
 */
export async function loadIdentityFromLocalStorage(
  password: string
): Promise<(NostrIdentity & { privateKey: Uint8Array }) | null> {
  if (typeof localStorage === "undefined") {
    throw new Error("localStorage is not available in this environment.");
  }
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;

  const blob: EncryptedIdentity = JSON.parse(raw);
  return loadIdentityDecrypted(blob, password);
}

/**
 * Check if a stored identity exists in browser localStorage.
 */
export function hasStoredIdentity(): boolean {
  if (typeof localStorage === "undefined") return false;
  return localStorage.getItem(STORAGE_KEY) !== null;
}

/**
 * Remove the stored identity from localStorage.
 * Irreversible without the original private key.
 */
export function clearStoredIdentity(): void {
  if (typeof localStorage !== "undefined") {
    localStorage.removeItem(STORAGE_KEY);
  }
}

// ─── Node.js File Storage ─────────────────────────────────────────────────────

/**
 * Save an identity to a file on disk (Node.js only).
 *
 * @example
 *   await saveIdentityToFile(identity, "password123", "./merchant-identity.json");
 */
export async function saveIdentityToFile(
  identity: NostrIdentity & { privateKey: Uint8Array },
  password: string,
  filepath: string,
  label?: string
): Promise<void> {
  const { writeFileSync } = await import("node:fs");
  const blob = await saveIdentityEncrypted(identity, password, label);
  writeFileSync(filepath, JSON.stringify(blob, null, 2), { mode: 0o600 }); // owner-only read
}

/**
 * Load an identity from a file on disk (Node.js only).
 */
export async function loadIdentityFromFile(
  filepath: string,
  password: string
): Promise<NostrIdentity & { privateKey: Uint8Array }> {
  const { readFileSync } = await import("node:fs");
  const raw = readFileSync(filepath, "utf-8");
  const blob: EncryptedIdentity = JSON.parse(raw);
  return loadIdentityDecrypted(blob, password);
}
