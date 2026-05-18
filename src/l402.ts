/**
 * l402.ts — Paid APIs via L402/x402 + NIP-98 (Scenario 20)
 *
 * NIPs: NIP-98 (HTTP Auth), Kind 30078 (API endpoint announcement)
 * Lightning: Invoice per API call (L402 protocol)
 *
 * The L402 flow:
 *   1. Client makes API request
 *   2. Server returns HTTP 402 with: WWW-Authenticate: L402 macaroon="...", invoice="lnbc..."
 *   3. Client pays the invoice, receives preimage
 *   4. Client retries with: Authorization: L402 <macaroon>:<preimage>
 *   5. Server verifies SHA256(preimage) === payment_hash in macaroon
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
 * Build a NIP-98 signed authorization event.
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
  // Simple polyfill — use crypto.subtle in practice
  const encoder = new TextEncoder();
  return encoder.encode(str); // placeholder — real impl uses SubtleCrypto
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
 *     "https://api.example.com/catalog",
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

  // Not a payment required response — return as-is
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
 * Discoverable via NIP-50 search — any agent can find and use it.
 *
 * @example
 *   await publishApiEndpoint(
 *     { id: "product-catalog-v1", name: "Product Catalog API",
 *       description: "Fetch product listings with images",
 *       url: "https://api.mystore.com/catalog",
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

/**
 * Generate an L402 challenge for your server to return on HTTP 402.
 * Pair with a NWC invoice creation.
 *
 * @example (Express.js middleware)
 *   app.use("/api/paid-endpoint", async (req, res, next) => {
 *     const authHeader = req.headers.authorization;
 *     if (authHeader?.startsWith("L402")) {
 *       const valid = await verifyL402Credentials(authHeader, wallet);
 *       if (valid) return next();
 *     }
 *     const { challenge, invoice } = await createL402Challenge(wallet, 1000, "API call");
 *     res.set("WWW-Authenticate", challenge).status(402).end();
 *   });
 */
export async function createL402Challenge(
  wallet: NostrWalletConnect,
  pricePerCallMsats: number,
  description: string
): Promise<{ challenge: string; paymentHash: string }> {
  const invoice = await wallet.createInvoice({
    amountMsats: pricePerCallMsats,
    description,
    expiry: 300, // 5 min — API calls should be quick
  });

  // The "macaroon" in simple L402 is just the payment hash
  // Full macaroon support requires a macaroon library
  const macaroon = invoice.paymentHash;
  const challenge = `L402 macaroon="${macaroon}", invoice="${invoice.invoice}"`;

  return { challenge, paymentHash: invoice.paymentHash };
}

/**
 * Verify an L402 Authorization header.
 * Returns true if SHA256(preimage) matches the payment hash.
 */
export async function verifyL402Credentials(
  authorizationHeader: string,
  wallet: NostrWalletConnect
): Promise<boolean> {
  if (!authorizationHeader.startsWith("L402 ")) return false;

  const credentials = authorizationHeader.slice(5).split(":");
  if (credentials.length !== 2) return false;

  const [macaroon, preimage] = credentials;
  if (!macaroon || !preimage) return false;

  // macaroon = payment_hash, preimage is the revealed secret
  const lookup = await wallet.lookupInvoice(macaroon);
  return lookup.paid && lookup.preimage === preimage;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractPaymentHashFromInvoice(invoice: string): string {
  // BOLT-11 contains the payment hash — for display purposes, return a placeholder
  // Real extraction requires a bolt11 parsing library
  return invoice.slice(-64); // last 64 chars often contain hash info
}
