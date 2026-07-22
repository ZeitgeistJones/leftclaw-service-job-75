/**
 * types.ts — Shared types for the VibeCheck pipeline.
 */

/** A single piece of signal from any source. */
export type Signal = {
  text: string;
  url: string;
  source: "dexscreener" | "lunarcrush" | "farcaster" | "reddit" | "web" | "onchain";
};

/** What the synthesis step produces. */
export type Synthesis = {
  moodHeadline: string;
  signals: string[];
  tldr: string;
  analysis: string;
  confidence: "high" | "medium" | "low";
  /** Short scene prompt for leftclaw/image gen. */
  imagePrompt: string;
  /** Sources cited in the analysis, for attribution. */
  sources: { label: string; url: string }[];
};

/** Image strategy options. */
export type ImageMode = "sharecard" | "leftclaw" | "recraft" | "none";

/** Analysis tone. */
export type AnalysisMode = "meme" | "basic" | "technical";

/** Final result returned to the frontend. */
export type VibeCheckResult = {
  groupName: string;
  topicType: "token" | "community";
  imageUrl: string;
  imageMode: ImageMode;
  moodHeadline: string;
  signals: string[];
  tldr: string;
  analysis: string;
  confidence: "high" | "medium" | "low";
  sources: { label: string; url: string }[];
  generatedAt: number;
  txHash: `0x${string}`;
  isClawdPayment: boolean;
  cached: boolean;
};

export type VibeCheckError = {
  error: string;
  retryAfterMs?: number;
  /** Receipt not mined yet, or another worker is still generating for this tx. */
  pending?: boolean;
};
