import type { Metadata } from "next";

const baseUrl = process.env.NEXT_PUBLIC_PRODUCTION_URL
  ? process.env.NEXT_PUBLIC_PRODUCTION_URL.startsWith("http")
    ? process.env.NEXT_PUBLIC_PRODUCTION_URL
    : `https://${process.env.NEXT_PUBLIC_PRODUCTION_URL}`
  : process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : `http://localhost:${process.env.PORT || 3000}`;

const titleTemplate = "%s | VibeCheck";

export const getMetadata = ({
  title,
  description,
  imageRelativePath = "/thumbnail.jpg",
}: {
  title: string;
  description: string;
  imageRelativePath?: string;
}): Metadata => {
  const imageUrl = `${baseUrl}${imageRelativePath}`;

  return {
    metadataBase: new URL(baseUrl),
    title: {
      default: title,
      template: titleTemplate,
    },
    description: description,
    keywords: [
      "web3",
      "crypto",
      "cultural analysis",
      "AI",
      "Base",
      "Ethereum",
      "memes",
      "social sentiment",
      "zeitgeist",
    ],
    authors: [{ name: "VibeCheck" }],
    openGraph: {
      title: {
        default: title,
        template: titleTemplate,
      },
      description: description,
      images: [
        {
          url: imageUrl,
          width: 1200,
          height: 630,
          alt: "VibeCheck - AI-powered cultural sentiment analysis",
        },
      ],
      type: "website",
      siteName: "VibeCheck",
      url: baseUrl,
    },
    twitter: {
      card: "summary_large_image",
      title: {
        default: title,
        template: titleTemplate,
      },
      description: description,
      images: [imageUrl],
      creator: "@vibecheck",
    },
    icons: {
      icon: [
        {
          url: "/favicon.svg",
          type: "image/svg+xml",
        },
        {
          url: "/favicon.png",
          type: "image/png",
          sizes: "32x32",
        },
      ],
      apple: [
        {
          url: "/apple-touch-icon.png",
          sizes: "180x180",
        },
      ],
    },
    manifest: "/manifest.json",
    robots: {
      index: true,
      follow: true,
    },
    alternates: {
      canonical: baseUrl,
    },
  };
};
