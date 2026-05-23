import { Space_Mono, Space_Grotesk } from "next/font/google";
import "~~/styles/globals.css";

const spaceMono = Space_Mono({
  subsets: ["latin"],
  weight: ["400", "700"],
  variable: "--font-mono-var",
  display: "swap",
});

const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-display-var",
  display: "swap",
});

export const metadata = {
  title: "VibeCheck",
  description: "Diagnosing the collective unconscious since today. On-chain cultural intelligence powered by $CLAWD on Base.",
  openGraph: {
    title: "VibeCheck",
    description: "Diagnosing the collective unconscious since today.",
    siteName: "VibeCheck",
  },
};

const VibeCheckApp = ({ children }: { children: React.ReactNode }) => {
  return (
    <html lang="en" className={`${spaceMono.variable} ${spaceGrotesk.variable}`}>
      <body>{children}</body>
    </html>
  );
};

export default VibeCheckApp;
