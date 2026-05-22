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
          content: `You generate hyper-targeted web search queries to find recent news and discourse about a SPECIFIC group, person, event, or community.

CRITICAL RULES:
- Queries must be laser-focused on EXACTLY what was asked — not the broader category it belongs to
- If asked about "Texas vs Arkansas baseball", search for THAT matchup specifically, NOT "SEC baseball tournament"
- If asked about a specific person, include their full name plus disambiguating context (their field, organization, etc.)
- If asked about a niche community, include specific terminology that community uses
- Each query should target a different angle: the specific event/news, community reaction, key figures involved, and controversy or debate
- Avoid broad category terms that would return results about adjacent topics

Return a JSON object with a "queries" array of exactly 4 search query strings. JSON only, no markdown.`,
        },
        {
          role: "user",
          content: `Generate 4 hyper-targeted search queries for: "${groupName}"`,
        },
      ],
      response_format: { type: "json_object" },
      temperature: 0.3,
      max_tokens: 300,
    }),
  });

  if (!res.ok) throw new Error(`Query generation failed: ${res.status}`);
  const data = (await res.json()) as { choices: { message: { content: string } }[] };
  const parsed = JSON.parse(data.choices[0].message.content) as { queries: string[] };
  return parsed.queries.slice(0, 4);
}

async function gatherSignals(groupName: string, apiKey: string): Promise<{ snippets: string[]; lowConfidence: boolean }> {
  const braveKey = process.env.BRAVE_SEARCH_API_KEY;
  if (!braveKey) throw new Error("BRAVE_SEARCH_API_KEY not configured");

  const queries = await generateSearchQueries(groupName, apiKey);

  const snippets: string[] = [];

  for (const query of queries) {
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5&freshness=pw`;
    const res = await fetch(url, {
      headers: { Accept: "application/json", "Accept-Encoding": "gzip", "X-Subscription-Token": braveKey },
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
  apiKey: string,
): Promise<{ moodHeadline: string; signals: string[]; tldr: string; analysis: string; imagePrompt: string }> {
  const confidenceCaveat = lowConfidence
    ? "NOTE: Fewer than 3 results found. Be transparent about thin data."
    : "";

  const systemPrompt = `You are a sharp, irreverent cultural analyst — part journalist, part shitposter. Given real web signals about a specific group or topic, produce a zeitgeist snapshot.

CRITICAL FOCUS RULE: Every signal, every sentence of analysis, every word of the TLDR must be SPECIFICALLY about "${groupName}" — not about adjacent topics, not about the broader category, not about related groups. If a snippet is about something adjacent (e.g., other teams in a tournament, other projects in a space), IGNORE IT completely. Only use information directly about the queried subject.

Rules:
- moodHeadline: punchy, specific, slightly unhinged — directly about the queried group
- signals: 3-5 items, each referencing a SPECIFIC event, person, or development from the snippets that is DIRECTLY about the queried group. Discard anything adjacent.
- tldr: exactly 3 sentences — first sentence states the core situation, second adds the key tension or irony, third delivers the punchline or implication
- analysis: 3-4 paragraphs, opinionated and specific, focused entirely on the queried group
- imagePrompt: surreal, absurdist, internet-brain visual that captures the SPECIFIC vibe of this group — chaotic collage energy, unexpected juxtapositions. No text, no words in the image.

Output valid JSON only. No markdown fences. ${confidenceCaveat}`;

  const userPrompt = `Group: "${groupName}"

Web signals from the past week:
${snippets.join("\n")}

Return JSON:
{
  "moodHeadline": "punchy specific mood about exactly this group",
  "signals": ["specific signal directly about this group 1", "specific signal 2", "specific signal 3"],
  "tldr": "sentence 1: core situation. Sentence 2: key tension or irony. Sentence 3: punchline or implication.",
  "analysis": "3-4 paragraphs focused entirely on this specific group",
  "imagePrompt": "surreal absurdist scene capturing this group's specific vibe, no text"
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
