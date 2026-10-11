/**
 * l402.ts - Paid APIs via L402/x402 + NIP-98 (Scenario 20)
 *
 * NIPs: NIP-98 (HTTP Auth), Kind 30078 (API endpoint announcement)
 * Lightning: Invoice per API call (L402 protocol)
 *
 * The L402 flow:
 *   1. Client makes API request
 *   2. Server returns HTTP 402 with: WWW-Authenticate: L402 macaroon="...", invoice="lnbc..."
 *   3. Client pays the invoice, receives preimage
 *   4. Client retries with: Authorization: L402 <macaroon>:<preimage>
 *   5. Server verifies the HMAC token (resource + expiry caveats), SHA256(preimage) === payment_hash, single use
 *   6. Request succeeds
 *
 * NIP-98 adds Nostr identity to HTTP requests:
 *   Authorization: Nostr <base64(JSON.stringify(signedEvent))>
 *   The signed event proves the requester is a specific pubkey.
 *
 * Combined: pay-per-call API with Nostr identity. Machine-to-machine
 * commerce. No subscription, no API key, no account creation.
 *
 * Discovery: API endpoints announced as kind 30078 events on Nostr,
 * discoverable via NIP-50 search. Any agent can find and use paid APIs.
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { decode as decodeBolt11 } from "light-bolt11-decoder";
import { finalizeEvent, verifyEvent } from "nostr-tools";
import { publishToRelays, fetchEvents } from "./relays.js";
import { NostrWalletConnect } from "./nwc.js";
import {
  type PublishResult,
  type NostrEvent,
  KIND,
  DEFAULT_RELAYS,
} from "./types.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface L402Challenge {
  macaroon: string;
  invoice: string;
  paymentHash: string;
}

export interface L402Credentials {
  macaroon: string;
  preimage: string;
}

export interface ApiEndpoint {
  /** Nostr kind 30078 dTag */
  id: string;
  name: string;
  description: string;
  url: string;
  /** Price per call in msats */
  pricePerCallMsats: number;
  /** Supported methods */
  methods: string[];
  /** OpenAPI schema URL (optional) */
  schemaUrl?: string;
  /** Publisher's pubkey */
  pubkey?: string;
}

// ─── NIP-98 HTTP Auth ─────────────────────────────────────────────────────────

/**
 * Build a NIP-98 signed authorisation event.
 * Include in request headers as: Authorization: Nostr <base64(JSON)>
 *
 * This proves the request comes from a specific Nostr pubkey.
 * Use with L402 for identity-aware paid APIs.
 */
export function buildNip98AuthHeader(
  url: string,
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH",
  privateKey: Uint8Array,
  body?: object
): string {
  const tags: string[][] = [
    ["u", url],
    ["method", method],
  ];

  // Optional: include SHA256 hash of request body
  if (body) {
    const bodyStr = JSON.stringify(body);
    tags.push(["payload", bufferToHex(sha256(bodyStr))]);
  }

  const event = finalizeEvent(
    {
      kind: KIND.HTTP_AUTH, // 27235
      created_at: Math.floor(Date.now() / 1000),
      tags,
      content: "",
    },
    privateKey
  );

  if (!verifyEvent(event)) throw new Error("NIP-98 event signature invalid.");

  return `Nostr ${btoa(JSON.stringify(event))}`;
}

function sha256(str: string): Uint8Array {
  return new Uint8Array(createHash("sha256").update(str, "utf8").digest());
}

function bufferToHex(buf: Uint8Array): string {
  return Array.from(buf).map(b => b.toString(16).padStart(2, "0")).join("");
}

// ─── L402 Client ─────────────────────────────────────────────────────────────

/**
 * Parse an L402 challenge from an HTTP 402 response.
 * Reads the WWW-Authenticate header.
 */
export function parseL402Challenge(wwwAuthenticate: string): L402Challenge {
  const macaroonMatch = wwwAuthenticate.match(/macaroon="([^"]+)"/);
  const invoiceMatch = wwwAuthenticate.match(/invoice="([^"]+)"/);

  if (!macaroonMatch?.[1] || !invoiceMatch?.[1]) {
    throw new Error(
      `Invalid L402 WWW-Authenticate header.\n` +
      `Expected: L402 macaroon="...", invoice="lnbc..."\n` +
      `Got: ${wwwAuthenticate}`
    );
  }

  const invoice = invoiceMatch[1];
  const paymentHash = extractPaymentHashFromInvoice(invoice);

  return { macaroon: macaroonMatch[1], invoice, paymentHash };
}

