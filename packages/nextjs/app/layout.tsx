import { Space_Mono, Space_Grotesk } from "next/font/google";
import "@rainbow-me/rainbowkit/styles.css";
import "@scaffold-ui/components/styles.css";
import { ScaffoldEthAppWithProviders } from "~~/components/ScaffoldEthAppWithProviders";
import { ThemeProvider } from "~~/components/ThemeProvider";
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
  description:
    "Diagnosing the collective unconscious since today. On-chain cultural intelligence powered by $CLAWD on Base.",
  openGraph: {
    title: "VibeCheck",
    description: "Diagnosing the collective unconscious since today.",
    siteName: "VibeCheck",
  },
};

const VibeCheckApp = ({ children }: { children: React.ReactNode }) => {
  return (
    <html suppressHydrationWarning lang="en" className={`${spaceMono.variable} ${spaceGrotesk.variable}`}>
      <body>
        <ThemeProvider enableSystem>
          <ScaffoldEthAppWithProviders>{children}</ScaffoldEthAppWithProviders>
        </ThemeProvider>
      </body>
    </html>
  );
};

export default VibeCheckApp;
