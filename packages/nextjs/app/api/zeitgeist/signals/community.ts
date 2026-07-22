/**
 * signals/community.ts — Signal gathering for non-token topics.
 *
 * For queries like "farcaster maxis", "Base builders", "crypto degens".
 *
 * Sources:
 * 1. Exa (semantic search — understands intent, not just keywords)
 * 2. Farcaster via Neynar
 * 3. Reddit
 *
 * Falls back to Brave Search if Exa key isn't configured.
 */

import type { Signal } from "../types";

type CommunitySignalResult = {
  signals: Signal[];
  lowConfidence: boolean;
};

/** Exa semantic search — much better than keyword search for fuzzy cultural topics. */
async function exaSignals(query: string, apiKey: string): Promise<Signal[]> {
  try {
    const res = await fetch("https://api.exa.ai/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
      },
      body: JSON.stringify({
        query: `Current discourse and opinions about: ${query}`,
        type: "neural",
        useAutoprompt: true,
        numResults: 6,
        startPublishedDate: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
        contents: { text: { maxCharacters: 300 } },
      }),
    });
    if (!res.ok) return [];

    const d = (await res.json()) as {
      results?: { title: string; text: string; url: string }[];
    };

    return (d.results ?? []).map(r => ({
      text: `${r.title}: ${r.text?.slice(0, 200) ?? ""}`,
      url: r.url,
      source: "web" as const,
    }));
  } catch {
    return [];
  }
}

/** Brave Search fallback if Exa isn't configured. */
async function braveSignals(query: string, apiKey: string): Promise<Signal[]> {
  try {
    const res = await fetch(
      `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5&freshness=pw`,
      {
        headers: {
          Accept: "application/json",
          "X-Subscription-Token": apiKey,
        },
      },
    );
    if (!res.ok) return [];

    const d = (await res.json()) as {
      web?: { results?: { title: string; description: string; url: string }[] };
    };

    return (d.web?.results ?? []).slice(0, 5).map(r => ({
      text: `${r.title}: ${r.description?.slice(0, 200) ?? ""}`,
      url: r.url,
      source: "web" as const,
    }));
  } catch {
    return [];
  }
}

/** Reddit search. */
async function redditSignals(query: string): Promise<Signal[]> {
  try {
    const res = await fetch(
      `https://www.reddit.com/search.json?q=${encodeURIComponent(query)}&sort=new&limit=6&t=week`,
      { headers: { "User-Agent": "VibeCheck/2.0" } },
    );
    if (!res.ok) return [];

    const d = (await res.json()) as {
      data?: {
        children?: {
          data: {
            title: string;
            selftext: string;
            url: string;
            subreddit: string;
            score: number;
          };
        }[];
      };
    };

    return (d.data?.children ?? [])
      .filter(c => c.data.score > 1)
      .slice(0, 5)
      .map(c => ({
        text: `r/${c.data.subreddit} (${c.data.score} pts): ${c.data.title}${c.data.selftext ? ` — ${c.data.selftext.slice(0, 100)}` : ""}`,
        url: c.data.url,
        source: "reddit" as const,
      }));
  } catch {
    return [];
  }
}

/** Farcaster via Neynar. */
async function farcasterSignals(query: string, apiKey: string): Promise<Signal[]> {
  try {
    const res = await fetch(
      `https://api.neynar.com/v2/farcaster/cast/search?q=${encodeURIComponent(query)}&limit=8`,
      { headers: { api_key: apiKey, Accept: "application/json" } },
    );
    if (!res.ok) return [];

    const d = (await res.json()) as {
      result?: {
        casts?: {
          text: string;
          author: { username: string };
          hash: string;
          reactions: { likes_count: number };
        }[];
      };
    };

    return (d.result?.casts ?? [])
      .filter(c => (c.text?.length ?? 0) > 20)
      .slice(0, 5)
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
 * Gather signals for a community/project topic.
 */
export async function gatherCommunitySignals(query: string): Promise<CommunitySignalResult> {
  const exaKey = process.env.EXA_API_KEY;
  const braveKey = process.env.BRAVE_SEARCH_API_KEY;
  const neynarKey = process.env.NEYNAR_API_KEY;

  const [webResults, fcResults, redditResults] = await Promise.allSettled([
    exaKey ? exaSignals(query, exaKey) : braveKey ? braveSignals(query, braveKey) : Promise.resolve([]),
    neynarKey ? farcasterSignals(query, neynarKey) : Promise.resolve([]),
    redditSignals(query),
  ]);

  const signals: Signal[] = [];
  if (webResults.status === "fulfilled") signals.push(...webResults.value);
  if (fcResults.status === "fulfilled") signals.push(...fcResults.value);
  if (redditResults.status === "fulfilled") signals.push(...redditResults.value);

  return {
    signals,
    lowConfidence: signals.length < 3,
  };
}