/**
 * Make an L402-authenticated API call.
 *
 * Automatically handles the 402 flow:
 *   1. Makes the initial request
 *   2. If 402, parses the challenge
 *   3. Pays the invoice via NWC
 *   4. Retries with L402 credentials
 *
 * @example
 *   const response = await fetchWithL402(
 *     "https://api.example.com/catalogue",
 *     { method: "GET" },
 *     wallet,
 *     userPrivkey  // for NIP-98 auth (optional)
 *   );
 */
export async function fetchWithL402(
  url: string,
  options: RequestInit,
  wallet: NostrWalletConnect,
  privateKey?: Uint8Array
): Promise<Response> {
  // Add NIP-98 auth if private key provided
  const headers = new Headers(options.headers);
  if (privateKey) {
    const method = (options.method ?? "GET").toUpperCase() as "GET" | "POST";
    headers.set("Authorization", buildNip98AuthHeader(url, method, privateKey));
  }

  // Initial request
  const initialRes = await fetch(url, { ...options, headers });

  // Not a payment required response - return as-is
  if (initialRes.status !== 402) return initialRes;

  // Parse the 402 challenge
  const wwwAuth = initialRes.headers.get("WWW-Authenticate");
  if (!wwwAuth) throw new Error("Server returned 402 but no WWW-Authenticate header.");

  const challenge = parseL402Challenge(wwwAuth);

  // Pay the invoice via NWC
  const payResult = await wallet.payInvoice(challenge.invoice);

  // Retry with L402 credentials
  const credentials: L402Credentials = {
    macaroon: challenge.macaroon,
    preimage: payResult.preimage,
  };

  const retryHeaders = new Headers(headers);
  retryHeaders.set("Authorization", `L402 ${credentials.macaroon}:${credentials.preimage}`);

  return fetch(url, { ...options, headers: retryHeaders });
}

// ─── API Endpoint Announcement ────────────────────────────────────────────────

/**
 * Announce a paid API endpoint as a kind 30078 Nostr event.
 * Discoverable via NIP-50 search - any agent can find and use it.
 *
 * @example
 *   await publishApiEndpoint(
 *     { id: "product-catalogue-v1", name: "Product Catalog API",
 *       description: "Fetch product listings with images",
 *       url: "https://api.mystore.com/catalogue",
 *       pricePerCallMsats: 1000, methods: ["GET"] },
 *     merchantPrivkey
 *   );
 */
export async function publishApiEndpoint(
  endpoint: ApiEndpoint,
  publisherPrivkey: Uint8Array,
  relays: string[] = DEFAULT_RELAYS
): Promise<PublishResult> {
  const tags: string[][] = [
    ["d", endpoint.id],
    ["name", endpoint.name],
    ["url", endpoint.url],
    ["price", String(endpoint.pricePerCallMsats), "MSATS", "call"],
    ["t", "paid-api"],
    ["t", "l402"],
  ];

  for (const method of endpoint.methods) {
    tags.push(["method", method]);
  }

  if (endpoint.schemaUrl) {
    tags.push(["schema", endpoint.schemaUrl]);
  }

  const event = finalizeEvent(
    {
      kind: KIND.APP_DATA, // kind 30078
      created_at: Math.floor(Date.now() / 1000),
      tags,
      content: JSON.stringify({
        name: endpoint.name,
        description: endpoint.description,
        url: endpoint.url,
        pricePerCallMsats: endpoint.pricePerCallMsats,
        methods: endpoint.methods,
        schemaUrl: endpoint.schemaUrl,
      }),
    },
    publisherPrivkey
  );

  if (!verifyEvent(event)) throw new Error("Invalid API endpoint event.");
  return publishToRelays(event, relays);
}

/**
 * Search for paid API endpoints via NIP-50.
 */
export async function searchApiEndpoints(
  query: string,
  relays: string[] = DEFAULT_RELAYS,
  limit = 20
): Promise<ApiEndpoint[]> {
  const events = await fetchEvents(
    [{ kinds: [KIND.APP_DATA], search: `${query} paid-api`, limit }],
    relays
  ) as NostrEvent[];

  // Filter for API endpoint announcements
  const apiEvents = events.filter(e =>
    e.tags.some(t => t[0] === "t" && t[1] === "l402") &&
    e.tags.some(t => t[0] === "url")
  );

  return apiEvents.map(parseApiEndpointEvent).filter(Boolean) as ApiEndpoint[];
}

