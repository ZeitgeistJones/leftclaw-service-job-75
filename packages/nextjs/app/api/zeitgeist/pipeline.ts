/**
 * pipeline.ts — Main VibeCheck pipeline orchestrator.
 *
 * Flow: classify → gather signals → synthesize → generate image → cache
 *
 * Payment is verified on every request. TxHashes are claimed only after a
 * successful result (or shared cache return) so a mid-pipeline failure does
 * not burn the payment. Concurrent polls for the same tx wait on a short
 * running lock instead of racing.
 */

import { createPublicClient, decodeEventLog, http, parseAbi } from "viem";
import { base } from "viem/chains";
import { kv } from "@vercel/kv";
import deployedContracts from "~~/contracts/deployedContracts";
import { classify } from "./classify";
import { gatherCryptoSignals } from "./signals/crypto";
import { gatherCommunitySignals } from "./signals/community";
import { synthesize } from "./synthesize";
import { generateImage } from "./images";
import type { VibeCheckResult, VibeCheckError, AnalysisMode, ImageMode } from "./types";

// ------------------------------------------------------------------
// Constants
// ------------------------------------------------------------------
const ZEITGEIST_PAYMENT_ADDRESS = deployedContracts[8453].ZeitgeistPayment.address;
const QUERY_PAID_ABI = parseAbi([
  "event QueryPaid(address indexed user, string groupName, uint256 amount, bool isClawd)",
]);
const CACHE_TTL_SECONDS = 60 * 60 * 24; // 24h
const RATE_LIMIT_WINDOW = 60;
const RATE_LIMIT_MAX = 30; // polls every 2s; pending receipts must not strand users
const RUNNING_TTL_SECONDS = 90;

type PaymentRead =
  | { status: "ok"; isClawd: boolean }
  | { status: "pending" }
  | { status: "invalid" };

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

function cacheKey(groupName: string, analysisMode: string, imageMode: string): string {
  return `vc2:${groupName.toLowerCase().trim()}:${analysisMode}:${imageMode}`;
}

function usedTxKey(txHash: string): string {
  return `used_tx:${txHash.toLowerCase()}`;
}

function runningKey(txHash: string): string {
  return `running:${txHash.toLowerCase()}`;
}

async function checkRateLimit(ip: string): Promise<boolean> {
  const key = `ratelimit:${ip}`;
  const count = await kv.incr(key);
  if (count === 1) await kv.expire(key, RATE_LIMIT_WINDOW);
  return count <= RATE_LIMIT_MAX;
}

/** Atomic claim — returns true only for the first caller. Stores groupName for replay→cache. */
async function claimTx(txHash: `0x${string}`, groupName: string): Promise<boolean> {
  const ok = await kv.set(usedTxKey(txHash), groupName.toLowerCase().trim(), {
    ex: 48 * 60 * 60,
    nx: true,
  });
  return ok === "OK" || ok === true;
}

// ------------------------------------------------------------------
// Payment Verification (read-only — does not claim)
// ------------------------------------------------------------------
async function readQueryPaid(
  txHash: `0x${string}`,
  expectedGroupName: string,
): Promise<PaymentRead> {
  const alchemyKey = process.env.ALCHEMY_API_KEY;
  const rpcUrl = alchemyKey ? `https://base-mainnet.g.alchemy.com/v2/${alchemyKey}` : "https://mainnet.base.org";

  const client = createPublicClient({ chain: base, transport: http(rpcUrl) });

  let receipt;
  try {
    receipt = await client.getTransactionReceipt({ hash: txHash });
  } catch {
    return { status: "pending" };
  }

  if (!receipt) return { status: "pending" };
  if (receipt.status !== "success") return { status: "invalid" };

  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== ZEITGEIST_PAYMENT_ADDRESS.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({
        abi: QUERY_PAID_ABI,
        data: log.data,
        topics: log.topics,
      });
      if (decoded.eventName !== "QueryPaid") continue;
      const onChainGroup = (decoded.args.groupName as string).trim().toLowerCase();
      if (onChainGroup !== expectedGroupName.trim().toLowerCase()) continue;
      return { status: "ok", isClawd: decoded.args.isClawd as boolean };
    } catch {
      // not a matching log
    }
  }
  return { status: "invalid" };
}

