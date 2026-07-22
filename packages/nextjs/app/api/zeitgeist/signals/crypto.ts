/**
 * signals/crypto.ts — Signal gathering for crypto tokens.
 *
 * Sources (in order of priority):
 * 1. DexScreener — price, volume, holder behavior (already resolved in classify step)
 * 2. LunarCrush — social volume + sentiment score
 * 3. Farcaster via Neynar — what people are actually saying onchain-native social
 */

import type { TokenMeta } from "../classify";
import type { Signal } from "../types";

type CryptoSignalResult = {
  signals: Signal[];
  lowConfidence: boolean;
};

/** Format DexScreener data (already fetched during classify) into signals. */
function dexScreenerSignals(token: TokenMeta): Signal[] {
  const out: Signal[] = [];

  const price = parseFloat(token.priceUsd || "0");
  const priceStr = price < 0.01 ? price.toFixed(8) : price.toFixed(4);

  out.push({
    text: `${token.name} (${token.symbol}) on ${token.chain.toUpperCase()} — $${priceStr}, 24h: ${token.priceChange24h?.toFixed(1) ?? "N/A"}%, Vol: $${((token.volume24h || 0) / 1e3).toFixed(1)}K, Liq: $${((token.liquidity || 0) / 1e3).toFixed(1)}K`,
    url: token.dexScreenerUrl,
    source: "dexscreener",
  });

  if (token.buys24h !== null && token.sells24h !== null) {
    const { buys24h: buys, sells24h: sells } = token;
    const ratio = buys / Math.max(sells, 1);
    const behavior = ratio > 1.3 ? "accumulating" : ratio < 0.7 ? "distributing" : "mixed";
    out.push({
      text: `24h txns: ${buys} buys / ${sells} sells — holders appear to be ${behavior} (ratio: ${ratio.toFixed(2)})`,
      url: token.dexScreenerUrl,
      source: "onchain",
    });
  }

  return out;
}

/** Fetch social sentiment from LunarCrush. */
async function lunarCrushSignals(symbol: string, apiKey: string): Promise<Signal[]> {
  try {
    const res = await fetch(`https://lunarcrush.com/api4/public/coins/${symbol.toLowerCase()}/v1`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) return [];

    const d = (await res.json()) as {
      data?: {
        name: string;
        social_volume: number;
        social_volume_change: number;
        sentiment: number;
        galaxy_score: number;
        alt_rank: number;
      };
    };

    if (!d.data) return [];
    const c = d.data;

    return [
      {
        text: `Social volume: ${c.social_volume?.toLocaleString() ?? "N/A"} (${c.social_volume_change > 0 ? "+" : ""}${c.social_volume_change?.toFixed(0) ?? "N/A"}% change), sentiment: ${c.sentiment?.toFixed(1) ?? "N/A"}/5, galaxy score: ${c.galaxy_score ?? "N/A"}`,
        url: `https://lunarcrush.com/coins/${symbol.toLowerCase()}`,
        source: "lunarcrush",
      },
    ];
  } catch {
    return [];
  }
}

/** Fetch recent Farcaster casts about the token via Neynar. */
async function farcasterSignals(query: string, apiKey: string): Promise<Signal[]> {
  try {
    const res = await fetch(
      `https://api.neynar.com/v2/farcaster/cast/search?q=${encodeURIComponent(query)}&limit=10`,
      { headers: { api_key: apiKey, Accept: "application/json" } },
    );
    if (!res.ok) return [];

    const d = (await res.json()) as {
      result?: {
        casts?: {
          text: string;
          author: { username: string };
          hash: string;
          reactions: { likes_count: number; recasts_count: number };
        }[];
      };
    };

    const casts = d.result?.casts ?? [];

    return casts
      .filter(c => (c.text?.length ?? 0) > 20)
      .slice(0, 6)
      .map(c => ({
        text: `@${c.author?.username}: "${c.text?.slice(0, 200)}" [${c.reactions?.likes_count ?? 0} likes]`,
        url: `https://warpcast.com/${c.author?.username}/${c.hash?.slice(0, 10)}`,
        source: "farcaster" as const,
      }));
  } catch {
    return [];
  }
}

/**
 * Gather all crypto signals for a resolved token.
 */
export async function gatherCryptoSignals(token: TokenMeta): Promise<CryptoSignalResult> {
  const signals: Signal[] = [];

  // DexScreener data (already have it, no API call)
  signals.push(...dexScreenerSignals(token));

  // Parallel fetch: LunarCrush + Farcaster
  const lunarKey = process.env.LUNARCRUSH_API_KEY;
  const neynarKey = process.env.NEYNAR_API_KEY;

  const [lunarResults, farcasterResults] = await Promise.allSettled([
    lunarKey ? lunarCrushSignals(token.symbol, lunarKey) : Promise.resolve([]),
    neynarKey ? farcasterSignals(`$${token.symbol}`, neynarKey) : Promise.resolve([]),
  ]);

  if (lunarResults.status === "fulfilled") signals.push(...lunarResults.value);
  if (farcasterResults.status === "fulfilled") signals.push(...farcasterResults.value);

  return {
    signals,
    lowConfidence: signals.length < 3,
  };
}
