import { createPublicClient, decodeEventLog, http, parseAbi } from "viem";
import { base } from "viem/chains";
import { kv } from "@vercel/kv";

export type ZeitgeistResult = {
  groupName: string;
  imageUrl: string;
  moodHeadline: string;
  signals: string[];
  tldr: string;
  analysis: string;
  generatedAt: number;
  txHash: `0x${string}`;
  isClawdPayment: boolean;
  lowConfidence: boolean;
  cached: boolean;
};

export type ZeitgeistError = {
  error: string;
  setupRequired?: boolean;
  retryAfterMs?: number;
};

const ZEITGEIST_PAYMENT_ADDRESS = "0x45fAeA3de5f9B6D4758EA1907eDc6B127E26081F" as const;
const QUERY_PAID_ABI = parseAbi([
  "event QueryPaid(address indexed user, string groupName, uint256 amount, bool isClawd)",
]);
const CACHE_TTL_SECONDS = 60 * 60 * 24;
const RATE_LIMIT_WINDOW = 60;
const RATE_LIMIT_MAX = 5;

function cacheKey(txHash: string, groupName: string): string {
  return `zg:${txHash.toLowerCase()}:${groupName.toLowerCase().trim()}`;
}

async function checkRateLimit(ip: string): Promise<boolean> {
  const key = `ratelimit:${ip}`;
  const count = await kv.incr(key);
  if (count === 1) await kv.expire(key, RATE_LIMIT_WINDOW);
  return count <= RATE_LIMIT_MAX;
}

async function verifyQueryPaid(
  txHash: `0x${string}`,
  expectedGroupName: string,
): Promise<{ isClawd: boolean } | null> {
  const alchemyKey = process.env.ALCHEMY_API_KEY;
  const rpcUrl = alchemyKey
    ? `https://base-mainnet.g.alchemy.com/v2/${alchemyKey}`
    : "https://mainnet.base.org";

  const usedKey = `used_tx:${txHash.toLowerCase()}`;
  const alreadyUsed = await kv.get(usedKey);
  if (alreadyUsed) return null;

  const client = createPublicClient({
    chain: base,
    transport: http(rpcUrl),
  });

  const receipt = await client.getTransactionReceipt({ hash: txHash });
  if (!receipt || receipt.status !== "success") return null;

  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== ZEITGEIST_PAYMENT_ADDRESS.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({ abi: QUERY_PAID_ABI, data: log.data, topics: log.topics });
      if (decoded.eventName !== "QueryPaid") continue;
      const onChainGroup = (decoded.args.groupName as string).trim().toLowerCase();
      if (onChainGroup !== expectedGroupName.trim().toLowerCase()) continue;
      await kv.set(usedKey, 1, { ex: 48 * 60 * 60 });
      return { isClawd: decoded.args.isClawd as boolean };
    } catch {
      // not a matching log
    }
  }
  return null;
}

async function generateSearchQueries(groupName: string, apiKey: string): Promise<{
  braveQueries: string[];
  redditQuery: string;
  farcasterQuery: string;
}> {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `You generate hyper-targeted search queries to capture the CURRENT MOMENT of discourse around a specific topic, person, or group.

CRITICAL RULES:
- Queries must target CURRENT discourse and reactions, not background info or history
- braveQueries: 4 web search queries — mix of news, fan reactions, and controversy. Include "today" or "2026" where appropriate.
- redditQuery: 1 Reddit search query — short, direct, what someone would type in Reddit search to find current threads about this topic
- farcasterQuery: 1 Farcaster/crypto social query — if the topic is crypto/web3/tech, make it specific to that community's language; otherwise use the topic name directly
- All queries must be laser-focused on EXACTLY the topic asked, not the broader category
- Avoid queries that return Wikipedia-style summaries

Return JSON with: { "braveQueries": ["q1","q2","q3","q4"], "redditQuery": "q", "farcasterQuery": "q" }. JSON only.`,
        },
        {
          role: "user",
          content: `Generate targeted queries for: "${groupName}"`,
        },
      ],
      response_format: { type: "json_object" },
      temperature: 0.3,
      max_tokens: 500,
    }),
  });

  if (!res.ok) throw new Error(`Query generation failed: ${res.status}`);
  const data = (await res.json()) as { choices: { message: { content: string } }[] };
  const parsed = JSON.parse(data.choices[0].message.content) as {
    braveQueries: string[];
    redditQuery: string;
    farcasterQuery: string;
  };
  return {
    braveQueries: (parsed.braveQueries ?? []).slice(0, 4),
    redditQuery: parsed.redditQuery ?? groupName,
    farcasterQuery: parsed.farcasterQuery ?? groupName,
  };
}

type Snippet = { text: string; url: string; source: string };

