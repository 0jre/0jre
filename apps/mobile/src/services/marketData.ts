/**
 * Optional, read-only public quote snapshots; call only after an explicit refresh.
 * Hyperliquid's official POST /info {type: 'allMids'} returns mid prices, not
 * executable bids/offers. DexScreener's public token endpoint returns USD pair
 * prices: we select the most liquid Solana pair whose base token is wrapped SOL.
 * Sources can lag, rate-limit, or disagree; these are not execution prices,
 * trading integrations, or full GMGN support. No wallet, API key, or order is used.
 * Each source fails independently and contributes an error, never invented prices.
 */
export interface PublicQuote {
  symbol: string;
  venue: string;
  price: number;
}

export interface QuoteResult {
  quotes: PublicQuote[];
  errors: string[];
}

const HYPERLIQUID_URL = "https://api.hyperliquid.xyz/info";
const SOL_MINT = "So11111111111111111111111111111111111111112";
const DEXSCREENER_URL = `https://api.dexscreener.com/latest/dex/tokens/${SOL_MINT}`;
const TIMEOUT_MS = 10_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveNumber(value: unknown): number | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  if (typeof value === "string" && value.trim() === "") return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

async function fetchJson(
  fetcher: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetcher(url, { ...init, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function hyperliquidQuotes(
  fetcher: typeof fetch,
): Promise<PublicQuote[]> {
  const data = await fetchJson(fetcher, HYPERLIQUID_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "allMids" }),
  });
  if (!isRecord(data)) throw new Error("Malformed allMids response");
  return ["BTC", "ETH", "SOL"].map((symbol) => {
    const price = positiveNumber(data[symbol]);
    if (price === undefined)
      throw new Error(`Invalid or missing ${symbol} price`);
    return { symbol, venue: "Hyperliquid", price };
  });
}

async function solanaQuotes(fetcher: typeof fetch): Promise<PublicQuote[]> {
  const data = await fetchJson(fetcher, DEXSCREENER_URL, { method: "GET" });
  if (!isRecord(data) || !Array.isArray(data.pairs)) {
    throw new Error("Malformed token pairs response");
  }
  let best: { liquidity: number; price: number } | undefined;
  for (const pair of data.pairs) {
    if (!isRecord(pair) || pair.chainId !== "solana") continue;
    if (!isRecord(pair.baseToken) || pair.baseToken.address !== SOL_MINT)
      continue;
    if (!isRecord(pair.liquidity)) continue;
    const liquidity = positiveNumber(pair.liquidity.usd);
    const price = positiveNumber(pair.priceUsd);
    if (liquidity === undefined || price === undefined) continue;
    if (!best || liquidity > best.liquidity) best = { liquidity, price };
  }
  if (!best)
    throw new Error("No liquid Solana SOL pair with a valid USD price");
  return [{ symbol: "SOL", venue: "Solana", price: best.price }];
}

export async function fetchPublicQuotes(
  fetcher: typeof fetch = fetch,
): Promise<QuoteResult> {
  const results = await Promise.allSettled([
    hyperliquidQuotes(fetcher),
    solanaQuotes(fetcher),
  ]);
  const quotes: PublicQuote[] = [];
  const errors: string[] = [];
  const sources = ["Hyperliquid", "Solana"];
  results.forEach((result, index) => {
    if (result.status === "fulfilled") quotes.push(...result.value);
    else {
      const message =
        result.reason instanceof Error
          ? result.reason.message
          : "Request failed";
      errors.push(`${sources[index]}: ${message}`);
    }
  });
  return { quotes, errors };
}
