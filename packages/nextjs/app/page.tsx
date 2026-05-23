"use client";

import { useState, useEffect, useCallback } from "react";
import Image from "next/image";

// ─── Types ────────────────────────────────────────────────────────────────────
interface VibeResult {
  vibeId: string;
  timestamp: string;
  imageUrl?: string;
  tldr: string;
  signals: string[];
  moodHeadline?: string;
}

type WalletState = "disconnected" | "connected" | "insufficient";

// ─── Toast ────────────────────────────────────────────────────────────────────
const Toast = ({ message, visible }: { message: string; visible: boolean }) => (
  <div
    className={`toast-notification ${visible ? "toast-visible" : ""}`}
    aria-live="polite"
  >
    {message}
  </div>
);

// ─── Status Bar ───────────────────────────────────────────────────────────────
const StatusBar = ({
  walletState,
  clawdBalance,
  onConnect,
}: {
  walletState: WalletState;
  clawdBalance: number;
  onConnect: () => void;
}) => {
  const formatBalance = (n: number) => n.toLocaleString();
  const shortAddr = "0x4f2a...c9e1";

  return (
    <div className="status-bar">
      <div className="status-left">
        {walletState === "disconnected" && (
          <>
            <span className="status-dot dot-idle" />
            <span className="status-text">NO WALLET</span>
          </>
        )}
        {walletState === "connected" && (
          <>
            <span className="status-dot dot-connected" />
            <span className="status-text">
              {shortAddr} / {formatBalance(clawdBalance)} CLAWD / SIGNAL READY
            </span>
          </>
        )}
        {walletState === "insufficient" && (
          <>
            <span className="status-dot dot-error" />
            <span className="status-text status-error">
              {shortAddr} / {formatBalance(clawdBalance)} CLAWD / INSUFFICIENT
            </span>
          </>
        )}
      </div>
      <div className="status-right">
        {walletState === "disconnected" ? (
          <button className="btn-connect" onClick={onConnect}>
            CONNECT TO TRANSMIT
          </button>
        ) : (
          <button className="btn-connect btn-connect-muted" disabled>
            CONNECTED
          </button>
        )}
      </div>
    </div>
  );
};

// ─── Meme Frame ───────────────────────────────────────────────────────────────
const MemeFrame = ({ imageUrl }: { imageUrl?: string }) => (
  <div className="meme-frame animate-result" style={{ animationDelay: "0.1s" }}>
    {imageUrl ? (
      <Image
        src={imageUrl}
        alt="VibeCheck meme"
        width={1024}
        height={576}
        unoptimized
        className="meme-image"
      />
    ) : (
      <div className="meme-placeholder">
        <span>[ MEME IMAGE RENDERS HERE ]</span>
      </div>
    )}
  </div>
);

// ─── Result State ─────────────────────────────────────────────────────────────
const ResultPanel = ({
  result,
  onRecheck,
  onCopy,
  onCast,
}: {
  result: VibeResult;
  onRecheck: () => void;
  onCopy: () => void;
  onCast: () => void;
}) => (
  <div className="result-panel">
    {/* Vibe ID */}
    <div className="vibe-id animate-result" style={{ animationDelay: "0s" }}>
      VIBE <span className="vibe-id-number">#{result.vibeId}</span> — {result.timestamp}
    </div>

    {/* Meme Frame */}
    <MemeFrame imageUrl={result.imageUrl} />

    {/* Diagnosis */}
    <div className="diagnosis-block animate-result" style={{ animationDelay: "0.3s" }}>
      <div className="section-label">&gt; DIAGNOSIS:</div>
      <p className="diagnosis-text">{result.tldr}</p>
    </div>

    {/* Signals */}
    <div className="signals-block animate-result" style={{ animationDelay: "0.5s" }}>
      <div className="section-label">— SIGNAL INTERCEPT —</div>
      <div className="signals-list">
        {result.signals.map((signal, i) => (
          <div key={i} className={`signal-row ${i === result.signals.length - 1 ? "signal-row-last" : ""}`}>
            <span className="signal-number">{String(i + 1).padStart(2, "0")}</span>
            <span className="signal-dash">——</span>
            <span className="signal-text">{signal}</span>
          </div>
        ))}
      </div>
    </div>

    {/* Action Buttons */}
    <div className="action-row animate-result" style={{ animationDelay: "0.7s" }}>
      <button className="btn-action btn-cast" onClick={onCast}>
        Cast this vibe →
      </button>
      <button className="btn-action btn-copy" onClick={onCopy}>
        Copy snapshot
      </button>
    </div>

    {/* Recheck */}
    <div className="recheck-row animate-result" style={{ animationDelay: "0.8s" }}>
      <button className="btn-recheck" onClick={onRecheck}>
        ↻ recheck
      </button>
    </div>
  </div>
);