async function gatherSignals(groupName: string, apiKey: string): Promise<{ snippets: Snippet[]; lowConfidence: boolean }> {
  const braveKey = process.env.BRAVE_SEARCH_API_KEY;
  if (!braveKey) throw new Error("BRAVE_SEARCH_API_KEY not configured");

  const { braveQueries, redditQuery, farcasterQuery } = await generateSearchQueries(groupName, apiKey);

  const snippets: Snippet[] = [];

  // 1. Brave News search (freshest breaking content)
  for (const query of braveQueries.slice(0, 2)) {
    const url = `https://api.search.brave.com/res/v1/news/search?q=${encodeURIComponent(query)}&count=10&freshness=pd`;
    const res = await fetch(url, {
      headers: { Accept: "application/json", "Accept-Encoding": "gzip", "X-Subscription-Token": braveKey },
    });
    if (!res.ok) continue;
    const data = (await res.json()) as { results?: { title: string; description: string; url: string }[] };
    for (const r of (data.results ?? [])) {
      snippets.push({ text: `${r.title}: ${r.description}`, url: r.url, source: "news" });
    }
  }

  // 2. Brave Web search (broader web, past day then week fallback)
  for (const query of braveQueries) {
    let fetchUrl = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=10&freshness=pd`;
    let res = await fetch(fetchUrl, {
      headers: { Accept: "application/json", "Accept-Encoding": "gzip", "X-Subscription-Token": braveKey },
    });
    if (res.ok) {
      const data = (await res.json()) as { web?: { results?: { title: string; description: string; url: string }[] } };
      const results = data?.web?.results ?? [];
      if (results.length === 0) {
        fetchUrl = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=10&freshness=pw`;
        res = await fetch(fetchUrl, {
          headers: { Accept: "application/json", "Accept-Encoding": "gzip", "X-Subscription-Token": braveKey },
        });
      } else {
        for (const r of results) {
          snippets.push({ text: `${r.title}: ${r.description}`, url: r.url, source: "web" });
        }
        continue;
      }
    }
    if (!res.ok) continue;
    const data = (await res.json()) as { web?: { results?: { title: string; description: string; url: string }[] } };
    for (const r of (data?.web?.results ?? [])) {
      snippets.push({ text: `${r.title}: ${r.description}`, url: r.url, source: "web" });
    }
  }

  // 3. Reddit search (real-time community discourse, no API key needed)
  try {
    const redditUrl = `https://www.reddit.com/search.json?q=${encodeURIComponent(redditQuery)}&sort=new&limit=10&t=week`;
    const redditRes = await fetch(redditUrl, {
      headers: { "User-Agent": "zeitgeist-app/1.0" },
    });
    if (redditRes.ok) {
      const redditData = (await redditRes.json()) as {
        data?: { children?: { data: { title: string; selftext: string; url: string; subreddit: string } }[] };
      };
      for (const post of (redditData.data?.children ?? []).slice(0, 8)) {
        const d = post.data;
        const preview = d.selftext ? d.selftext.slice(0, 150) : "";
        snippets.push({
          text: `[Reddit r/${d.subreddit}] ${d.title}${preview ? `: "${preview}"` : ""}`,
          url: d.url,
          source: "reddit",
        });
      }
    }
  } catch {
    // Reddit fetch failed, continue without it
  }

  // 4. Farcaster search via Searchcaster (crypto-native discourse)
  try {
    const fcUrl = `https://searchcaster.xyz/api/search?text=${encodeURIComponent(farcasterQuery)}&count=8`;
    const fcRes = await fetch(fcUrl, {
      headers: { "User-Agent": "zeitgeist-app/1.0" },
    });
    if (fcRes.ok) {
      const fcData = (await fcRes.json()) as {
        casts?: { body: { data: { text: string }; username: string }; merkleRoot: string }[];
      };
      for (const cast of (fcData.casts ?? []).slice(0, 6)) {
        const text = cast.body?.data?.text ?? "";
        const user = cast.body?.username ?? "unknown";
        if (text.length > 10) {
          snippets.push({
            text: `[Farcaster @${user}]: "${text.slice(0, 200)}"`,
            url: `https://warpcast.com/${user}`,
            source: "farcaster",
          });
        }
      }
    }
  } catch {
    // Farcaster fetch failed, continue without it
  }

  // Deduplicate and limit
  const seen = new Set<string>();
  const unique = snippets.filter(s => {
    const key = s.text.slice(0, 80);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return { snippets: unique.slice(0, 25), lowConfidence: unique.length < 3 };
}

async function synthesize(
  groupName: string,
  snippets: Snippet[],
  lowConfidence: boolean,
  apiKey: string,
): Promise<{ moodHeadline: string; signals: string[]; tldr: string; analysis: string; imagePrompt: string }> {
  const confidenceCaveat = lowConfidence
    ? "NOTE: Very few results found. Be honest — say the data is thin rather than generating plausible-sounding generic content."
    : "";

  const snippetText = snippets.map(s => `[${s.source.toUpperCase()} | ${s.url}] ${s.text}`).join("\n");

  const systemPrompt = `You are a deeply online cultural analyst capturing THE VIBE RIGHT NOW. Your job is to capture what people are CURRENTLY saying, feeling, and arguing about — not historical summaries.

ANTI-HALLUCINATION RULE: Only use information actually present in the snippets. If the snippets contain no information specifically about the queried group, say so honestly with humor — e.g. "The internet has nothing to say about this yet, which is itself a vibe."

FOCUS RULE: Every signal must be SPECIFICALLY about "${groupName}". Discard anything about adjacent topics.

SOURCE TYPES in snippets: NEWS = breaking articles, WEB = general web, REDDIT = community posts, FARCASTER = crypto social posts. Prioritize REDDIT and FARCASTER sources for quotes as they contain actual human voices.

Rules:
- moodHeadline: punchy, specific, slightly unhinged — captures the current emotional temperature
- signals: exactly 5 items. Each must be a specific CURRENT thing from the snippets. At least ONE signal must be a direct quote from a REDDIT or FARCASTER source, formatted as: '"[exact quote]" — @username on [platform] ([URL])'. If no quotes available, note it honestly.
- tldr: exactly 2 sentences. Both FUNNY — dry wit, absurdist, or brutally honest. No corporate-speak.
- analysis: 3-4 paragraphs on the current discourse and vibe. If data is thin, be honest and funny about it.
- imagePrompt: surreal, absurdist, internet-brain visual — chaotic collage, wojak vibes. No text, no words in the image.

Output valid JSON only. No markdown fences. ${confidenceCaveat}`;

  const userPrompt = `Group/Topic: "${groupName}"

Current signals (past 24-48 hours) with sources:
${snippetText}

Return JSON:
{
  "moodHeadline": "current vibe right now",
  "signals": ["signal 1", "signal 2", "signal 3", "signal 4", "\\"direct quote\\" — @user on Reddit/Farcaster (https://url)"],
  "tldr": "Funny sentence 1. Funny sentence 2.",
  "analysis": "3-4 paragraphs on the current discourse",
  "imagePrompt": "surreal absurdist scene, no text"
}`;

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }],
      response_format: { type: "json_object" },
      temperature: 0.9,
      max_tokens: 2000,
    }),
  });

  if (!res.ok) throw new Error(`OpenAI synthesis failed: ${res.status}`);
  const data = (await res.json()) as { choices: { message: { content: string } }[] };
  return JSON.parse(data.choices[0].message.content);
}

