import { NextRequest, NextResponse } from "next/server";
import { runZeitgeistPipeline } from "./pipeline";

export const dynamic = "force-dynamic";

async function handle(txHash: string | null, groupName: string | null, ip: string): Promise<NextResponse> {
  if (!txHash || !groupName) {
    return NextResponse.json({ error: "txHash and groupName are required" }, { status: 400 });
  }
  try {
    const result = await runZeitgeistPipeline(txHash as `0x${string}`, groupName, ip);
    if ("error" in result) {
      const status = result.retryAfterMs ? 429 : 402;
      return NextResponse.json(result, { status });
    }
    return NextResponse.json(result);
  } catch (err: unknown) {
    console.error("Zeitgeist pipeline error:", err);
    return NextResponse.json({ error: "Internal server error. Please try again." }, { status: 502 });
  }
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const ip = req.headers.get("x-forwarded-for")?.split(",")?.[0]?.trim() ?? "unknown";
  const txHash = req.nextUrl.searchParams.get("txHash");
  const groupName = req.nextUrl.searchParams.get("groupName");
  return handle(txHash, groupName, ip);
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const ip = req.headers.get("x-forwarded-for")?.split(",")?.[0]?.trim() ?? "unknown";
  let body: { txHash?: string; groupName?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  return handle(body.txHash ?? null, body.groupName ?? null, ip);
}
