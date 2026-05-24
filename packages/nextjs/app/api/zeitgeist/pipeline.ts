import { kv } from "@vercel/kv";
import { createPublicClient, http, parseAbiItem } from "viem";
import { base } from "viem/chains";

// ------------------------------------------------------------------
// Types
// ------------------------------------------------------------------
export type ZeitgeistResult = {
  groupName: string;
  imageUrl: string;
  moodHeadline: string;
  signals: string[];
  tldr: string;
  generatedAt: number;
  txHash: `0x${string}`;
  isClawdPayment: boolean;
  lowConfidence: boolean;
  cached: boolean;
};

// ------------------------------------------------------------------
// Config & Constants
// ------------------------------------------------------------------
const CACHE_TTL_SECONDS = 60 * 60 * 24; // 24 hours
const PAYMENT_CONTRACT = process.env.NEXT_PUBLIC_ZEITGEIST_CONTRACT_ADDRESS as `0x${string}`;

const alchemyKey = process.env.ALCHEMY_API_KEY || process.env.NEXT_PUBLIC_ALCHEMY_API_KEY;
const rpcUrl = alchemyKey
  ? `https://base-mainnet.g.alchemy.com/v2/${alchemyKey}`
  : "https://mainnet.base.org";

const publicClient = createPublicClient({
  chain: base,
  transport: http(rpcUrl),
});

// ------------------------------------------------------------------
// Data Fetchers (Parallelized)
// ------------------------------------------------------------------

async function fetchReddit(groupName: string) {
  try {
    const res = await fetch(`https://www.reddit.com/search.json?q=${encodeURIComponent(groupName)}&sort=new&limit=5`, {
      headers: { "User-Agent": "VibeCheck/1.0" },
    });
    if (!res.ok) return "";
    const data = await res.json();
    const posts = data.data?.children?.map((c: any) => c.data.title).join(" | ") || "";
    return posts ? `Reddit: ${posts}` : "";
  } catch {
    return "";
  }
}

async function fetchBrave(groupName: string, apiKey: string) {
  if (!apiKey) return "";
  try {
    const res = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(groupName)}&count=3&freshness=pd`, {
      headers: { "Accept": "application/json", "X-Subscription-Token": apiKey },
    });
    if (!res.ok) return "";
    const data = await res.json();
    const results = data.web?.results?.map((r: any) => r.description).join(" | ") || "";
    return results ? `Web: ${results}` : "";
  } catch {
    return "";
  }
}

async function fetchYouTube(groupName: string, apiKey: string) {
  if (!apiKey) return "";
  try {
    const res = await fetch(`https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(groupName)}&order=date&maxResults=3&key=${apiKey}`);
    if (!res.ok) return "";
    const data = await res.json();
    const results = data.items?.map((i: any) => i.snippet.title).join(" | ") || "";
    return results ? `YouTube: ${results}` : "";
  } catch {
    return "";
  }
}

async function fetchNeynar(groupName: string, apiKey: string) {
  if (!apiKey) return "";
  try {
    const res = await fetch(`https://api.neynar.com/v2/farcaster/cast/search?q=${encodeURIComponent(groupName)}&limit=5`, {
      headers: { "api_key": apiKey, "Accept": "application/json" },
    });
    if (!res.ok) return "";
    const data = await res.json();
    const casts = data.result?.casts?.map((c: any) => c.text).join(" | ") || "";
    return casts ? `Farcaster: ${casts}` : "";
  } catch {
    return "";
  }
}

async function fetchCoinGecko(groupName: string) {
  try {
    const res = await fetch(`https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(groupName)}`);
    if (!res.ok) return "";
    const data = await res.json();
    const coins = data.coins?.slice(0, 3).map((c: any) => `${c.name} (${c.symbol}) rank ${c.market_cap_rank}`).join(", ") || "";
    return coins ? `CoinGecko Trending: ${coins}` : "";
  } catch {
    return "";
  }
}