function parseApiEndpointEvent(event: NostrEvent): ApiEndpoint | null {
  try {
    const getTag = (name: string) => event.tags.find(t => t[0] === name)?.[1];
    const content = JSON.parse(event.content);
    const priceTag = event.tags.find(t => t[0] === "price");
    const methods = event.tags.filter(t => t[0] === "method").map(t => t[1]);

    return {
      id: getTag("d") ?? event.id,
      name: getTag("name") ?? content.name ?? "",
      description: content.description ?? "",
      url: getTag("url") ?? content.url ?? "",
      pricePerCallMsats: priceTag ? Number(priceTag[1]) : 0,
      methods: methods.length > 0 ? methods : content.methods ?? ["GET"],
      schemaUrl: getTag("schema") ?? content.schemaUrl,
      pubkey: event.pubkey,
    };
  } catch { return null; }
}

// ─── Server-Side L402 Helpers ─────────────────────────────────────────────────
//
// Token format (v1, HMAC-based - not full macaroons):
//   token      = base64url(JSON(payload)) + "." + hex(HMAC-SHA256(secret, base64url(JSON(payload))))
//   payload    = { v: 1, id: { ph: <payment hash hex>, res: <resource>, exp: <unix seconds> },
//                  caveats: ["resource=<resource>", "expires=<unix seconds>"] }
//   Authorization: L402 <token>:<preimage hex>
//
// Verification: valid HMAC, caveats match the identifier, resource matches the
// request, not expired, SHA256(preimage) === payment hash, token not used before.

/** Pluggable replay-protection store. Use Redis/DB in multi-instance deployments. */
export interface UsedTokenStore {
  /** Returns true if newly recorded, false if the id was already used. */
  markUsed(tokenId: string, expiresAt: number): Promise<boolean> | boolean;
}

/** Default in-memory store. Entries are pruned after their expiry. Single-process only. */
export class InMemoryUsedTokenStore implements UsedTokenStore {
  private used = new Map<string, number>();
  markUsed(tokenId: string, expiresAt: number): boolean {
    const now = Math.floor(Date.now() / 1000);
    for (const [k, exp] of this.used) if (exp < now) this.used.delete(k);
    if (this.used.has(tokenId)) return false;
    this.used.set(tokenId, expiresAt);
    return true;
  }
}

const defaultUsedTokenStore = new InMemoryUsedTokenStore();

export interface L402TokenPayload {
  v: 1;
  id: { ph: string; res: string; exp: number };
  caveats: string[];
}

function resolveSecret(secret?: string): string {
  const s = secret ?? process.env.L402_SECRET;
  if (!s || s.length < 32) {
    throw new Error("L402 secret missing or too short. Set L402_SECRET (>= 32 chars) or pass `secret`.");
  }
  return s;
}

function b64url(str: string): string {
  return Buffer.from(str, "utf8").toString("base64url");
}

function hmacHex(secret: string, data: string): string {
  return createHmac("sha256", secret).update(data).digest("hex");
}

/** Mint an HMAC-signed L402 token bound to a payment hash, resource and expiry. */
export function mintL402Token(params: {
  paymentHash: string;
  resource: string;
  expiresAt: number;
  secret?: string;
}): string {
  if (!/^[0-9a-f]{64}$/i.test(params.paymentHash)) throw new Error("paymentHash must be 64 hex chars.");
  const payload: L402TokenPayload = {
    v: 1,
    id: { ph: params.paymentHash.toLowerCase(), res: params.resource, exp: params.expiresAt },
    caveats: [`resource=${params.resource}`, `expires=${params.expiresAt}`],
  };
  const body = b64url(JSON.stringify(payload));
  return `${body}.${hmacHex(resolveSecret(params.secret), body)}`;
}

/** Decode and authenticate a token. Returns the payload or null (bad format/signature). */
export function decodeL402Token(token: string, secret?: string): L402TokenPayload | null {
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const [body, sig] = parts;
  const expected = Buffer.from(hmacHex(resolveSecret(secret), body), "hex");
  const given = Buffer.from(sig, "hex");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as L402TokenPayload;
    if (p.v !== 1 || !p.id || typeof p.id.ph !== "string" || typeof p.id.exp !== "number") return null;
    return p;
  } catch { return null; }
}

