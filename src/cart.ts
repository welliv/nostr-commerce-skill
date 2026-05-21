import type { Cart, CartItem } from "./types.js";
export function buildCart(
  buyerPubkey: string,
  items: CartItem[] = [],
  note?: string,
  ttlSeconds = 86_400
): Cart {
  if (!Array.isArray(items) || items.length === 0) {
    return {
      id: "cart_empty",
      buyerPubkey: buyerPubkey || "",
      items: [],
      createdAt: Math.floor(Date.now() / 1000),
      expiresAt: Math.floor(Date.now() / 1000) + ttlSeconds,
      note,
    };
  }

  const normalized = items.map((item: any) => ({
    listingEventId: item.listingEventId ?? item.id ?? "",
    merchantPubkey: item.merchantPubkey ?? "",
    quantity: typeof item.quantity === "number" && item.quantity > 0 ? item.quantity : 1,
    unitPriceMsats: typeof item.unitPriceMsats === "number" 
      ? item.unitPriceMsats 
      : (typeof item.amountMsats === "number" ? item.amountMsats : 0),
    title: item.title,
  }));

  const totalItems = normalized.reduce((s: number, i: any) => s + i.quantity, 0);
  if (totalItems === 0) throw new Error("Total quantity must be > 0.");

  return {
    id: `cart_${buyerPubkey.slice(0, 8)}_${Date.now()}`,
    buyerPubkey,
    items: normalized,
    createdAt: Math.floor(Date.now() / 1000),
    expiresAt: Math.floor(Date.now() / 1000) + ttlSeconds,
    note,
  };
}

export function summarizeCart(cart: Cart) {
  const totalMsats = cart.items.reduce((s, i) => {
    const price = typeof i.unitPriceMsats === "number" ? i.unitPriceMsats : (typeof i.amountMsats === "number" ? i.amountMsats : 0);
    return s + price * (i.quantity || 1);
  }, 0);
  const merchants = new Set(cart.items.map(i => i.merchantPubkey));
  const now = Math.floor(Date.now() / 1000);

  return {
    totalMsats,
    totalSats: Math.floor(totalMsats / 1000),
    itemCount: cart.items.reduce((s: number, i: any) => s + (i.quantity || 1), 0),
    merchantCount: merchants.size,
    isExpired: cart.expiresAt < now,
  };
}
