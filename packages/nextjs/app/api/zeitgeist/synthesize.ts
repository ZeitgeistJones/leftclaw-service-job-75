/**
 * synthesize.ts — Turn raw signals into structured analysis via GPT-4o-mini.
 *
 * Three modes: meme (unhinged), basic (plain english), technical (analyst).
 * Generates inline source citations and a leftclaw-compatible image prompt.
 */

import type { Signal, Synthesis, AnalysisMode } from "./types";
import type { ClassifyResult } from "./classify";

const SYSTEM_PROMPTS: Record<AnalysisMode, string> = {
  meme: `You are a deeply online crypto-native cultural analyst with terminal brainrot. You channel Crypto Twitter energy — irreverent, pattern-recognizing, meme-fluent.

Rules:
- moodHeadline: punchy 3-6 word shitpost diagnosis of the current vibe
- signals: exactly 5 items. Clean punchy statements. At least one should include a direct quote from the source data. Reference specific numbers when available.
- tldr: exactly 2 sentences. Both FUNNY — dry wit, absurdist, or brutally honest.
- analysis: 3-4 paragraphs of chaotic but insightful commentary. Channel CT energy. Reference holder behavior, narrative construction, and social signals.
- confidence: "high" if 8+ signals with diverse sources, "medium" if 4-7, "low" if <4
- imagePrompt: a SHORT scene description (10-15 words) of the CLAWD character (a red crystalline lobster mascot in a tuxedo) reacting to this sentiment. Examples: "looking smug on a throne made of green candles" or "sweating nervously watching red charts rain down" or "wearing sunglasses doing a mic drop". Must be a single clear scene.
- sources: array of {label, url} for the 3-5 most important sources you drew from`,

  basic: `You are a friendly explainer helping regular people understand what's happening with a crypto topic right now.

Rules:
- moodHeadline: 3-6 words describing the current mood in plain English
- signals: exactly 5 clear, jargon-free observations anyone can understand
- tldr: exactly 2 sentences. Simple, clear.
- analysis: 3-4 paragraphs in plain English. Explain context. Explain what holders seem to believe.
- confidence: "high" if 8+ signals, "medium" if 4-7, "low" if <4
- imagePrompt: SHORT scene (10-15 words) of the CLAWD character (a red crystalline lobster in a tuxedo) in a scene matching the mood. Keep it friendly and clear.
- sources: array of {label, url} for the top sources`,

  technical: `You are a professional market intelligence analyst providing structured assessments.

Rules:
- moodHeadline: 3-6 word clinical assessment of current state
- signals: exactly 5 precise, data-forward observations. Include specific metrics.
- tldr: exactly 2 sentences. Tight professional executive summary.
- analysis: 3-4 paragraphs of structured analytical commentary. Discuss holder behavior patterns, narrative construction, on-chain intelligence, and social divergences.
- confidence: "high" if 8+ signals with diverse sources, "medium" if 4-7, "low" if <4
- imagePrompt: SHORT scene (10-15 words) of the CLAWD character (a red crystalline lobster in a tuxedo) in a professional setting reflecting the analysis. Keep it clean and minimal.
- sources: array of {label, url} for key sources`,
};

export async function synthesize(
  classified: ClassifyResult,
  signals: Signal[],
  mode: AnalysisMode,
  apiKey: string,
): Promise<Synthesis> {
  const groupName =
    classified.type === "token" ? `${classified.token.name} (${classified.token.symbol})` : classified.rawInput;

  const tokenContext =
    classified.type === "token"
      ? `\nTOKEN DATA: ${classified.token.name} (${classified.token.symbol}) on ${classified.token.chain.toUpperCase()}, address: ${classified.token.address}`
      : "";

  const signalText = signals.map((s, i) => `[${i + 1}] [${s.source.toUpperCase()}] ${s.text} (${s.url})`).join("\n");

  const antiHallucination =
    signals.length < 4
      ? "\nNOTE: Very few signals found. Be honest — say the data is thin. Do not invent plausible-sounding content."
      : "";

  const systemPrompt = `${SYSTEM_PROMPTS[mode]}

CRITICAL: Only use information from the provided signals. Every claim must trace to a numbered signal. Do not invent data.
Topic: "${groupName}"
${antiHallucination}`;

  const userPrompt = `Signals (past 24-48 hours):
${signalText}
${tokenContext}

Return valid JSON only:
{
  "moodHeadline": "...",
  "signals": ["...", "...", "...", "...", "..."],
  "tldr": "...",
  "analysis": "...",
  "confidence": "high|medium|low",
  "imagePrompt": "CLAWD character (red lobster in tuxedo) [scene]",
  "sources": [{"label": "...", "url": "..."}, ...]
}`;

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      response_format: { type: "json_object" },
      temperature: mode === "meme" ? 0.9 : mode === "basic" ? 0.7 : 0.5,
      max_tokens: 2000,
    }),
  });

  if (!res.ok) throw new Error(`OpenAI synthesis failed: ${res.status}`);

  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };

  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("OpenAI synthesis returned empty content");

  let parsed: Partial<Synthesis>;
  try {
    parsed = JSON.parse(content) as Partial<Synthesis>;
  } catch {
    throw new Error("OpenAI synthesis returned invalid JSON");
  }

  const confidence: Synthesis["confidence"] = ["high", "medium", "low"].includes(parsed.confidence as string)
    ? (parsed.confidence as Synthesis["confidence"])
    : signals.length >= 8
      ? "high"
      : signals.length >= 4
        ? "medium"
        : "low";

  const signalList = Array.isArray(parsed.signals)
    ? parsed.signals.filter((s): s is string => typeof s === "string").slice(0, 5)
    : [];

  const sources = Array.isArray(parsed.sources)
    ? parsed.sources.filter(
        (s): s is { label: string; url: string } =>
          !!s && typeof s === "object" && typeof s.label === "string" && typeof s.url === "string",
      )
    : [];

  return {
    moodHeadline: typeof parsed.moodHeadline === "string" ? parsed.moodHeadline : `Vibe on ${groupName}`,
    signals: signalList.length > 0 ? signalList : ["Not enough clean signal to form a strong read."],
    tldr: typeof parsed.tldr === "string" ? parsed.tldr : "Data was thin. Treat this as provisional.",
    analysis: typeof parsed.analysis === "string" ? parsed.analysis : "",
    confidence,
    imagePrompt:
      typeof parsed.imagePrompt === "string"
        ? parsed.imagePrompt
        : "looking thoughtfully at a glowing chart",
    sources,
  };
}
