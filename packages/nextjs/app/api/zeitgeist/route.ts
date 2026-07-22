/**
 * route.ts — API route handler for /api/zeitgeist.
 *
 * imageMode defaults to sharecard (frontend hardcodes this for now).
 */

import { NextRequest, NextResponse } from "next/server";
import { runVibeCheckPipeline } from "./pipeline";
import type { AnalysisMode, ImageMode } from "./types";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const VALID_ANALYSIS_MODES = ["meme", "basic", "technical"] as const;
const VALID_IMAGE_MODES = ["sharecard", "leftclaw", "recraft", "none"] as const;
const TX_HASH_RE = /^0x[a-fA-F0-9]{64}$/;

function parseAnalysisMode(val: string | null): AnalysisMode {
  if (val && VALID_ANALYSIS_MODES.includes(val as AnalysisMode)) return val as AnalysisMode;
  return "meme";
}

function parseImageMode(val: string | null): ImageMode {
  if (val && VALID_IMAGE_MODES.includes(val as ImageMode)) return val as ImageMode;
  return "sharecard";
}

async function handle(
  txHash: string | null,
  groupName: string | null,
  analysisMode: AnalysisMode,
  imageMode: ImageMode,
  ip: string,
): Promise<NextResponse> {
  if (!txHash || !groupName) {
    return NextResponse.json({ error: "txHash and groupName are required" }, { status: 400 });
  }

  if (!TX_HASH_RE.test(txHash)) {
    return NextResponse.json({ error: "txHash must be a 0x-prefixed 32-byte hex string" }, { status: 400 });
  }

  try {
    const result = await runVibeCheckPipeline(txHash as `0x${string}`, groupName, ip, analysisMode, imageMode);

    if ("error" in result) {
      if (result.pending) {
        return NextResponse.json(result, { status: 202 });
      }
      const status = result.retryAfterMs ? 429 : 402;
      return NextResponse.json(result, { status });
    }

    return NextResponse.json(result);
  } catch (err: unknown) {
    console.error("VibeCheck pipeline error:", err);
    return NextResponse.json({ error: "Internal server error. Please try again." }, { status: 502 });
  }
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const ip = req.headers.get("x-forwarded-for")?.split(",")?.[0]?.trim() ?? "unknown";
  const sp = req.nextUrl.searchParams;
  return handle(sp.get("txHash"), sp.get("groupName"), parseAnalysisMode(sp.get("mode")), parseImageMode(sp.get("imageMode")), ip);
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const ip = req.headers.get("x-forwarded-for")?.split(",")?.[0]?.trim() ?? "unknown";
  let body: Record<string, string>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  return handle(
    body.txHash ?? null,
    body.groupName ?? null,
    parseAnalysisMode(body.mode ?? null),
    parseImageMode(body.imageMode ?? null),
    ip,
  );
}
