/**
 * index.ts - Nostr Commerce Skill: Public API
 *
 * Single entry point. All exports are explicitly listed - no barrel wildcards
 * that accidentally export internal utilities.
 *
 * Import only what you need. Everything is tree-shakeable.
 *
 * QUICK REFERENCE:
 *
 * Identity & Onboarding (Scenarios 1, 5):
 *   import { generateIdentity, signWithNip07, verifyIdentity } from 'nostr-commerce-skill'
 *
 * Secure Key Storage (BLIND-03 fix):
 *   import { saveIdentityEncrypted, loadIdentityDecrypted } from 'nostr-commerce-skill'
 *
 * Relay Discovery / NIP-65 (BLIND-01 fix):
 *   import { fetchUserRelays, getRelaysForUser } from 'nostr-commerce-skill'
 *
 * Listings (Scenarios 2, 3, 4, 19):
 *   import { signAndPublishListing, searchListings, parseListing } from 'nostr-commerce-skill'
 *
 * Payments / NWC (Scenario 7):
 *   import { createWalletFromEnv } from 'nostr-commerce-skill'
 *
 * Encrypted Orders (Scenario 6):
 *   import { sendEncryptedOrder, decryptIncomingOrder } from 'nostr-commerce-skill'
 *
 * Escrow (Scenario 8):
 *   import { createEscrow, waitForPayment, releaseEscrow, LndEscrowBackend } from 'nostr-commerce-skill'
 *
 * Reviews (Scenario 10):
 *   import { publishReview, fetchVerifiedReviews } from 'nostr-commerce-skill'
 *
 * Q&A (Scenario 11):
 *   import { postQuestion, postAnswer, fetchQAThread } from 'nostr-commerce-skill'
 *
 * Reports (Scenario 12):
 *   import { publishReport, assessPubkeyTrust } from 'nostr-commerce-skill'
 *
 * Zaps & Prisms (Scenarios 13, 14):
 *   import { requestZapInvoice, buildPrism, fetchZapReceipts } from 'nostr-commerce-skill'
 */

// ─── Types (Single Source) ────────────────────────────────────────────────────
// NOTE: EscrowParams and EscrowSession are exported ONLY from types.ts.
// They were previously re-exported from escrow.ts causing duplicate export errors.

export type {
  NostrEvent,
  EventTemplate,
  RelayResult,
  PublishResult,
  NostrIdentity,
  VerificationResult,
  RelayConfig,
  UserRelays,
  ListingData,
  ListingPrice,
  ListingType,
  ListingFrequency,
  ListingCurrency,
  OrderData,
  OrderContact,
  OrderItem,
  PaymentRequest,
  PaymentOption,
  EscrowParams,
  EscrowSession,
  InvoiceParams,
  InvoiceResult,
  PaymentResult,
  ReviewData,
  ZapParams,
  ZapRecipient,
  QuestionData,
  AnswerData,
  ReportData,
  ReportReason,
} from "./types.js";


export * from "./platform-fees.js";
export * from "./zapvertising.js";
export * from "./notifications.js";
export * from "./disputes.js";
export * from "./l402.js";

// Explicit re-exports for critical V2 functions (ensures they are always available)






export {
  buildCart,
  summarizeCart,
} from "./cart.js";

export {
  buildListingTemplate,
  parseListing,
} from "./listing.js";
