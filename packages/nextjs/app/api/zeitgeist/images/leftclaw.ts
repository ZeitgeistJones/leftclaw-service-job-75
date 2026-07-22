/**
 * images/leftclaw.ts — Generate CLAWD character images via LeftClaw PFP service.
 *
 * Hits the leftclaw-services API which uses openai.images.edit with the
 * CLAWD base image. Falls back to OpenAI images.generate if the service fails.
 */

const LEFTCLAW_BASE_URL = process.env.LEFTCLAW_API_URL || "https://leftclaw-services-nextjs.vercel.app";

/**
 * Generate a CLAWD character image via LeftClaw.
 *
 * @param scenePrompt - Short scene description, e.g.
 *   "looking smug on a throne made of green candles"
 * @returns base64 data URL or empty string on failure
 */
export async function generateLeftclawImage(scenePrompt: string): Promise<string> {
  try {
    const res = await fetch(`${LEFTCLAW_BASE_URL}/api/pfp/generate-payment`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: scenePrompt,
      }),
    });

    if (!res.ok) {
      console.error(`LeftClaw API error: ${res.status}`);
      return await fallbackDirectGenerate(scenePrompt);
    }

    const data = (await res.json()) as { imageUrl?: string; image?: string };

    if (data.imageUrl) return data.imageUrl;
    if (data.image) return data.image;
    return "";
  } catch (err) {
    console.error("LeftClaw generation failed, using fallback:", err);
    return await fallbackDirectGenerate(scenePrompt);
  }
}

/**
 * Fallback: call OpenAI images.generate with CLAWD character description.
 */
async function fallbackDirectGenerate(scenePrompt: string): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return "";

  try {
    const res = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-image-1",
        prompt: `A red crystalline lobster character in a tuxedo (the CLAWD mascot) ${scenePrompt}. Stylized, vibrant, no text or words in the image.`,
        n: 1,
        size: "1024x1024",
        quality: "low",
        output_format: "png",
      }),
    });

    if (!res.ok) return "";

    const data = (await res.json()) as {
      data: { b64_json?: string; url?: string }[];
    };
    const img = data.data?.[0];
    if (!img) return "";
    if (img.b64_json) return `data:image/png;base64,${img.b64_json}`;
    if (img.url) return img.url;
    return "";
  } catch {
    return "";
  }
}
