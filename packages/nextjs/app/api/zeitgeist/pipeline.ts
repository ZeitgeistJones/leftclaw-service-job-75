import { createPublicClient, decodeEventLog, http, parseAbi } from "viem";
import { base } from "viem/chains";
import { kv } from "@vercel/kv";

// ------------------------------------------------------------------
// Types
// ------------------------------------------------------------------
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

// ------------------------------------------------------------------
// Constants
// ------------------------------------------------------------------
const ZEITGEIST_PAYMENT_ADDRESS = "0x45fAeA3de5f9B6D4758EA1907eDc6B127E26081F" as const;
const QUERY_PAID_ABI = parseAbi([
  "event QueryPaid(address indexed user, string groupName, uint256 amount, bool isClawd)",
]);
const CACHE_TTL_SECONDS = 60 * 60 * 24;
const RATE_LIMIT_WINDOW = 60;
const RATE_LIMIT_MAX = 5;

function cacheKey(txHash: string, groupName: string, mode: string): string {
  return `zg:${txHash.toLowerCase()}:${groupName.toLowerCase().trim()}:${mode}`;
}

async function checkRateLimit(ip: string): Promise<boolean> {
  const key = `ratelimit:${ip}`;
  const count = await kv.incr(key);
  if (count === 1) await kv.expire(key, RATE_LIMIT_WINDOW);
  return count <= RATE_LIMIT_MAX;
}

// ------------------------------------------------------------------
// Payment Verification (original working approach)
// ------------------------------------------------------------------
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

  const client = createPublicClient({ chain: base, transport: http(rpcUrl) });
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

// ------------------------------------------------------------------
// Signal Gathering (all sources in parallel)
// ------------------------------------------------------------------
type Snippet = { text: string; url: string; source: string };

