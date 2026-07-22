/**
 * classify.ts — Route incoming queries to the right signal-gathering path.
 *
 * Strategy: check DexScreener first (authoritative token resolution).
 * If it resolves → crypto token path. Otherwise → community/project path.
 * No LLM call needed — structured API lookups are faster and more reliable.
 */

export type TopicType = "token" | "community";

export type TokenMeta = {
  address: string;
  symbol: string;
  name: string;
  chain: string;
  priceUsd: string;
  priceChange24h: number | null;
  volume24h: number | null;
  liquidity: number | null;
  buys24h: number | null;
  sells24h: number | null;
  dexScreenerUrl: string;
};

export type ClassifyResult =
  | { type: "token"; token: TokenMeta; rawInput: string }
  | { type: "community"; rawInput: string };

/**
 * Extract a likely ticker from user input.
 * Handles: "$BNKR", "BNKR token", "bnkr", "clawd token", etc.
 */
function extractTicker(input: string): string | null {
  const trimmed = input.trim();

  // "$BNKR" style
  const cashtagMatch = trimmed.match(/^\$([A-Za-z]{2,10})$/i);
  if (cashtagMatch) return cashtagMatch[1].toUpperCase();

  // "BNKR token" / "BNKR coin" / "BNKR crypto"
  const tokenSuffixMatch = trimmed.match(/^([A-Za-z]{2,10})\s+(?:token|coin|crypto|memecoin)$/i);
  if (tokenSuffixMatch) return tokenSuffixMatch[1].toUpperCase();

  // Bare short uppercase (likely ticker if ≤6 chars, all alpha)
  if (/^[A-Za-z]{2,6}$/.test(trimmed) && trimmed === trimmed.toUpperCase()) {
    return trimmed;
  }

  // "the X token" / "X on base"
  const embeddedMatch = trimmed.match(/\$([A-Za-z]{2,10})|([A-Za-z]{2,10})\s+(?:on\s+base|token|coin)/i);
  if (embeddedMatch) return (embeddedMatch[1] || embeddedMatch[2]).toUpperCase();

  return null;
}

/**
 * Try to resolve a ticker via DexScreener. Prefer Base chain matches.
 */
async function resolveDexScreener(ticker: string): Promise<TokenMeta | null> {
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(ticker)}`);
    if (!res.ok) return null;

    const data = (await res.json()) as {
      pairs?: {
        chainId: string;
        baseToken: { address: string; symbol: string; name: string };
        priceUsd: string;
        priceChange?: { h24: number };
        volume?: { h24: number };
        liquidity?: { usd: number };
        txns?: { h24: { buys: number; sells: number } };
        url: string;
      }[];
    };

    if (!data.pairs?.length) return null;

    // Prefer Base chain, then exact symbol match on any chain
    const exact = data.pairs.filter(p => p.baseToken.symbol.toUpperCase() === ticker);
    const baseMatch = exact.find(p => p.chainId === "base");
    const match = baseMatch || exact[0];
    if (!match) return null;

    return {
      address: match.baseToken.address,
      symbol: match.baseToken.symbol,
      name: match.baseToken.name,
      chain: match.chainId,
      priceUsd: match.priceUsd,
      priceChange24h: match.priceChange?.h24 ?? null,
      volume24h: match.volume?.h24 ?? null,
      liquidity: match.liquidity?.usd ?? null,
      buys24h: match.txns?.h24.buys ?? null,
      sells24h: match.txns?.h24.sells ?? null,
      dexScreenerUrl: match.url || `https://dexscreener.com/${match.chainId}/${match.baseToken.address}`,
    };
  } catch {
    return null;
  }
}

/**
 * Classify user input. Fast path — no LLM, just structured lookups.
 */
export async function classify(input: string): Promise<ClassifyResult> {
  const ticker = extractTicker(input);

  if (ticker) {
    const token = await resolveDexScreener(ticker);
    if (token) {
      return { type: "token", token, rawInput: input };
    }
  }

  // Even if no ticker pattern matched, try the raw input against DexScreener
  // in case someone typed a token name like "dogecoin" or "clawdbot"
  const fallbackTicker = input.trim().split(/\s+/)[0];
  if (fallbackTicker.length >= 2 && fallbackTicker.length <= 12) {
    const token = await resolveDexScreener(fallbackTicker.toUpperCase());
    if (token) {
      return { type: "token", token, rawInput: input };
    }
  }

  return { type: "community", rawInput: input };
}