// ─── Loading State ────────────────────────────────────────────────────────────
const LoadingState = () => {
  const [dots, setDots] = useState("");
  useEffect(() => {
    const interval = setInterval(() => {
      setDots(d => (d.length >= 3 ? "" : d + "."));
    }, 400);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="loading-state">
      <div className="loading-text">reading the room{dots}</div>
    </div>
  );
};

// ─── Main Page ────────────────────────────────────────────────────────────────
export default function Home() {
  const [walletState, setWalletState] = useState<WalletState>("disconnected");
  const [clawdBalance, setClawdBalance] = useState(12400);
  const [appState, setAppState] = useState<"idle" | "loading" | "result">("idle");
  const [result, setResult] = useState<VibeResult | null>(null);
  const [toast, setToast] = useState({ message: "", visible: false });
  const [vibeCounter, setVibeCounter] = useState(41);

  // Add/remove body hot class
  useEffect(() => {
    if (appState === "result") {
      document.body.classList.add("hot");
    } else {
      document.body.classList.remove("hot");
    }
  }, [appState]);

  const showToast = useCallback((message: string) => {
    setToast({ message, visible: true });
    setTimeout(() => setToast({ message: "", visible: false }), 2200);
  }, []);

  const handleConnect = () => {
    setWalletState("connected");
  };

  const handleCheckVibe = async () => {
    if (walletState === "disconnected") {
      showToast("CONNECT WALLET FIRST");
      return;
    }
    if (clawdBalance < 5000) {
      setWalletState("insufficient");
      return;
    }

    setAppState("loading");

    try {
      const res = await fetch("/api/zeitgeist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ groupName: "the internet right now" }),
      });

      const data = await res.json();

      const now = new Date();
      const timestamp = `${now.getFullYear()}.${String(now.getMonth() + 1).padStart(2, "0")}.${String(now.getDate()).padStart(2, "0")} / ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")} UTC`;

      const newCounter = vibeCounter + 1;
      setVibeCounter(newCounter);

      setResult({
        vibeId: String(newCounter).padStart(4, "0"),
        timestamp,
        imageUrl: data.imageUrl,
        tldr: data.tldr || data.moodHeadline || "No diagnosis available.",
        signals: data.signals || [],
        moodHeadline: data.moodHeadline,
      });

      setAppState("result");
    } catch {
      showToast("TRANSMISSION FAILED — TRY AGAIN");
      setAppState("idle");
    }
  };

  const handleRecheck = async () => {
    const newBalance = clawdBalance - 5000;
    setClawdBalance(newBalance);
    if (newBalance < 5000) {
      setWalletState("insufficient");
      showToast("INSUFFICIENT CLAWD");
      return;
    }
    await handleCheckVibe();
  };

  const handleCopy = () => {
    if (!result) return;
    const text = [
      `VIBECHECK — VIBE #${result.vibeId} — ${result.timestamp}`,
      ``,
      `DIAGNOSIS: ${result.tldr}`,
      ``,
      `SIGNALS:`,
      ...result.signals.map((s, i) => `${String(i + 1).padStart(2, "0")} — ${s}`),
    ].join("\n");
    navigator.clipboard.writeText(text).then(() => showToast("SNAPSHOT COPIED"));
  };

  const handleCast = () => {
    showToast("CAST COMPOSED");
  };

  return (
    <>
      {/* Noise overlay */}
      <div className="noise-overlay" aria-hidden="true" />

      <main className="main-container">
        {/* Header */}
        <header className="site-header">
          <h1 className="wordmark">VibeCheck</h1>
          <p className="tagline">
            DIAGNOSING THE COLLECTIVE UNCONSCIOUS{" "}
            <span className="tagline-accent">SINCE TODAY</span>
          </p>
          <div className="header-divider" />
        </header>

        {/* Content area */}
        <div className="content-area">
          {appState === "idle" && (
            <div className="idle-state">
              <button
                className="btn-main"
                onClick={handleCheckVibe}
                disabled={walletState === "insufficient"}
              >
                CHECK THE VIBE
              </button>
              <p className="cost-label">
                costs <span className="cost-amount">5,000 CLAWD</span> per transmission
              </p>
            </div>
          )}

          {appState === "loading" && <LoadingState />}

          {appState === "result" && result && (
            <ResultPanel
              result={result}
              onRecheck={handleRecheck}
              onCopy={handleCopy}
              onCast={handleCast}
            />
          )}
        </div>

        {/* Footer */}
        <footer className="site-footer">
          <p>
            contract:{" "}
            <a
              href="https://basescan.org/address/0x45fAeA3de5f9B6D4758EA1907eDc6B127E26081F"
              target="_blank"
              rel="noreferrer"
              className="footer-link"
            >
              0x45fA...081F
            </a>
          </p>
          <p>built on base · powered by $clawd · signals from everywhere</p>
        </footer>
      </main>

      {/* Status Bar */}
      <StatusBar
        walletState={walletState}
        clawdBalance={clawdBalance}
        onConnect={handleConnect}
      />

      {/* Toast */}
      <Toast message={toast.message} visible={toast.visible} />
    </>
  );
}