async function gatherSignals(groupName: string, apiKey: string): Promise<{ snippets: Snippet[]; lowConfidence: boolean }> {
  const snippets: Snippet[] = [];

  // Generate targeted queries via GPT
  let braveQueries = [groupName, `${groupName} news 2026`, `${groupName} controversy`];
  let redditQuery = groupName;
  let farcasterQuery = groupName;
  let youtubeQuery = groupName;

  try {
    const qRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [{
          role: "system",
          content: `Generate targeted search queries for current discourse about a topic. Return JSON: { "braveQueries": ["q1","q2","q3","q4"], "redditQuery": "q", "farcasterQuery": "q", "youtubeQuery": "q" }`
        }, {
          role: "user",
          content: `Topic: "${groupName}". Focus on current discourse, reactions, controversy, what people are saying RIGHT NOW in 2026.`
        }],
        response_format: { type: "json_object" },
        temperature: 0.5,
      }),
    });
    if (qRes.ok) {
      const qData = await qRes.json() as { choices: { message: { content: string } }[] };
      const q = JSON.parse(qData.choices[0].message.content);
      if (q.braveQueries) braveQueries = q.braveQueries;
      if (q.redditQuery) redditQuery = q.redditQuery;
      if (q.farcasterQuery) farcasterQuery = q.farcasterQuery;
      if (q.youtubeQuery) youtubeQuery = q.youtubeQuery;
    }
  } catch { /* use defaults */ }

  // Fetch all sources in parallel
  const braveKey = process.env.BRAVE_SEARCH_API_KEY;
  const neynarKey = process.env.NEYNAR_API_KEY;
  const ytKey = process.env.YOUTUBE_API_KEY;
  const cmcKey = process.env.COINMARKETCAP_API_KEY;
  const lunarKey = process.env.LUNARCRUSH_API_KEY;

  await Promise.allSettled([
    // 1. Brave Web Search
    (async () => {
      if (!braveKey) return;
      for (const q of braveQueries.slice(0, 2)) {
        try {
          const r = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=3&freshness=pd`, {
            headers: { "Accept": "application/json", "X-Subscription-Token": braveKey },
          });
          if (!r.ok) continue;
          const d = await r.json() as { web?: { results?: { title: string; description: string; url: string }[] } };
          for (const item of (d.web?.results ?? []).slice(0, 3)) {
            snippets.push({ text: `[WEB] ${item.title}: ${item.description?.slice(0, 200) ?? ""}`, url: item.url, source: "web" });
          }
        } catch { /* continue */ }
      }
    })(),

    // 2. Reddit
    (async () => {
      try {
        const r = await fetch(`https://www.reddit.com/search.json?q=${encodeURIComponent(redditQuery)}&sort=new&limit=8&t=week`, {
          headers: { "User-Agent": "VibeCheck/1.0" },
        });
        if (!r.ok) return;
        const d = await r.json() as { data?: { children?: { data: { title: string; selftext: string; url: string; subreddit: string } }[] } };
        for (const c of (d.data?.children ?? []).slice(0, 6)) {
          const p = c.data;
          snippets.push({ text: `[REDDIT r/${p.subreddit}] ${p.title}: ${p.selftext?.slice(0, 150) ?? ""}`, url: p.url, source: "reddit" });
        }
      } catch { /* continue */ }
    })(),

    // 3. Farcaster via Neynar
    (async () => {
      if (!neynarKey) return;
      try {
        const r = await fetch(`https://api.neynar.com/v2/farcaster/cast/search?q=${encodeURIComponent(farcasterQuery)}&limit=8`, {
          headers: { "api_key": neynarKey, "Accept": "application/json" },
        });
        if (!r.ok) return;
        const d = await r.json() as { result?: { casts?: { text: string; author: { username: string }; hash: string }[] } };
        for (const cast of (d.result?.casts ?? []).slice(0, 6)) {
          if ((cast.text ?? "").length > 10) {
            snippets.push({ text: `[FARCASTER @${cast.author?.username}]: "${cast.text?.slice(0, 200)}"`, url: `https://warpcast.com/${cast.author?.username}`, source: "farcaster" });
          }
        }
      } catch { /* continue */ }
    })(),

    // 4. YouTube
    (async () => {
      if (!ytKey) return;
      try {
        const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
        const r = await fetch(`https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(youtubeQuery)}&type=video&order=date&maxResults=5&publishedAfter=${since}&key=${ytKey}`);
        if (!r.ok) return;
        const d = await r.json() as { items?: { snippet: { title: string; description: string; channelTitle: string }; id: { videoId: string } }[] };
        for (const item of (d.items ?? []).slice(0, 4)) {
          const s = item.snippet;
          snippets.push({ text: `[YOUTUBE - ${s.channelTitle}] ${s.title}: ${s.description?.slice(0, 100) ?? ""}`, url: `https://youtube.com/watch?v=${item.id?.videoId}`, source: "youtube" });
        }
      } catch { /* continue */ }
    })(),

    // 5. CoinGecko (free, no key)
    (async () => {
      try {
        const r = await fetch(`https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(groupName)}`);
        if (!r.ok) return;
        const d = await r.json() as { coins?: { name: string; symbol: string; market_cap_rank: number }[] };
        for (const c of (d.coins ?? []).slice(0, 3)) {
          snippets.push({ text: `[COINGECKO] ${c.name} (${c.symbol}) market cap rank: ${c.market_cap_rank ?? "unranked"}`, url: `https://coingecko.com`, source: "crypto" });
        }
      } catch { /* continue */ }
    })(),

    // 6. CoinMarketCap trending
    (async () => {
      if (!cmcKey) return;
      try {
        const r = await fetch(`https://pro-api.coinmarketcap.com/v1/cryptocurrency/trending/latest?limit=5`, {
          headers: { "X-CMC_PRO_API_KEY": cmcKey, "Accept": "application/json" },
        });
        if (!r.ok) return;
        const d = await r.json() as { data?: { name: string; symbol: string }[] };
        const trending = (d.data ?? []).map(c => c.name).join(", ");
        if (trending) snippets.push({ text: `[COINMARKETCAP] Currently trending: ${trending}`, url: "https://coinmarketcap.com", source: "crypto" });
      } catch { /* continue */ }
    })(),

    // 7. LunarCrush social sentiment
    (async () => {
      if (!lunarKey) return;
      try {
        const r = await fetch(`https://lunarcrush.com/api/4/public/coins/search?q=${encodeURIComponent(groupName)}`, {
          headers: { "Authorization": `Bearer ${lunarKey}` },
        });
        if (!r.ok) return;
        const d = await r.json() as { data?: { name: string; social_volume: number; sentiment: number }[] };
        for (const c of (d.data ?? []).slice(0, 2)) {
          snippets.push({ text: `[LUNARCRUSH] ${c.name} social volume: ${c.social_volume}, sentiment: ${c.sentiment}`, url: "https://lunarcrush.com", source: "social" });
        }
      } catch { /* continue */ }
    })(),

    // 8. DeFiLlama TVL
    (async () => {
      try {
        const r = await fetch(`https://api.llama.fi/protocols`);
        if (!r.ok) return;
        const d = await r.json() as { name: string; tvl: number; change_1d: number }[];
        const match = d.find((p: any) => p.name?.toLowerCase().includes(groupName.toLowerCase()));
        if (match) snippets.push({ text: `[DEFILLAMA] ${match.name} TVL: $${(match.tvl / 1e6).toFixed(1)}M, 24h change: ${match.change_1d?.toFixed(1)}%`, url: "https://defillama.com", source: "onchain" });
      } catch { /* continue */ }
    })(),
  ]);

  const seen = new Set<string>();
  const unique = snippets.filter(s => {
    const k = s.text.slice(0, 80);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  return { snippets: unique.slice(0, 30), lowConfidence: unique.length < 3 };
}

// ------------------------------------------------------------------
// Synthesis (mode-aware)
// ------------------------------------------------------------------
async function synthesize(
  groupName: string,
  snippets: Snippet[],
  lowConfidence: boolean,
  apiKey: string,
  mode: string,
): Promise<{ moodHeadline: string; signals: string[]; tldr: string; analysis: string; imagePrompt: string }> {
  const confidenceCaveat = lowConfidence
    ? "NOTE: Very few results found. Be honest — say the data is thin rather than generating plausible-sounding generic content."
    : "";

  const snippetText = snippets.map(s => `[${s.source.toUpperCase()} | ${s.url}] ${s.text}`).join("\n");

  let systemPrompt = "";
  let imageInstruction = "";

  if (mode === "technical") {
    systemPrompt = `You are a professional market intelligence analyst. Analyze the provided data streams for the target topic.

ANTI-HALLUCINATION RULE: Only use information actually present in the snippets.
FOCUS RULE: Every signal must be SPECIFICALLY about "${groupName}".

Rules:
- moodHeadline: 3-6 word clinical assessment of current market/social state
- signals: exactly 5 precise, data-forward observations. Include specific metrics where available. No jargon-free language — this is for analysts.
- tldr: exactly 2 sentences. Tight, professional executive summary. No humor.
- analysis: 3-4 paragraphs of structured analytical commentary.
- imagePrompt: Clean data visualization aesthetic for "${groupName}". Abstract, minimal, professional.

Output valid JSON only. ${confidenceCaveat}`;
    imageInstruction = `Clean data visualization aesthetic. Abstract geometric shapes, minimal, professional. Dark background, icy blue accents. No text, no words.`;
  } else if (mode === "basic") {
    systemPrompt = `You are a friendly explainer helping regular people understand what's happening right now with a topic.

ANTI-HALLUCINATION RULE: Only use information actually present in the snippets.
FOCUS RULE: Every signal must be SPECIFICALLY about "${groupName}".

Rules:
- moodHeadline: 3-6 words describing the current mood in plain English
- signals: exactly 5 clear, jargon-free observations that anyone can understand. Write like you're texting a friend.
- tldr: exactly 2 sentences. Simple, clear, no crypto/finance jargon.
- analysis: 3-4 paragraphs in plain English. Explain context where needed.
- imagePrompt: Friendly, clear illustration for "${groupName}". Simple, approachable.

Output valid JSON only. ${confidenceCaveat}`;
    imageInstruction = `Friendly, clean illustration. Simple vector art style. Bright, approachable. Dark background, bright blue accents. No text, no words.`;
  } else {
    // MEME mode — the original unhinged default
    systemPrompt = `You are a deeply online cultural analyst with terminal brainrot. Your job is to capture THE VIBE RIGHT NOW — what people are CURRENTLY saying, feeling, arguing about, and posting.

ANTI-HALLUCINATION RULE: Only use information actually present in the snippets. If data is thin, be honest about it with humor.
FOCUS RULE: Every signal must be SPECIFICALLY about "${groupName}". Discard adjacent topics.

Rules:
- moodHeadline: punchy, specific, slightly unhinged — captures the current emotional temperature. Should feel like a shitpost diagnosis.
- signals: exactly 5 items. Write each as a clean, punchy statement — no source labels, no URLs. At least one should include a direct quote formatted naturally as: '"[quote]" — someone on [platform]'. Keep it readable but weird.
- tldr: exactly 2 sentences. Both FUNNY — dry wit, absurdist, or brutally honest. No corporate-speak.
- analysis: 3-4 paragraphs of chaotic but insightful cultural commentary. If data is thin, be funny about it.
- imagePrompt: IMPORTANT — the image must be recognizably about "${groupName}". Start with the specific subject as an anchor, then add surreal/absurdist internet-brain elements. The viewer should immediately know what the image is about even though it's chaotic and funny. No text in image.

Output valid JSON only. ${confidenceCaveat}`;
    imageInstruction = `Chaotic internet meme aesthetic. Surreal, absurdist, highly symbolic. No text, no words, no letters anywhere in the image.`;
  }

  const userPrompt = `Group/Topic: "${groupName}"

Current signals (past 24-48 hours):
${snippetText}

Return JSON:
{
  "moodHeadline": "...",
  "signals": ["signal 1", "signal 2", "signal 3", "signal 4", "signal 5"],
  "tldr": "Sentence 1. Sentence 2.",
  "analysis": "paragraphs...",
  "imagePrompt": "${groupName} themed scene: [describe visual elements]"
}`;

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }],
      response_format: { type: "json_object" },
      temperature: mode === "meme" ? 0.9 : mode === "basic" ? 0.7 : 0.5,
      max_tokens: 2000,
    }),
  });

  if (!res.ok) throw new Error(`OpenAI synthesis failed: ${res.status}`);
  const data = await res.json() as { choices: { message: { content: string } }[] };
  const parsed = JSON.parse(data.choices[0].message.content);
  parsed.imagePrompt = `${parsed.imagePrompt || `${groupName} themed scene`}. ${imageInstruction}`;
  return parsed;
}

