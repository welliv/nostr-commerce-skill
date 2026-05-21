/**
 * fiat.ts - Fiat Conversion for Listings (Scenario 19)
 *
 * NIPs: Kind 30402 with ["price", amount, currency] tags
 * Lightning: Client-side sats ↔ fiat conversion
 *
 * The merchant thinks in dollars. The buyer compares in dollars.
 * The listing stores the price in fiat. The client converts at display time.
 * The protocol doesn't care - it's a frontend concern, not a NIP concern.
 *
 * This unlocks non-Bitcoin native merchants. A candle maker can list
 * at $25 and never know what a satoshi is. The conversion is transparent,
 * client controlled, and uses no platform controlled exchange rate.
 *
 * Uses @getalby/lightning-tools for conversion - their library calls
 * the Alby API which aggregates multiple exchange rate sources.
 *
 * IMPORTANT: Exchange rates change. Always fetch fresh rates before
 * displaying to users or creating invoices. Never cache longer than 5 minutes.
 */


// ─── Types ────────────────────────────────────────────────────────────────────

export type FiatCurrency = "USD" | "EUR" | "GBP" | "JPY" | "AUD" | "CAD" | "CHF" | string;

export interface ConversionResult {
  amountMsats: number;
  amountSats: number;
  fiatAmount: number;
  fiatCurrency: FiatCurrency;
  rate: number;         // sats per 1 fiat unit
  fetchedAt: number;    // unix timestamp - refresh if > 5 min old
}

// ─── Rate Cache (5 minute TTL) ────────────────────────────────────────────────

const _rateCache = new Map<FiatCurrency, { rate: number; fetchedAt: number }>();
const RATE_TTL_SECONDS = 300; // 5 minutes

function getCachedRate(currency: FiatCurrency): number | null {
  const cached = _rateCache.get(currency);
  if (!cached) return null;
  const age = Math.floor(Date.now() / 1000) - cached.fetchedAt;
  if (age > RATE_TTL_SECONDS) return null;
  return cached.rate;
}

// ─── Fetch Rate ────────────────────────────────────────────────────────────────

/**
 * Fetch the current BTC price in a fiat currency.
 * Returns sats per 1 fiat unit.
 *
 * Uses @getalby/lightning-tools which aggregates exchange rate sources.
 * Caches results for 5 minutes to avoid excessive API calls.
 *
 * @example
 *   const rate = await fetchBtcRate("USD");
 *   // rate = 3500 means 1 USD = 3500 sats
 */
export async function fetchBtcRate(currency: FiatCurrency): Promise<number> {
  const cached = getCachedRate(currency);
  if (cached !== null) return cached;

  // @getalby/lightning-tools: LightningAddress.fetchBTCValue returns sats per unit
  // We use the static method if available, or fetch from their API
  try {
    const response = await fetch(
      `https://api.getalby.com/rates?fiat=${currency.toLowerCase()}`,
      { signal: AbortSignal.timeout(5_000) }
    );
    if (!response.ok) throw new Error(`Rate API error: ${response.status}`);
    const data = await response.json();
    // API returns { btcusd: 95000, btceur: 88000, ... }
    const key = `btc${currency.toLowerCase()}`;
    const btcPrice = data[key]; // BTC price in fiat
    if (!btcPrice) throw new Error(`Rate not found for ${currency}`);
    const satsPerFiat = Math.floor(100_000_000 / btcPrice); // sats per 1 fiat unit

    _rateCache.set(currency, { rate: satsPerFiat, fetchedAt: Math.floor(Date.now() / 1000) });
    return satsPerFiat;
  } catch {
    // Fallback: use lightning-tools LightningAddress for conversion
    throw new Error(
      `Could not fetch BTC rate for ${currency}.\n` +
      "Check network connectivity or try a different currency."
    );
  }
}

// ─── Convert Fiat → Msats ──────────────────────────────────────────────────────

/**
 * Convert a fiat amount to millisatoshis.
 * Use this when creating invoices from fiat-priced listings.
 *
 * @example
 *   const result = await fiatToMsats(25, "USD");
 *   // result.amountMsats = 87500000 (assuming 3500 sats/USD)
 *   await wallet.createInvoice({ amountMsats: result.amountMsats });
 */
