import { Archivo_Black, Space_Mono } from "next/font/google";
import "@rainbow-me/rainbowkit/styles.css";
import "@scaffold-ui/components/styles.css";
import { ScaffoldEthAppWithProviders } from "~~/components/ScaffoldEthAppWithProviders";
import { ThemeProvider } from "~~/components/ThemeProvider";
import "~~/styles/globals.css";
import { getMetadata } from "~~/utils/scaffold-eth/getMetadata";

const archivoBlack = Archivo_Black({
  weight: "400",
  subsets: ["latin"],
  variable: "--font-display",
  display: "swap",
});

const spaceMono = Space_Mono({
  weight: ["400", "700"],
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata = getMetadata({
  title: "VibeCheck",
  description:
    "Pay $0.25 in ETH or CLAWD on Base to generate an AI-synthesized cultural snapshot of any group — analysis from real-time web signals.",
});

const ScaffoldEthApp = ({ children }: { children: React.ReactNode }) => {
  return (
    <html suppressHydrationWarning className={`${archivoBlack.variable} ${spaceMono.variable}`}>
      <body>
        <ThemeProvider forcedTheme="light">
          <ScaffoldEthAppWithProviders>{children}</ScaffoldEthAppWithProviders>
        </ThemeProvider>
      </body>
    </html>
  );
};

export default ScaffoldEthApp;