// ------------------------------------------------------------------
// Image Generation (original working approach — b64_json)
// ------------------------------------------------------------------
async function generateImage(prompt: string, apiKey: string): Promise<string> {
  const res = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: "gpt-image-1",
      prompt: `${prompt}. No text, no words, no letters anywhere in the image.`,
      n: 1,
      size: "1024x1024",
      quality: "low",
      output_format: "png",
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error(`Image generation failed: ${res.status} ${err}`);
    return "";
  }

  const data = await res.json() as { data: { b64_json?: string; url?: string }[] };
  const img = data.data?.[0];
  if (!img) return "";
  if (img.b64_json) return `data:image/png;base64,${img.b64_json}`;
  if (img.url) return img.url;
  return "";
}

// ------------------------------------------------------------------
// Main Export
// ------------------------------------------------------------------
export async function runZeitgeistPipeline(
  txHash: `0x${string}`,
  groupName: string,
  ipOrMode: string,
  mode?: string,
): Promise<ZeitgeistResult | ZeitgeistError> {
  // Support both old signature (ip) and new signature (mode)
  const resolvedMode = mode || (["meme", "basic", "technical"].includes(ipOrMode) ? ipOrMode : "meme");
  const ip = ["meme", "basic", "technical"].includes(ipOrMode) ? "unknown" : ipOrMode;

  const key = cacheKey(txHash, groupName, resolvedMode);
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
  const synthesis = await synthesize(groupName, snippets, lowConfidence, apiKey, resolvedMode);
  const imageUrl = await generateImage(synthesis.imagePrompt, apiKey);

  const result: ZeitgeistResult = {
    groupName,
    imageUrl,
    moodHeadline: synthesis.moodHeadline,
    signals: synthesis.signals,
    tldr: synthesis.tldr,
    analysis: synthesis.analysis || "",
    generatedAt: Math.floor(Date.now() / 1000),
    txHash,
    isClawdPayment: verification.isClawd,
    lowConfidence,
    cached: false,
  };

  await kv.set(key, result, { ex: CACHE_TTL_SECONDS });
  return result;
}
