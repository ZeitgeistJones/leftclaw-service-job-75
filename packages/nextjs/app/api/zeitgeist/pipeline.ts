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

  const systemPrompt = `You are a sharp, irreverent cultural analyst — part journalist, part shitposter. Given real web signals about a community, produce a zeitgeist snapshot that reads like it was written by someone who is deeply online and genuinely funny.

Rules:
- The moodHeadline should be punchy, specific, and slightly unhinged — not generic
- Each signal must reference a SPECIFIC event, person, post, or debate from the snippets — no vague generalities
- The tldr should be one brutally honest sentence
- The analysis should be 3-4 meaty paragraphs — opinionated, specific, with cultural context. Name names. Reference actual events. Be willing to be a little mean.
- The imagePrompt must describe a SURREAL, ABSURDIST, INTERNET-BRAIN visual — think chaotic collage energy, unexpected juxtapositions, wojak-adjacent vibes, something that would go viral in a Discord server. No literal sports imagery, no sunsets, no skylines. Think: what would a 4chan board dream about this group? Describe a weird, funny, symbolic scene with specific objects and chaos. No text, no words in the image.

Output valid JSON only. No markdown fences. ${confidenceCaveat}`;

  const userPrompt = `Group: "${groupName}"

Web signals from the past week:
${snippets.join("\n")}

Return JSON:
{
  "moodHeadline": "punchy specific mood — not generic",
  "signals": ["specific signal with name/event 1", "specific signal with name/event 2", "specific signal with name/event 3", "specific signal 4", "specific signal 5"],
  "tldr": "one brutally honest sentence",
  "analysis": "3-4 paragraphs of sharp, specific, opinionated cultural commentary",
  "imagePrompt": "surreal absurdist internet-brain scene, chaotic and funny, no text anywhere"
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

async function generateImage(prompt: string): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not configured");

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

  // Cache lookup FIRST — polling bypasses rate limit
  const cached = await kv.get<ZeitgeistResult>(key);
  if (cached) return { ...cached, cached: true };

  // Rate limit only applies to new (uncached) requests
  const allowed = await checkRateLimit(ip);
  if (!allowed) {
    return { error: "Rate limit exceeded. Try again in a minute.", retryAfterMs: 60000 };
  }

  // Verify on-chain payment
  const verification = await verifyQueryPaid(txHash, groupName);
  if (!verification) {
    return { error: "Could not verify a QueryPaid event for this txHash + groupName on Base mainnet." };
  }

  // Gather signals
  const { snippets, lowConfidence } = await gatherSignals(groupName);

  // Synthesize
  const synthesis = await synthesize(groupName, snippets, lowConfidence);

  // Generate image
  const imageUrl = await generateImage(synthesis.imagePrompt);

  // Build result
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