async function generateImage(prompt: string, apiKey: string): Promise<string> {
  const res = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: "gpt-image-1",
      prompt: `${prompt}. No text, no words, no letters anywhere in the image. Chaotic internet meme aesthetic.`,
      n: 1,
      size: "1024x1024",
      quality: "low",
      output_format: "png",
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Image generation failed: ${res.status} ${err}`);
  }

  const data = (await res.json()) as { data: { b64_json?: string; url?: string }[] };
  const img = data.data?.[0];
  if (!img) throw new Error("Image generation returned no image");
  if (img.b64_json) return `data:image/png;base64,${img.b64_json}`;
  if (img.url) return img.url;
  throw new Error("Image generation returned no usable image data");
}

export async function runZeitgeistPipeline(
  txHash: `0x${string}`,
  groupName: string,
  ip: string,
): Promise<ZeitgeistResult | ZeitgeistError> {
  const key = cacheKey(txHash, groupName);

  const cached = await kv.get<ZeitgeistResult>(key);
  if (cached) return { ...cached, cached: true };

  const allowed = await checkRateLimit(ip);
  if (!allowed) {
    return { error: "Rate limit exceeded. Try again in a minute.", retryAfterMs: 60000 };
  }

  const verification = await verifyQueryPaid(txHash, groupName);
  if (!verification) {
    return { error: "Could not verify a QueryPaid event for this txHash + groupName on Base mainnet." };
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not configured");

  const { snippets, lowConfidence } = await gatherSignals(groupName, apiKey);
  const synthesis = await synthesize(groupName, snippets, lowConfidence, apiKey);
  const imageUrl = await generateImage(synthesis.imagePrompt, apiKey);

  const result: ZeitgeistResult = {
    groupName,
    imageUrl,
    moodHeadline: synthesis.moodHeadline,
    signals: synthesis.signals,
    tldr: synthesis.tldr,
    analysis: synthesis.analysis,
    generatedAt: Math.floor(Date.now() / 1000),
    txHash,
    isClawdPayment: verification.isClawd,
    lowConfidence,
    cached: false,
  };

  await kv.set(key, result, { ex: CACHE_TTL_SECONDS });
  return result;
}