async function fetchCoinMarketCap(apiKey: string) {
  if (!apiKey) return "";
  try {
    const res = await fetch(`https://pro-api.coinmarketcap.com/v1/cryptocurrency/trending/latest?limit=3`, {
      headers: { "X-CMC_PRO_API_KEY": apiKey, "Accept": "application/json" },
    });
    if (!res.ok) return "";
    const data = await res.json();
    const trends = data.data?.map((c: any) => c.name).join(", ") || "";
    return trends ? `CMC Market Trends: ${trends}` : "";
  } catch {
    return "";
  }
}

async function fetchLunarCrush(groupName: string, apiKey: string) {
  if (!apiKey) return "";
  try {
    const res = await fetch(`https://lunarcrush.com/api/4/public/coins/search?q=${encodeURIComponent(groupName)}`, {
      headers: { "Authorization": `Bearer ${apiKey}` },
    });
    if (!res.ok) return "";
    const data = await res.json();
    const sentiment = data.data?.slice(0, 2).map((c: any) => `${c.name} social volume: ${c.social_volume}`).join(" | ") || "";
    return sentiment ? `LunarCrush Social: ${sentiment}` : "";
  } catch {
    return "";
  }
}

async function fetchStockTwits(groupName: string) {
  try {
    const res = await fetch(`https://api.stocktwits.com/api/2/search/symbols.json?q=${encodeURIComponent(groupName)}`);
    if (!res.ok) return "";
    const data = await res.json();
    const symbols = data.results?.slice(0, 3).map((s: any) => s.symbol).join(", ") || "";
    return symbols ? `StockTwits Retail: ${symbols}` : "";
  } catch {
    return "";
  }
}

// ------------------------------------------------------------------
// Pipeline Execution
// ------------------------------------------------------------------