function sanitizeSources(
  sources: { label: string; url: string }[] | undefined,
): { label: string; url: string }[] {
  if (!sources?.length) return [];
  return sources.filter(s => {
    try {
      const u = new URL(s.url);
      return u.protocol === "http:" || u.protocol === "https:";
    } catch {
      return false;
    }
  });
}

// ------------------------------------------------------------------
// Main Pipeline
// ------------------------------------------------------------------
export async function runVibeCheckPipeline(
  txHash: `0x${string}`,
  groupName: string,
  ip: string,
  analysisMode: AnalysisMode = "meme",
  imageMode: ImageMode = "sharecard",
): Promise<VibeCheckResult | VibeCheckError> {
  // 1. Read payment (no claim yet — pending receipts must not burn anything)
  const payment = await readQueryPaid(txHash, groupName);
  if (payment.status === "pending") {
    return { error: "Payment transaction is still pending.", pending: true };
  }
  if (payment.status === "invalid") {
    return {
      error: "Could not verify a QueryPaid event for this txHash + groupName on Base.",
    };
  }

  const key = cacheKey(groupName, analysisMode, imageMode);
  const normalizedGroup = groupName.toLowerCase().trim();

  // 2. If this tx was already consumed for the same group, return shared cache
  const usedFor = await kv.get<string>(usedTxKey(txHash));
  if (usedFor) {
    if (usedFor === normalizedGroup) {
      const cached = await kv.get<VibeCheckResult>(key);
      if (cached) {
        return {
          ...cached,
          cached: true,
          txHash,
          isClawdPayment: payment.isClawd,
          imageMode,
        };
      }
    }
    return {
      error: "Could not verify a QueryPaid event for this txHash + groupName on Base.",
    };
  }

  // 3. Rate limit (only after payment is confirmed on-chain)
  const allowed = await checkRateLimit(ip);
  if (!allowed) {
    return { error: "Rate limit exceeded. Try again in a minute.", retryAfterMs: 60000 };
  }

  // 4. Shared cache hit — claim tx then return
  const cached = await kv.get<VibeCheckResult>(key);
  if (cached) {
    await claimTx(txHash, groupName);
    return {
      ...cached,
      cached: true,
      txHash,
      isClawdPayment: payment.isClawd,
      imageMode,
    };
  }

  // 5. Running lock so concurrent polls for the same tx wait instead of double-running
  const gotLock = await kv.set(runningKey(txHash), 1, { ex: RUNNING_TTL_SECONDS, nx: true });
  if (gotLock !== "OK" && gotLock !== true) {
    return { error: "Pipeline already running for this payment.", pending: true };
  }

  try {
    // Re-check cache under lock (another worker may have finished)
    const cachedAgain = await kv.get<VibeCheckResult>(key);
    if (cachedAgain) {
      await claimTx(txHash, groupName);
      return {
        ...cachedAgain,
        cached: true,
        txHash,
        isClawdPayment: payment.isClawd,
        imageMode,
      };
    }

    const classified = await classify(groupName);

    const { signals } =
      classified.type === "token"
        ? await gatherCryptoSignals(classified.token)
        : await gatherCommunitySignals(classified.rawInput);

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY not configured");

    const synthesis = await synthesize(classified, signals, analysisMode, apiKey);
    const imageUrl = await generateImage(imageMode, synthesis, classified);

    const result: VibeCheckResult = {
      groupName,
      topicType: classified.type,
      imageUrl,
      imageMode,
      moodHeadline: synthesis.moodHeadline,
      signals: synthesis.signals,
      tldr: synthesis.tldr,
      analysis: synthesis.analysis,
      confidence: synthesis.confidence,
      sources: sanitizeSources(synthesis.sources),
      generatedAt: Math.floor(Date.now() / 1000),
      txHash,
      isClawdPayment: payment.isClawd,
      cached: false,
    };

    const cacheableResult = { ...result, txHash: "0x0" as `0x${string}` };
    await kv.set(key, cacheableResult, { ex: CACHE_TTL_SECONDS });
    await claimTx(txHash, groupName);

    return result;
  } catch (err) {
    // Do not claim on failure — user can retry with the same tx
    throw err;
  } finally {
    await kv.del(runningKey(txHash));
  }
}
