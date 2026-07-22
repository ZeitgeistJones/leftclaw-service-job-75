/**
 * images/recraft.ts — Generate images via Recraft V3 on fal.ai.
 *
 * Recraft is purpose-built for controllable text layers. ~$0.04/image.
 */

const FAL_API_KEY = process.env.FAL_API_KEY;

/**
 * Generate an image via Recraft V3 on fal.ai.
 *
 * @param prompt - Full image prompt
 * @returns URL of the generated image, or empty string on failure
 */
export async function generateRecraftImage(prompt: string): Promise<string> {
  if (!FAL_API_KEY) {
    console.warn("FAL_API_KEY not set, skipping Recraft generation");
    return "";
  }

  try {
    const res = await fetch("https://fal.run/fal-ai/recraft-v3", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Key ${FAL_API_KEY}`,
      },
      body: JSON.stringify({
        prompt: `${prompt}. No text, no words, no letters anywhere in the image.`,
        image_size: "square",
        style: "digital_illustration",
      }),
    });

    if (!res.ok) {
      console.error(`Recraft/fal.ai error: ${res.status}`);
      return "";
    }

    const data = (await res.json()) as {
      images?: { url: string }[];
    };

    return data.images?.[0]?.url || "";
  } catch (err) {
    console.error("Recraft generation failed:", err);
    return "";
  }
}
