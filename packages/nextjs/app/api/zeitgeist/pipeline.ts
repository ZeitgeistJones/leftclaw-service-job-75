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

async function generateSearchQueries(groupName: string, apiKey: string): Promise<string[]> {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `You generate hyper-targeted search queries to capture the CURRENT MOMENT of discourse around a specific topic, person, or group. The goal is to find what people are saying RIGHT NOW — fan reactions, hot takes, live commentary, social media discourse — not career summaries or historical context.

CRITICAL RULES:
- Queries must target CURRENT discourse and reactions, not background info
- Include at least one query targeting Reddit discussion (add "site:reddit.com" or "reddit")
- Include at least one query targeting fan/community reactions with words like "fans react", "reaction", "tonight", "right now", "takes"
- Queries must be laser-focused on EXACTLY the topic asked — not the broader category
- If asked about a specific person, include their name plus context to disambiguate
- Avoid queries that would return Wikipedia-style summaries or season recaps

Return a JSON object with a "queries" array of exactly 5 search query strings. JSON only, no markdown.`,
        },
        {
          role: "user",
          content: `Generate 5 hyper-targeted CURRENT DISCOURSE search queries for: "${groupName}"`,
        },
      ],
      response_format: { type: "json_object" },
      temperature: 0.3,
      max_tokens: 400,
    }),
  });

  if (!res.ok) throw new Error(`Query generation failed: ${res.status}`);
  const data = (await res.json()) as { choices: { message: { content: string } }[] };
  const parsed = JSON.parse(data.choices[0].message.content) as { queries: string[] };
  return parsed.queries.slice(0, 5);
}

async function gatherSignals(groupName: string, apiKey: string): Promise<{ snippets: string[]; lowConfidence: boolean }> {
  const braveKey = process.env.BRAVE_SEARCH_API_KEY;
  if (!braveKey) throw new Error("BRAVE_SEARCH_API_KEY not configured");

  const queries = await generateSearchQueries(groupName, apiKey);

  const snippets: string[] = [];

  for (const query of queries) {
    // Use past-day freshness to capture right-now discourse; fall back to past-week if no results
    const urlDay = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5&freshness=pd`;
    const urlWeek = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5&freshness=pw`;

    let res = await fetch(urlDay, {
      headers: { Accept: "application/json", "Accept-Encoding": "gzip", "X-Subscription-Token": braveKey },
    });

    // If past-day returns nothing, fall back to past-week
    if (res.ok) {
      const data = (await res.json()) as { web?: { results?: { title: string; description: string }[] } };
      const results = data?.web?.results ?? [];
      if (results.length === 0) {
        res = await fetch(urlWeek, {
          headers: { Accept: "application/json", "Accept-Encoding": "gzip", "X-Subscription-Token": braveKey },
        });
      } else {
        for (const r of results) {
          snippets.push(`${r.title}: ${r.description}`);
        }
        if (snippets.length >= 15) break;
        continue;
      }
    }

    if (!res.ok) continue;
    const data = (await res.json()) as { web?: { results?: { title: string; description: string }[] } };
    const results = data?.web?.results ?? [];
    for (const r of results) {
      snippets.push(`${r.title}: ${r.description}`);
    }
    if (snippets.length >= 15) break;
  }

  return { snippets: snippets.slice(0, 15), lowConfidence: snippets.length < 3 };
}

async function synthesize(
  groupName: string,
  snippets: string[],
  lowConfidence: boolean,
  apiKey: string,
): Promise<{ moodHeadline: string; signals: string[]; tldr: string; analysis: string; imagePrompt: string }> {
  const confidenceCaveat = lowConfidence
    ? "NOTE: Fewer than 3 results found. Be transparent about thin data."
    : "";

  const systemPrompt = `You are a deeply online cultural analyst capturing THE VIBE RIGHT NOW. Your job is not to summarize who someone is or what they've done historically — it's to capture what people are CURRENTLY saying, feeling, and arguing about in this exact moment.

CRITICAL: You are writing about the CURRENT MOMENT, not a biography. Deprioritize career stats, historical achievements, and background info. Prioritize: hot takes, fan reactions, ongoing debates, controversies happening right now, what's being posted today.

FOCUS RULE: Every signal and every sentence must be SPECIFICALLY about "${groupName}" — not adjacent topics or the broader category.

Rules:
- moodHeadline: captures the current emotional temperature — what's the vibe RIGHT NOW, not historically
- signals: 3-5 items, each a specific CURRENT thing people are saying or reacting to — quotes, takes, debates, reactions. Discard anything that reads like background info.
- tldr: exactly 3 sentences — sentence 1: what's happening right now, sentence 2: the key tension or hot take, sentence 3: the punchline or what this means
- analysis: 3-4 paragraphs focused on the current discourse and vibe, not career summaries
- imagePrompt: surreal, absurdist, internet-brain visual capturing the CURRENT energy — chaotic collage, wojak vibes, something that would get posted in a Discord right now. No text, no words.

Output valid JSON only. No markdown fences. ${confidenceCaveat}`;

  const userPrompt = `Group/Topic: "${groupName}"

Current web signals (past 24-48 hours):
${snippets.join("\n")}

Return JSON:
{
  "moodHeadline": "current vibe right now — not historical",
  "signals": ["what people are saying right now 1", "hot take or reaction 2", "current debate 3"],
  "tldr": "Sentence 1: what's happening right now. Sentence 2: the key tension or hot take. Sentence 3: the punchline.",
  "analysis": "3-4 paragraphs on the current discourse and vibe",
  "imagePrompt": "surreal absurdist scene capturing this moment's energy, no text"
}`;

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: "gpt-4o",
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