export async function runZeitgeistPipeline(txHash: `0x${string}`, expectedGroupName: string, mode: string = "meme"): Promise<ZeitgeistResult> {
  const cacheKey = `vibecheck:result:${expectedGroupName.toLowerCase().trim()}:${mode}`;
  const cached = await kv.get<ZeitgeistResult>(cacheKey);
  if (cached) {
    return { ...cached, cached: true, txHash };
  }

  const receipt = await publicClient.getTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") {
    throw new Error("Transaction reverted or not found");
  }

  const logs = await publicClient.getLogs({
    address: PAYMENT_CONTRACT,
    event: parseAbiItem("event QueryPaid(address indexed user, string groupName, uint256 amount, bool isClawd)"),
    fromBlock: receipt.blockNumber,
    toBlock: receipt.blockNumber,
  });

  const paymentLog = logs.find(l => l.transactionHash === txHash);
  if (!paymentLog) {
    throw new Error("No QueryPaid event found in this transaction");
  }

  const { groupName, isClawd } = paymentLog.args;
  if (!groupName) throw new Error("Invalid event args");

  const braveKey = process.env.BRAVE_SEARCH_API_KEY || "";
  const ytKey = process.env.YOUTUBE_API_KEY || "";
  const neynarKey = process.env.NEYNAR_API_KEY || "";
  const cmcKey = process.env.COINMARKETCAP_API_KEY || "";
  const lunarKey = process.env.LUNARCRUSH_API_KEY || "";
  const openaiKey = process.env.OPENAI_API_KEY || "";

  if (!openaiKey) throw new Error("OpenAI API key missing");

  // Fetch all 8 sources in parallel to beat the 10s Vercel timeout
  const [
    redditData,
    braveData,
    ytData,
    neynarData,
    cgData,
    cmcData,
    lunarData,
    stData
  ] = await Promise.all([
    fetchReddit(groupName),
    fetchBrave(groupName, braveKey),
    fetchYouTube(groupName, ytKey),
    fetchNeynar(groupName, neynarKey),
    fetchCoinGecko(groupName),
    fetchCoinMarketCap(cmcKey),
    fetchLunarCrush(groupName, lunarKey),
    fetchStockTwits(groupName)
  ]);

  const allData = [redditData, braveData, ytData, neynarData, cgData, cmcData, lunarData, stData]
    .filter(Boolean)
    .join("\n\n");

  const lowConfidence = allData.length < 100;

  let systemPrompt = "";
  let imageStyle = "";

  if (mode === "technical") {
    systemPrompt = `You are VibeCheck, an on-chain cultural intelligence terminal.
Analyze the provided real-time data streams for the target group/topic.
Synthesize the current vibe into exactly 5 signals and a 2-sentence TLDR.

RULES:
1. Output MUST be valid JSON.
2. "moodHeadline" must be a 3-6 word clinical diagnosis of their current state.
3. "signals" must be an array of exactly 5 strings. Each string must be a precise, data-forward observation based ONLY on the provided data. Include specific metrics if available.
4. "tldr" must be exactly 2 sentences providing a tight executive summary.
5. DO NOT include source labels or URLs.
6. Tone: Clinical, analytical, neutral, no fluff, no humor.`;
    imageStyle = "Clean data visualization aesthetic, minimal, abstract geometric shapes, dark background, icy blue accents, no text.";
  } else if (mode === "basic") {
    systemPrompt = `You are VibeCheck, an on-chain cultural intelligence terminal.
Analyze the provided real-time data streams for the target group/topic.
Synthesize the current vibe into exactly 5 signals and a 2-sentence TLDR.

RULES:
1. Output MUST be valid JSON.
2. "moodHeadline" must be a 3-6 word simple summary of their current mood.
3. "signals" must be an array of exactly 5 strings. Each string must be a clear, conversational observation based ONLY on the provided data. No jargon.
4. "tldr" must be exactly 2 sentences explaining what's going on simply.
5. DO NOT include source labels or URLs.
6. Tone: Friendly, accessible, clear, like a smart friend explaining it.`;
    imageStyle = "Clean, illustrative, friendly, simple vector art, dark background, bright blue accents, no text.";
  } else {
    // meme mode (default)
    systemPrompt = `You are VibeCheck, an on-chain cultural intelligence terminal.
Analyze the provided real-time data streams for the target group/topic.
Synthesize the current vibe into exactly 5 punchy signals and a 2-sentence TLDR.

RULES:
1. Output MUST be valid JSON.
2. "moodHeadline" must be a 3-6 word diagnosis of their current mental state.
3. "signals" must be an array of exactly 5 strings. Each string must be a sharp, specific observation based ONLY on the provided data.
4. "tldr" must be exactly 2 sentences summarizing the overall vibe.
5. DO NOT include source labels or URLs.
6. Tone: Clinical, slightly absurdist, highly observant, shitpost energy.`;
    imageStyle = "Retro CRT monitor aesthetic, glitch art, highly symbolic, surreal meme energy, no text, dark background, icy blue and neon accents.";
  }

  const userPrompt = `Target: ${groupName}\n\nData Streams (Past 24h):\n${allData || "No data found."}`;

  const gptRes = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${openaiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ],
      response_format: { type: "json_object" },
      temperature: 0.7,
    }),
  });

  if (!gptRes.ok) throw new Error("GPT synthesis failed");
  const gptData = await gptRes.json();
  const parsed = JSON.parse(gptData.choices[0].message.content);

  const imagePrompt = `A visual snapshot representing this cultural diagnosis: "${parsed.moodHeadline}". 
Context: ${parsed.tldr}
Style: ${imageStyle}`;

  let imageUrl = "";
  try {
    const imgRes = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${openaiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-image-1",
        prompt: imagePrompt,
        n: 1,
        size: "1024x1024",
        quality: "standard",
        output_format: "url",
      }),
    });
    if (imgRes.ok) {
      const imgData = await imgRes.json();
      imageUrl = imgData.data[0].url;
    }
  } catch (e) {
    console.error("Image generation failed", e);
  }

  const result: ZeitgeistResult = {
    groupName,
    imageUrl,
    moodHeadline: parsed.moodHeadline || "Vibe Unknown",
    signals: Array.isArray(parsed.signals) ? parsed.signals.slice(0, 5) : [],
    tldr: parsed.tldr || "Insufficient data to form a diagnosis.",
    generatedAt: Math.floor(Date.now() / 1000),
    txHash,
    isClawdPayment: Boolean(isClawd),
    lowConfidence,
    cached: false,
  };

  await kv.set(cacheKey, result, { ex: CACHE_TTL_SECONDS });
  return result;
}