export async function fiatToMsats(
  fiatAmount: number,
  currency: FiatCurrency
): Promise<ConversionResult> {
  const rate = await fetchBtcRate(currency);
  const amountSats = Math.round(fiatAmount * rate);
  const amountMsats = amountSats * 1000;

  return {
    amountMsats,
    amountSats,
    fiatAmount,
    fiatCurrency: currency,
    rate,
    fetchedAt: Math.floor(Date.now() / 1000),
  };
}

// ─── Convert Msats → Fiat ─────────────────────────────────────────────────────

/**
 * Convert millisatoshis to a fiat display amount.
 * Use this for displaying sats prices in fiat for non-Bitcoin users.
 *
 * @example
 *   const result = await msatsToFiat(87500000, "USD");
 *   console.log(`Price: $${result.fiatAmount.toFixed(2)}`); // "$25.00"
 */
export async function msatsToFiat(
  amountMsats: number,
  currency: FiatCurrency
): Promise<ConversionResult> {
  const rate = await fetchBtcRate(currency);
  const amountSats = amountMsats / 1000;
  const fiatAmount = amountSats / rate;

  return {
    amountMsats,
    amountSats,
    fiatAmount: Math.round(fiatAmount * 100) / 100, // round to 2 decimal places
    fiatCurrency: currency,
    rate,
    fetchedAt: Math.floor(Date.now() / 1000),
  };
}

// ─── Parse Fiat Price Tag ─────────────────────────────────────────────────────

export interface FiatPriceTag {
  amount: string;
  currency: FiatCurrency;
  frequency?: string;
  amountMsats?: number;   // set after conversion
}

/**
 * Parse a listing's price tag and optionally convert to msats.
 *
 * @example
 *   const listing = parseListing(event);
 *   const price = await parseFiatPriceTag(listing.price, true);
 *   // { amount: "25.00", currency: "USD", amountMsats: 87500000 }
 */
export async function parseFiatPriceTag(
  price: { amount: string; currency: string; frequency?: string } | undefined,
  convertToMsats = false
): Promise<FiatPriceTag | null> {
  if (!price) return null;

  const tag: FiatPriceTag = {
    amount: price.amount,
    currency: price.currency as FiatCurrency,
    frequency: price.frequency,
  };

  if (convertToMsats) {
    if (price.currency === "SATS") {
      tag.amountMsats = Number(price.amount) * 1000;
    } else if (price.currency === "BTC") {
      tag.amountMsats = Math.floor(Number(price.amount) * 100_000_000_000); // BTC to msats
    } else {
      const conversion = await fiatToMsats(Number(price.amount), price.currency);
      tag.amountMsats = conversion.amountMsats;
    }
  }

  return tag;
}

// ─── Format for Display ───────────────────────────────────────────────────────

/**
 * Format a price for display. Shows both fiat and sats for maximum clarity.
 *
 * @example
 *   formatPrice({ amount: "25.00", currency: "USD", amountMsats: 87500000 })
 *   // "$25.00 (87,500 sats)"
 */
export function formatPrice(price: FiatPriceTag): string {
  const currencySymbols: Record<string, string> = {
    USD: "$", EUR: "€", GBP: "£", JPY: "¥", AUD: "A$", CAD: "C$", CHF: "Fr",
  };
  const symbol = currencySymbols[price.currency] ?? price.currency + " ";

  if (price.currency === "SATS") {
    const sats = parseInt(price.amount).toLocaleString();
    return `${sats} sats${price.frequency ? `/${price.frequency}` : ""}`;
  }

  const fiatDisplay = `${symbol}${Number(price.amount).toFixed(2)}`;
  const satsDisplay = price.amountMsats
    ? ` (${Math.floor(price.amountMsats / 1000).toLocaleString()} sats)`
    : "";
  const freqDisplay = price.frequency ? `/${price.frequency}` : "";

  return `${fiatDisplay}${freqDisplay}${satsDisplay}`;
}

// ─── Stale Rate Warning ───────────────────────────────────────────────────────

/** Check if a cached conversion result is stale and needs refresh. */
export function isRateStale(result: ConversionResult): boolean {
  const age = Math.floor(Date.now() / 1000) - result.fetchedAt;
  return age > RATE_TTL_SECONDS;
}
