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

export {
  KIND,
  DEFAULT_RELAYS,
  COMMERCE_RELAYS,
  SEARCH_RELAYS,
} from "./types.js";

// ─── Relay Utilities ──────────────────────────────────────────────────────────

export {
  getPool,
  closePool,
  publishToRelays,
  fetchEvents,
  fetchEventById,
  fetchEventsByAuthor,
  fetchLatestEvent,
  isRelayReachable,
  filterReachableRelays,
} from "./relays.js";

// ─── Identity (Scenarios 1, 5) ────────────────────────────────────────────────

export {
  generateIdentity,
  identityFromPrivateKey,
  nsecToPrivateKey,
  privateKeyToNsec,
  signEvent,
  hasNip07Signer,
  getNip07Pubkey,
  signWithNip07,
  verifyNip05,
  verifyIdentity,
  buildProfileEvent,
  encodeListingAddress,
} from "./identity.js";

export type { ProfileData } from "./identity.js";

// ─── Secure Key Storage (BLIND-03 Fix) ───────────────────────────────────────

export {
  saveIdentityEncrypted,
  loadIdentityDecrypted,
  saveIdentityToLocalStorage,
  loadIdentityFromLocalStorage,
  hasStoredIdentity,
  clearStoredIdentity,
  saveIdentityToFile,
  loadIdentityFromFile,
} from "./storage.js";

export type { EncryptedIdentity } from "./storage.js";

// ─── Relay Discovery / NIP-65 (BLIND-01 Fix) ─────────────────────────────────

export {
  fetchUserRelays,
  buildRelaySetForUsers,
  getRelaysForUser,
  getRelaysFromUser,
  buildRelayListEvent,
} from "./relay-discovery.js";

export type { RelayPreference } from "./relay-discovery.js";

// ─── NWC Wallet (Scenario 7) ──────────────────────────────────────────────────

export {
  NostrWalletConnect,
  createWalletFromEnv,
} from "./nwc.js";

// ─── Listings (Scenarios 2, 3, 4, 19) ────────────────────────────────────────

export {
  buildListingTemplate,
  signAndPublishListing,
  getListingShareableLink,
  deleteListing,
  fetchMerchantListings,
  searchListings,
  parseListing,
  filterActiveListings,
} from "./listing.js";

export type { ParsedListing } from "./listing.js";

// ─── Encrypted Orders (Scenario 6) ───────────────────────────────────────────

export {
  unwrapGiftWrap,
  sendEncryptedOrder,
  sendPaymentRequest,
  decryptIncomingOrder,
  decryptPaymentRequest,
} from "./orders.js";

// ─── Escrow (Scenario 8) ──────────────────────────────────────────────────────

export {
  // Backend implementations
  LndEscrowBackend,
  AlbyHubEscrowBackend,
  // Session management
  storeEscrowSession,
  getEscrowSession,
  getAllEscrowSessions,
  // Core escrow flow
  createEscrow,
  publishEscrowEvent,
  waitForPayment,
  releaseEscrow,
  refundEscrow,
  fetchBuyerEscrowEvents,
  describeEscrow,
} from "./escrow.js";

export type {
  EscrowBackend,
  LndConfig,
  AlbyHubConfig,
} from "./escrow.js";

// ─── Reviews (Scenario 10) ────────────────────────────────────────────────────

export {
  verifyPreimage,
  publishReview,
  fetchReviews,
  parseReview,
  fetchVerifiedReviews,
  summarizeRatings,
} from "./reviews.js";

export type { ParsedReview, RatingSummary } from "./reviews.js";

// ─── Zaps & Prisms (Scenarios 13, 14) ────────────────────────────────────────

export {
  resolveLnurlFromProfile,
  fetchLnurlMetadata,
  buildZapRequest,
  requestZapInvoice,
  fetchZapReceipts,
  parseZapReceipt,
  summarizeZaps,
  buildPrism,
} from "./zaps.js";

export type { ParsedZap, ZapSummary } from "./zaps.js";

// ─── Product Q&A (Scenario 11) ────────────────────────────────────────────────

export {
  postQuestion,
  postAnswer,
  fetchQAThread,
  fetchMerchantQuestions,
  parseQAThread,
  buildQAThreads,
} from "./qa.js";

export type { ParsedQAEntry, QAThread } from "./qa.js";

// ─── Reports (Scenario 12) ────────────────────────────────────────────────────

export {
  publishReport,
  fetchReportsForPubkey,
  fetchReportsByReporter,
  parseReport,
  assessPubkeyTrust,
} from "./reports.js";

export type { ParsedReport, TrustAssessment } from "./reports.js";

// ─── V2 Modules (Scenarios 15–22 + NWCEscrowBackend) ───────────────────────
export * from "./fiat.js";
export * from "./subscriptions.js";
export * from "./cart.js";
export * from "./platform-fees.js";
export * from "./zapvertising.js";
export * from "./notifications.js";
export * from "./disputes.js";
export * from "./l402.js";

// NWCEscrowBackend (V2 improvement to Scenario 8)
export { NWCEscrowBackend, createEscrowWithNWC } from "./escrow.js";
