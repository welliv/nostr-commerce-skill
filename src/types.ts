/**
 * types.ts — Shared types for the Nostr Commerce Skill
 *
 * Single source of truth. Every other module imports from here.
 * Do not duplicate type definitions in other files.
 *
 * AUDIT FIXES APPLIED:
 *   BUG-03: Added amountMsats to EscrowSession
 *   BUG-05: Removed nonexistent KIND.MARKETPLACE (30019), added STALL/PRODUCT
 *   BUG-06: Renamed HANDLER_INFO to REVIEW with accurate comment
 *   BUG-08: Added paymentHash to ReviewData, made listingEventId required
 */

// ─── Core Nostr Types ────────────────────────────────────────────────────────

export interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

/** Unsigned event template passed to finalizeEvent() */
export interface EventTemplate {
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
}

export interface RelayResult {
  relay: string;
  success: boolean;
  error?: string;
}

export interface PublishResult {
  eventId: string;
  published: RelayResult[];
  successCount: number;
}

// ─── Identity Types (Scenarios 1, 5) ────────────────────────────────────────

export interface NostrIdentity {
  pubkey: string;       // hex
  npub: string;         // bech32
  privateKey?: Uint8Array;
}

export interface VerificationResult {
  nip05Valid: boolean;
  nip05Identifier?: string;
  externalLinks: { platform: string; handle: string; proofUrl: string }[];
  attestations: NostrEvent[];
}

// ─── Relay Types (NIP-65) ────────────────────────────────────────────────────

export interface RelayConfig {
  url: string;
  read: boolean;
  write: boolean;
}

export interface UserRelays {
  pubkey: string;
  read: string[];
  write: string[];
  both: string[];
  all: string[];
}

// ─── Listing Types (Scenarios 2, 3, 19) ─────────────────────────────────────

export type ListingCurrency = "BTC" | "SATS" | "USD" | "EUR" | "GBP" | string;
export type ListingFrequency = "hour" | "day" | "week" | "month" | "year";
export type ListingType = "physical" | "digital" | "service" | "subscription";

export interface ListingPrice {
  amount: string;
  currency: ListingCurrency;
  frequency?: ListingFrequency;
}

export interface ListingData {
  /** Unique stable ID — reuse the same dTag to UPDATE the listing (replaceable event) */
  dTag: string;
  title: string;
  summary: string;
  /** Full description in Markdown */
  content: string;
  price: ListingPrice;
  type: ListingType;
  images?: string[];
  location?: string;
  categories?: string[];
  /** Unix timestamp — NIP-40 expiration. Relay stops serving event after this. */
  expiresAt?: number;
  /** true = kind 30403 draft; false/undefined = kind 30402 active */
  isDraft?: boolean;
}

// ─── Order Types (Scenario 6) ────────────────────────────────────────────────

export interface OrderContact {
  nostr: string;
  email?: string;
  phone?: string;
}

export interface OrderItem {
  productId: string;
  quantity: number;
}

export interface OrderData {
  id: string;
  type: 0;
  name?: string;
  address?: string;
  message?: string;
  contact: OrderContact;
  items: OrderItem[];
  shippingId?: string;
}

export interface PaymentOption {
  type: "ln" | "onchain" | "lnurl";
  link: string;
}

export interface PaymentRequest {
  id: string;
  type: 1;
  message?: string;
  address?: string;
  contact: OrderContact;
  items: OrderItem[];
  paymentOptions: PaymentOption[];
}

// ─── Escrow Types (Scenario 8) — BUG-03 FIXED ───────────────────────────────

export interface EscrowParams {
  amountMsats: number;
  orderId: string;
  buyerPubkey: string;
  sellerPubkey: string;
  /** Seconds the hold invoice stays valid. Default: 86400 (24h) */
  holdDuration?: number;
  /** Override deadline unix timestamp */
  deadlineAt?: number;
}

export interface EscrowSession {
  orderId: string;
  invoice: string;
  paymentHash: string;
  amountMsats: number;        // ← BUG-03 FIX: was missing, caused runtime undefined
  preimage?: string;
  status: "pending" | "funded" | "released" | "refunded" | "expired";
  escrowEventId?: string;
  createdAt: number;
  expiresAt: number;
}

// ─── Payment Types (Scenario 7) ──────────────────────────────────────────────

export interface InvoiceParams {
  amountMsats: number;
  description?: string;
  expiry?: number;
}

export interface InvoiceResult {
  invoice: string;
  paymentHash: string;
  expiresAt: number;
}

export interface PaymentResult {
  preimage: string;
  paymentHash: string;
  feeMsats?: number;
}

