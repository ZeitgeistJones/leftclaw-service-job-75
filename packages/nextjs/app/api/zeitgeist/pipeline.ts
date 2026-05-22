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
  // Use Alchemy if available, otherwise fall back to Coinbase's public Base RPC
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

async function gatherSignals(groupName: string): Promise<{ snippets: string[]; lowConfidence: boolean }> {
  const apiKey = process.env.BRAVE_SEARCH_API_KEY;
  if (!apiKey) throw new Error("BRAVE_SEARCH_API_KEY not configured");

  const queries = [
    `"${groupName}" community discourse 2026`,
    `${groupName} latest news sentiment`,
    `${groupName} trending discussion`,
  ];

  const snippets: string[] = [];

  for (const query of queries) {
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5&freshness=pw`;
    const res = await fetch(url, {
      headers: { Accept: "application/json", "Accept-Encoding": "gzip", "X-Subscription-Token": apiKey },
    });
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
): Promise<{ moodHeadline: string; signals: string[]; tldr: string; analysis: string; imagePrompt: string }> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not configured");

  const confidenceCaveat = lowConfidence
    ? "NOTE: Fewer than 3 results found. Be transparent about thin data."
    : "";

  const systemPrompt = `You are a sharp cultural analyst. Given real web signals about a community, produce a zeitgeist snapshot.
Rules: identify dominant mood, find 3-5 specific signals, write sharp cultural commentary, adapt tone to the community.
The imagePrompt must describe a WORDLESS visual metaphor — no text, no captions, purely visual storytelling.
Output valid JSON only. No markdown fences. ${confidenceCaveat}`;

  const userPrompt = `Group: "${groupName}"

Signals:
${snippets.join("\n")}

Return JSON:
{
  "moodHeadline": "one-line mood",
  "signals": ["signal 1", "signal 2", "signal 3"],
  "tldr": "one sentence",
  "analysis": "2-4 paragraph cultural commentary",
  "imagePrompt": "detailed wordless visual metaphor description"
}`;

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: "gpt-4o",
      messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }],
      response_format: { type: "json_object" },
      temperature: 0.7,
      max_tokens: 1200,
    }),
  });

  if (!res.ok) throw new Error(`OpenAI synthesis failed: ${res.status}`);
  const data = (await res.json()) as { choices: { message: { content: string } }[] };
  return JSON.parse(data.choices[0].message.content);
}

async function generateImage(prompt: string): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not configured");

  const res = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: "dall-e-3",
      prompt: `${prompt}. Style: meme-native internet aesthetic. CRITICAL: absolutely no text, no words, no letters anywhere in the image.`,
      n: 1,
      size: "1024x1024",
      quality: "standard",
      style: "vivid",
    }),
  });

  if (!res.ok) throw new Error(`DALL-E generation failed: ${res.status}`);
  const data = (await res.json()) as { data: { url: string }[] };
  const url = data.data?.[0]?.url;
  if (!url) throw new Error("DALL-E returned no image URL");
  return url;
}

export async function runZeitgeistPipeline(
  txHash: `0x${string}`,
  groupName: string,
  ip: string,
): Promise<ZeitgeistResult | ZeitgeistError> {
  const allowed = await checkRateLimit(ip);
  if (!allowed) {
    return { error: "Rate limit exceeded. Try again in a minute.", retryAfterMs: 60000 };
  }

  const key = cacheKey(txHash, groupName);

  const cached = await kv.get<ZeitgeistResult>(key);
  if (cached) return { ...cached, cached: true };

  const verification = await verifyQueryPaid(txHash, groupName);
  if (!verification) {
    return { error: "Could not verify a QueryPaid event for this txHash + groupName on Base mainnet." };
  }

  const { snippets, lowConfidence } = await gatherSignals(groupName);
  const synthesis = await synthesize(groupName, snippets, lowConfidence);
  const imageUrl = await generateImage(synthesis.imagePrompt);

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