/**
 * Generate an L402 challenge for your server to return on HTTP 402.
 *
 * @example (Express.js middleware)
 *   app.use("/api/paid-endpoint", async (req, res, next) => {
 *     const auth = req.headers.authorization;
 *     if (auth?.startsWith("L402") && await verifyL402Credentials(auth, { resource: "/api/paid-endpoint" })) return next();
 *     const { challenge } = await createL402Challenge(wallet, 1000, "API call", { resource: "/api/paid-endpoint" });
 *     res.set("WWW-Authenticate", challenge).status(402).end();
 *   });
 */
export async function createL402Challenge(
  wallet: NostrWalletConnect,
  pricePerCallMsats: number,
  description: string,
  options: { resource: string; ttlSeconds?: number; secret?: string } = { resource: "*" }
): Promise<{ challenge: string; paymentHash: string; token: string; expiresAt: number }> {
  const ttl = options.ttlSeconds ?? 300;
  const invoice = await wallet.createInvoice({
    amountMsats: pricePerCallMsats,
    description,
    expiry: ttl,
  });
  const expiresAt = Math.floor(Date.now() / 1000) + ttl;
  const token = mintL402Token({
    paymentHash: invoice.paymentHash,
    resource: options.resource,
    expiresAt,
    secret: options.secret,
  });
  const challenge = `L402 macaroon="${token}", invoice="${invoice.invoice}"`;
  return { challenge, paymentHash: invoice.paymentHash, token, expiresAt };
}

export interface VerifyL402Options {
  /** Resource being accessed; must equal the token's resource caveat (or token resource "*"). */
  resource: string;
  /** Server secret; defaults to process.env.L402_SECRET. */
  secret?: string;
  /** Replay store; defaults to a process-wide in-memory store. */
  usedTokenStore?: UsedTokenStore;
  /** Override "now" (unix seconds) for testing. */
  now?: number;
}

/**
 * Verify an L402 Authorization header offline (no wallet lookup needed):
 * HMAC, caveats, expiry, SHA256(preimage) === payment hash, single use.
 */
export async function verifyL402Credentials(
  authorizationHeader: string,
  options: VerifyL402Options
): Promise<boolean> {
  if (!authorizationHeader || !authorizationHeader.startsWith("L402 ")) return false;
  if (!options || typeof options.resource !== "string") return false;
  const credentials = authorizationHeader.slice(5).trim().split(":");
  if (credentials.length !== 2) return false;
  const [token, preimage] = credentials;
  if (!token || !preimage || !/^[0-9a-f]{64}$/i.test(preimage)) return false;

  const payload = decodeL402Token(token, options.secret);
  if (!payload) return false;

  const { ph, res, exp } = payload.id;
  // Every caveat must be satisfied and consistent with the signed identifier.
  for (const c of payload.caveats ?? []) {
    const [k, v] = c.split("=", 2);
    if (k === "resource") { if (v !== res) return false; }
    else if (k === "expires") { if (Number(v) !== exp) return false; }
    else return false; // unknown caveat - fail closed
  }
  if (res !== "*" && res !== options.resource) return false;
  const now = options.now ?? Math.floor(Date.now() / 1000);
  if (now > exp) return false;

  const digest = createHash("sha256").update(Buffer.from(preimage, "hex")).digest("hex");
  if (digest !== ph) return false;

  const store = options.usedTokenStore ?? defaultUsedTokenStore;
  return await store.markUsed(ph, exp);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Extract the payment hash from a BOLT-11 invoice by decoding its tagged fields
 * (light-bolt11-decoder; does not verify the invoice signature).
 * Throws if the invoice cannot be decoded or has no payment hash.
 */
export function extractPaymentHashFromInvoice(invoice: string): string {
  let decoded: ReturnType<typeof decodeBolt11>;
  try {
    decoded = decodeBolt11(invoice);
  } catch (e) {
    throw new Error(`Invalid BOLT-11 invoice: ${(e as Error).message}`);
  }
  const section = decoded.sections.find((s) => s.name === "payment_hash") as { value?: string } | undefined;
  if (!section?.value || !/^[0-9a-f]{64}$/i.test(section.value)) {
    throw new Error("BOLT-11 invoice has no valid payment_hash.");
  }
  return section.value.toLowerCase();
}