// ─── Review Types (Scenario 10) — BUG-08 FIXED ───────────────────────────────

export interface ReviewData {
  subject: string;
  subjectType: "pubkey" | "event";
  rating: 1 | 2 | 3 | 4 | 5;
  content: string;
  /** The Lightning payment preimage proving purchase */
  preimage: string;
  /**
   * BUG-08 FIX: paymentHash is now REQUIRED.
   * SHA256(preimage) must equal this hash, AND this hash must correspond
   * to a payment for the specific listing being reviewed.
   * Without this binding, any preimage can "verify" any review.
   */
  paymentHash: string;
  /**
   * BUG-08 FIX: listingEventId is now REQUIRED.
   * The review must reference the specific listing event it covers.
   * Clients cross-check: does paymentHash belong to a payment for this listing?
   */
  listingEventId: string;
}

// ─── Zap Types (Scenarios 13, 14) ────────────────────────────────────────────

export interface ZapRecipient {
  pubkey: string;
  weight?: number;
  relayHint?: string;
}

export interface ZapParams {
  recipients: ZapRecipient[];
  amountMsats: number;
  comment?: string;
  eventId?: string;
  relays: string[];
}

// ─── Q&A Types (Scenario 11) ─────────────────────────────────────────────────

export interface QuestionData {
  listingEventId: string;
  listingAuthorPubkey: string;
  question: string;
  relayHint?: string;
}

export interface AnswerData {
  questionEventId: string;
  questionAuthorPubkey: string;
  answer: string;
}

// ─── Report Types (Scenario 12) ──────────────────────────────────────────────

export type ReportReason =
  | "nudity"
  | "malware"
  | "profanity"
  | "illegal"
  | "spam"
  | "impersonation"
  | "scam"
  | "other";

export interface ReportData {
  reportedPubkey: string;
  reason: ReportReason;
  comment?: string;
  evidenceEventId?: string;
}

// ─── Default Relay Sets ───────────────────────────────────────────────────────

/** General-purpose relays. Used when no user relay list is available. */
export const DEFAULT_RELAYS: string[] = [
  "wss://relay.damus.io",
  "wss://relay.nostr.band",
  "wss://nos.lol",
  "wss://relay.primal.net",
  "wss://nostr.wine",
];

/** Commerce-specific relays. Higher event retention for marketplace events. */
export const COMMERCE_RELAYS: string[] = [
  "wss://relay.damus.io",
  "wss://relay.nostr.band",
  "wss://relay.primal.net",
  "wss://nos.lol",
];

/** NIP-50 search-capable relays. Required for Scenario 4 (discovery). */
export const SEARCH_RELAYS: string[] = [
  "wss://relay.nostr.band",
  "wss://relay.primal.net",
];

// ─── NIP Kind Constants — BUG-05 and BUG-06 FIXED ────────────────────────────

export const KIND = {
  // Core
  METADATA: 0,
  TEXT_NOTE: 1,
  CONTACTS: 3,
  ENCRYPTED_DM: 4,
  DELETION: 5,
  REACTION: 7,
  // Relay list (NIP-65)
  RELAY_LIST: 10002,
  // Reporting (NIP-56)
  REPORT: 1984,
  // Comments (NIP-22)
  COMMENT: 1111,
  // Zaps (NIP-57)
  ZAP_REQUEST: 9734,
  ZAP_RECEIPT: 9735,
  ZAP_GOAL: 9041,
  // Wallet Connect (NIP-47)
  WALLET_INFO: 13194,
  WALLET_REQUEST: 23194,
  WALLET_RESPONSE: 23195,
  // Encrypted messaging (NIP-59, NIP-17)
  GIFT_WRAP: 1059,
  SEAL: 13,
  PRIVATE_MESSAGE: 14,
  // Commerce listings (NIP-99)
  LISTING_ACTIVE: 30402,
  LISTING_DRAFT: 30403,
  // NIP-15 marketplace (corrected — BUG-05 FIX)
  STALL: 30017,     // was incorrectly 30019
  PRODUCT: 30018,   // was missing
  /**
   * Reviews — community convention using kind 31990.
   * BUG-06 FIX: renamed from HANDLER_INFO (NIP-89 meaning) to REVIEW.
   * Kind 31990 is officially "Handler Information" per NIP-89.
   * Its use for reviews is a Shopstr/community convention, not a finalized NIP.
   * No breakage — same number, honest name.
   */
  REVIEW: 31990,
  // Trusted assertions (NIP-85)
  TRUSTED_ASSERTION: 30382,
  // HTTP Auth (NIP-98)
  HTTP_AUTH: 27235,
  // App data (NIP-78)
  APP_DATA: 30078,
} as const;
