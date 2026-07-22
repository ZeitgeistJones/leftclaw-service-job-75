/**
 * images/index.ts — Image strategy router.
 *
 * Modes:
 * - "sharecard" (default): programmatic HTML→image card, no API call, instant
 * - "leftclaw": CLAWD character via LeftClaw PFP service (~1¢, 3-5s)
 * - "recraft": stylized illustration via Recraft V3 on fal.ai (~4¢, 3-8s)
 * - "none": skip image generation entirely
 */

import type { ImageMode, Synthesis } from "../types";
import type { ClassifyResult } from "../classify";
import { generateLeftclawImage } from "./leftclaw";
import { generateRecraftImage } from "./recraft";

/**
 * Generate an image based on the selected mode.
 *
 * @returns image URL / data URL, or empty string if skipped/failed
 */
export async function generateImage(
  mode: ImageMode,
  synthesis: Synthesis,
  classified: ClassifyResult,
): Promise<string> {
  switch (mode) {
    case "none":
      return "";

    case "sharecard":
      // Share cards are rendered client-side from synthesis data.
      return "";

    case "leftclaw":
      return await generateLeftclawImage(synthesis.imagePrompt);

    case "recraft": {
      const groupName =
        classified.type === "token"
          ? `${classified.token.name} (${classified.token.symbol})`
          : classified.rawInput;
      const fullPrompt = `${synthesis.imagePrompt}. Theme: ${groupName} crypto sentiment. Style: vibrant neon, dark background, digital art.`;
      return await generateRecraftImage(fullPrompt);
    }

    default:
      return "";
  }
}
