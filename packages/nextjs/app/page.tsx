"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import type { NextPage } from "next";
import { type Address as AddressType, formatEther, formatUnits } from "viem";
import { base } from "viem/chains";
import {
  useAccount,
  useBalance,
  useReadContract,
  useSwitchChain,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi";
import deployedContracts from "~~/contracts/deployedContracts";
import externalContracts from "~~/contracts/externalContracts";
import { ColorCustomizer } from "~~/components/ColorCustomizer";
import { useScaffoldReadContract, useScaffoldWriteContract } from "~~/hooks/scaffold-eth";
import { notification } from "~~/utils/scaffold-eth";
import { getParsedErrorWithAllAbis } from "~~/utils/scaffold-eth/contract";

type Pipeline =
  | { status: "idle" }
  | { status: "input" }
  | { status: "submitting" }
  | { status: "loading"; txHash: `0x${string}` }
  | { status: "result"; result: ZeitgeistResult }
  | { status: "error"; message: string };

type ZeitgeistResult = {
  groupName: string;
  imageUrl: string;
  moodHeadline: string;
  signals: string[];
  tldr: string;
  generatedAt: number;
  txHash: `0x${string}`;
  isClawdPayment: boolean;
  lowConfidence: boolean;
  cached: boolean;
};

const APPROVE_COOLDOWN_MS = 4_000;
const POLL_INTERVAL_MS = 2_000;

const LOADING_STATES = [
  "Reading the timeline...",
  "Absorbing the vibes...",
  "Synthesizing the discourse...",
  "Decoding the cultural moment...",
];

const ZEITGEIST_PAYMENT_ADDRESS = deployedContracts[8453].ZeitgeistPayment.address as AddressType;
const CLAWD_ADDRESS = externalContracts[8453].CLAWD.address as AddressType;
const CLAWD_ABI = externalContracts[8453].CLAWD.abi;

type PaymentMode = "ETH" | "CLAWD";

const isMobileDevice = (): boolean => {
  if (typeof navigator === "undefined") return false;
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
};

const openMobileWallet = (): void => {
  if (!isMobileDevice()) return;
  try {
    const lastUsed =
      typeof window !== "undefined" && window.localStorage
        ? window.localStorage.getItem("WALLETCONNECT_DEEPLINK_CHOICE")
        : null;
    if (lastUsed) {
      const parsed = JSON.parse(lastUsed) as { href?: string };
      if (parsed?.href) window.location.href = parsed.href;
    }
  } catch {
    // ignore
  }
};

const Home: NextPage = () => {
  const { address: connectedAddress, chain: connectedChain, isConnected } = useAccount();
  const { switchChain, isPending: isSwitchingChain } = useSwitchChain();

  const onWrongNetwork = isConnected && connectedChain?.id !== base.id;

  const [groupName, setGroupName] = useState("");
  const [paymentMode, setPaymentMode] = useState<PaymentMode>("ETH");
  const [analysisMode, setAnalysisMode] = useState<"meme" | "basic" | "technical">("meme");
  const [pipeline, setPipeline] = useState<Pipeline>({ status: "input" });
  const [loadingTextIndex, setLoadingTextIndex] = useState(0);
  const [approveSubmitting, setApproveSubmitting] = useState(false);
  const [approveCooldownUntil, setApproveCooldownUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const approveFailsafeRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearApproveFailsafe = useCallback(() => {
    if (approveFailsafeRef.current) {
      clearTimeout(approveFailsafeRef.current);
      approveFailsafeRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      if (approveFailsafeRef.current) {
        clearTimeout(approveFailsafeRef.current);
        approveFailsafeRef.current = null;
      }
    };
  }, []);

  const { data: ethRequiredWei } = useScaffoldReadContract({
    contractName: "ZeitgeistPayment",
    functionName: "ethRequired",
    watch: true,
  });

  const { data: queryPriceClawd } = useScaffoldReadContract({
    contractName: "ZeitgeistPayment",
    functionName: "queryPriceCLAWD",
  });

  const { data: ethBalanceData } = useBalance({
    address: connectedAddress,
    chainId: base.id,
    query: { enabled: Boolean(connectedAddress) },
  });

  const { data: clawdBalanceRaw, refetch: refetchClawdBalance } = useReadContract({
    abi: CLAWD_ABI,
    address: CLAWD_ADDRESS,
    chainId: base.id,
    functionName: "balanceOf",
    args: connectedAddress ? [connectedAddress] : undefined,
    query: { enabled: Boolean(connectedAddress) },
  });

  const { data: clawdAllowanceRaw, refetch: refetchClawdAllowance } = useReadContract({
    abi: CLAWD_ABI,
    address: CLAWD_ADDRESS,
    chainId: base.id,
    functionName: "allowance",
    args: connectedAddress ? [connectedAddress, ZEITGEIST_PAYMENT_ADDRESS] : undefined,
    query: { enabled: Boolean(connectedAddress) },
  });

  const { data: clawdDecimalsRaw } = useReadContract({
    abi: CLAWD_ABI,
    address: CLAWD_ADDRESS,
    chainId: base.id,
    functionName: "decimals",
  });

  const clawdDecimals = clawdDecimalsRaw !== undefined ? Number(clawdDecimalsRaw) : 18;
  const clawdBalance = (clawdBalanceRaw as bigint | undefined) ?? 0n;
  const clawdAllowance = (clawdAllowanceRaw as bigint | undefined) ?? 0n;
  const requiredClawd = (queryPriceClawd as bigint | undefined) ?? 0n;
  const requiredEth = (ethRequiredWei as bigint | undefined) ?? 0n;
  const ethBalance = ethBalanceData?.value ?? 0n;

  const needsApproval = paymentMode === "CLAWD" && requiredClawd > 0n && clawdAllowance < requiredClawd;

  const insufficientFunds = useMemo(() => {
    if (paymentMode === "ETH") return requiredEth > 0n && ethBalance < requiredEth;
    return requiredClawd > 0n && clawdBalance < requiredClawd;
  }, [paymentMode, requiredEth, ethBalance, requiredClawd, clawdBalance]);

  const { writeContractAsync: approveClawd } = useWriteContract();
  const { writeContractAsync: writeQuery, isMining } = useScaffoldWriteContract({
    contractName: "ZeitgeistPayment",
  });

  useEffect(() => {
    if (approveCooldownUntil <= 0) return;
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [approveCooldownUntil]);

  const inApproveCooldown = approveCooldownUntil > now;

  useEffect(() => {
    if (pipeline.status !== "loading") return;
    const id = setInterval(() => {
      setLoadingTextIndex(i => (i + 1) % LOADING_STATES.length);
    }, 2_000);
    return () => clearInterval(id);
  }, [pipeline.status]);

  useEffect(() => {
    if (pipeline.status !== "loading") {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
      return;
    }
    const apiBase = process.env.NEXT_PUBLIC_API_URL || "";
    const url = `${apiBase}/api/zeitgeist?txHash=${pipeline.txHash}&groupName=${encodeURIComponent(groupName)}&mode=${analysisMode}`;
    let cancelled = false;

    const poll = async () => {
      try {
        const res = await fetch(url, { cache: "no-store" });
        if (cancelled) return;
        if (res.ok) {
          const data = (await res.json()) as ZeitgeistResult;
          setPipeline({ status: "result", result: data });
          return;
        }
        if (res.status === 503) {
          const body = (await res.json()) as { error?: string };
          setPipeline({
            status: "error",
            message: body.error || "Backend not configured.",
          });
        }
      } catch {
        // network blip — keep polling
      }
    };

    poll();
    pollIntervalRef.current = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
    };
  }, [pipeline, groupName, analysisMode]);

  const handleApprove = useCallback(async () => {
    if (!connectedAddress || needsApproval === false) return;
    setApproveSubmitting(true);
    clearApproveFailsafe();
    approveFailsafeRef.current = setTimeout(() => {
      setApproveSubmitting(false);
      approveFailsafeRef.current = null;
    }, 60_000);
    try {
      const hash = await approveClawd({
        abi: CLAWD_ABI,
        address: CLAWD_ADDRESS,
        chainId: base.id,
        functionName: "approve",
        args: [ZEITGEIST_PAYMENT_ADDRESS, requiredClawd],
      });
      setTimeout(openMobileWallet, 2_000);
      notification.success("Approval submitted. Waiting for confirmation...");
      setPendingApproveTx(hash);
    } catch (err) {
      const parsed = getParsedErrorWithAllAbis(err, base.id);
      notification.error(parsed);
      clearApproveFailsafe();
      setApproveSubmitting(false);
    }
  }, [approveClawd, clearApproveFailsafe, connectedAddress, needsApproval, requiredClawd]);

  const [pendingApproveTx, setPendingApproveTx] = useState<`0x${string}` | undefined>();
  const { data: approveReceipt } = useWaitForTransactionReceipt({
    hash: pendingApproveTx,
    chainId: base.id,
    query: { enabled: Boolean(pendingApproveTx) },
  });

  useEffect(() => {
    if (!approveReceipt) return;
    clearApproveFailsafe();
    setApproveSubmitting(false);
    setApproveCooldownUntil(Date.now() + APPROVE_COOLDOWN_MS);
    refetchClawdAllowance();
    notification.success("CLAWD approved.");
    setPendingApproveTx(undefined);
  }, [approveReceipt, clearApproveFailsafe, refetchClawdAllowance]);

  const handleSubmit = useCallback(async () => {
    if (!connectedAddress) return;
    if (!groupName.trim()) {
      notification.error("Type a cultural group first.");
      return;
    }
    if (onWrongNetwork) {
      notification.error("Switch to Base first.");
      return;
    }
    if (insufficientFunds) {
      notification.error(`Not enough ${paymentMode} for the query.`);
      return;
    }
    setPipeline({ status: "submitting" });
    try {
      let txHash: `0x${string}` | undefined;
      if (paymentMode === "ETH") {
        const value = (requiredEth * 101n) / 100n;
        txHash = (await writeQuery({
          functionName: "queryETH",
          args: [groupName.trim()],
          value,
        })) as `0x${string}` | undefined;
      } else {
        txHash = (await writeQuery({
          functionName: "queryCLAWD",
          args: [groupName.trim(), requiredClawd],
        })) as `0x${string}` | undefined;
      }
      setTimeout(openMobileWallet, 2_000);
      if (!txHash) {
        setPipeline({ status: "input" });
        return;
      }
      setPipeline({ status: "loading", txHash });
      refetchClawdBalance();
      refetchClawdAllowance();
    } catch (err) {
      const parsed = getParsedErrorWithAllAbis(err, base.id);
      notification.error(parsed);
      setPipeline({ status: "input" });
    }
  }, [
    connectedAddress,
    groupName,
    insufficientFunds,
    onWrongNetwork,
    paymentMode,
    refetchClawdAllowance,
    refetchClawdBalance,
    requiredClawd,
    requiredEth,
    writeQuery,
  ]);

  const reset = useCallback(() => {
    setPipeline({ status: "input" });
    setGroupName("");
    setLoadingTextIndex(0);
  }, []);

  const formattedEthRequired = requiredEth > 0n ? Number(formatEther(requiredEth)).toFixed(6) : "—";
  const formattedClawdRequired =
    requiredClawd > 0n ? Number(formatUnits(requiredClawd, clawdDecimals)).toLocaleString() : "—";
  const formattedEthBalance = Number(formatEther(ethBalance)).toFixed(4);
  const formattedClawdBalance = Number(formatUnits(clawdBalance, clawdDecimals)).toLocaleString();

  return (
    <div className="flex flex-col items-center grow w-full px-4 pt-8 pb-24 font-mono">
      {/* Device bezel wrapper */}
      <div style={{
        width: '100%', 
        maxWidth: '900px',
        background: 'linear-gradient(145deg, #1a1a1a 0%, #0d0d0d 50%, #1a1a1a 100%)',
        borderRadius: '24px',
        padding: '20px',
        boxShadow: 'inset 0 2px 4px rgba(255,255,255,0.1), inset 0 -2px 4px rgba(0,0,0,0.5), 0 20px 60px rgba(0,0,0,0.8)',
        position: 'relative',
      }}>
        {/* Inner screen bezel */}
        <div style={{
          background: 'var(--vc-bg-hex)',
          borderRadius: '8px',
          padding: 'clamp(16px, 4vw, 32px)',
          boxShadow: 'inset 0 0 40px rgba(0,0,0,0.8), 0 0 1px rgba(56,189,248,0.3)',
          border: '2px solid oklch(var(--vc-primary) / 0.4)',
          position: 'relative',
        }}>
        {/* Header */}
        <header className="mb-8 text-center">
          <h1 className="header-glow" style={{fontFamily: '"Playfair Display", serif', fontWeight: 900, fontStyle: 'italic', fontSize: 'clamp(4rem, 14vw, 8rem)', lineHeight: 1, color: '#ffffff', textShadow: '0 0 60px var(--vc-primary-hex), 0 0 120px oklch(var(--vc-primary) / 0.5)'}}>VibeCheck</h1>
          <div style={{height: '3px', background: 'var(--vc-primary-hex)', opacity: 0.8, marginBottom: '3px'}} />
          <div style={{height: '2px', background: 'var(--vc-primary-hex)', opacity: 0.5, marginBottom: '2px'}} />
          <div style={{height: '1px', background: 'var(--vc-primary-hex)', opacity: 0.25, marginBottom: '16px'}} />
          <p style={{fontSize: '0.75rem', color: 'var(--vc-primary-hex)', opacity: 0.7, letterSpacing: '0.15em', textTransform: 'uppercase'}}>
            Diagnosing the collective unconscious since today.
          </p>
        </header>

        {/* Main card */}
        <section className="vibe-card" style={{padding: 'clamp(24px, 5vw, 48px) clamp(20px, 4vw, 48px)', border: '2px solid oklch(var(--vc-primary) / 0.6)', boxShadow: '0 0 40px oklch(var(--vc-primary) / 0.3), 0 0 80px oklch(var(--vc-primary) / 0.15), inset 0 0 30px oklch(var(--vc-primary) / 0.05)'}}>
          {pipeline.status === "input" || pipeline.status === "submitting" ? (
            <InputPanel
              groupName={groupName}
              setGroupName={setGroupName}
              paymentMode={paymentMode}
              setPaymentMode={setPaymentMode}
              analysisMode={analysisMode}
              setAnalysisMode={setAnalysisMode}
              isConnected={isConnected}
              onWrongNetwork={onWrongNetwork}
              onSwitchChain={() => switchChain({ chainId: base.id })}
              isSwitchingChain={isSwitchingChain}
              ethRequiredFormatted={formattedEthRequired}
              clawdRequiredFormatted={formattedClawdRequired}
              ethBalanceFormatted={formattedEthBalance}
              clawdBalanceFormatted={formattedClawdBalance}
              insufficientFunds={insufficientFunds}
              needsApproval={needsApproval}
              clawdAllowance={clawdAllowance}
              clawdDecimals={clawdDecimals}
              requiredClawd={requiredClawd}
              onApprove={handleApprove}
              approveSubmitting={approveSubmitting}
              inApproveCooldown={inApproveCooldown}
              approveSecondsLeft={Math.max(0, Math.ceil((approveCooldownUntil - now) / 1000))}
              onSubmit={handleSubmit}
              submitting={pipeline.status === "submitting" || isMining}
            />
          ) : null}

          {pipeline.status === "loading" ? (
            <LoadingPanel
              groupName={groupName}
              loadingText={LOADING_STATES[loadingTextIndex]}
              txHash={pipeline.txHash}
            />
          ) : null}

          {pipeline.status === "result" ? <ResultPanel result={pipeline.result} onReset={reset} /> : null}

          {pipeline.status === "error" ? (
            <div className="space-y-4">
              <div className="border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-300">
                {pipeline.message}
              </div>
              <button className="w-full border border-primary/40 bg-primary/10 text-primary py-3 hover:bg-primary/20 transition-colors" onClick={reset}>
                Back to start
              </button>
            </div>
          ) : null}
        </section>

        {/* Synthwave scene */}
        <div className="relative w-full h-48 mt-8 overflow-hidden">
          {/* Grid floor with perspective */}
          <div className="absolute bottom-0 left-0 right-0 h-28" style={{
            backgroundImage: `linear-gradient(oklch(var(--vc-primary) / 0.3) 1px, transparent 1px), linear-gradient(90deg, oklch(var(--vc-primary) / 0.3) 1px, transparent 1px)`,
            backgroundSize: '50px 24px',
            transform: 'perspective(200px) rotateX(55deg)',
            transformOrigin: 'bottom center'
          }} />
          {/* Sun with scanlines */}
          <div className="absolute left-1/2 -translate-x-1/2" style={{bottom: '56px', width: '140px', height: '70px', background: `linear-gradient(to bottom, rgba(255,255,255,0.9) 0%, var(--vc-primary-hex) 30%, var(--vc-primary-hex) 100%)`, clipPath: 'ellipse(50% 50% at 50% 100%)', boxShadow: `0 0 60px oklch(var(--vc-primary) / 0.5), 0 0 100px oklch(var(--vc-primary) / 0.3)`}}>
            <div style={{position: 'absolute', inset: 0, backgroundImage: 'repeating-linear-gradient(to bottom, transparent 0px, transparent 5px, var(--vc-bg-hex) 5px, var(--vc-bg-hex) 8px)'}} />
          </div>
          {/* Wireframe mountains - left */}
          <svg className="absolute bottom-12 left-0 w-[45%] h-20" viewBox="0 0 200 70" preserveAspectRatio="none" style={{opacity: 0.7}}>
            <polyline points="0,70 25,30 45,50 70,15 95,45 120,25 145,55 175,35 200,70" fill="none" stroke="var(--vc-primary-hex)" strokeWidth="1.5" />
            <polyline points="0,70 30,45 55,55 80,35 105,55 130,40 160,60 200,50 200,70" fill="none" stroke="var(--vc-primary-hex)" strokeWidth="1" opacity="0.5" />
            <polyline points="0,70 20,55 50,60 75,50 100,60 125,52 155,65 200,58 200,70" fill="none" stroke="var(--vc-primary-hex)" strokeWidth="0.5" opacity="0.3" />
          </svg>
          {/* Wireframe mountains - right */}
          <svg className="absolute bottom-12 right-0 w-[45%] h-20" viewBox="0 0 200 70" preserveAspectRatio="none" style={{opacity: 0.7}}>
            <polyline points="0,35 25,55 55,20 80,45 105,10 135,40 165,25 200,70" fill="none" stroke="var(--vc-primary-hex)" strokeWidth="1.5" />
            <polyline points="0,50 35,60 60,40 90,55 115,35 145,55 175,45 200,70" fill="none" stroke="var(--vc-primary-hex)" strokeWidth="1" opacity="0.5" />
            <polyline points="0,58 40,65 70,55 100,62 130,52 160,62 190,55 200,70" fill="none" stroke="var(--vc-primary-hex)" strokeWidth="0.5" opacity="0.3" />
          </svg>
        </div>

        {/* Footer status bar */}
        <section className="mt-4 font-mono space-y-3">
          <p style={{fontSize: '10px', color: 'var(--vc-primary-hex)', opacity: 0.4, textAlign: 'center'}}>
            Contract:{" "}
            <a href={`https://basescan.org/address/${ZEITGEIST_PAYMENT_ADDRESS}`} target="_blank" rel="noreferrer" style={{textDecoration: 'underline'}}>
              {ZEITGEIST_PAYMENT_ADDRESS.slice(0, 6)}...{ZEITGEIST_PAYMENT_ADDRESS.slice(-4)}
            </a>
            {" · "}
            CLAWD:{" "}
            <a href={`https://basescan.org/address/${CLAWD_ADDRESS}`} target="_blank" rel="noreferrer" style={{textDecoration: 'underline'}}>
              {CLAWD_ADDRESS.slice(0, 6)}...{CLAWD_ADDRESS.slice(-4)}
            </a>
          </p>
          <div style={{
            border: '2px solid oklch(var(--vc-primary) / 0.4)', 
            padding: '12px 16px', 
            display: 'flex', 
            alignItems: 'center', 
            justifyContent: 'space-between',
            background: 'oklch(var(--vc-primary) / 0.03)',
            boxShadow: '0 0 20px oklch(var(--vc-primary) / 0.15)'
          }}>
            <div style={{display: 'flex', alignItems: 'center', gap: '10px'}}>
              <span style={{width: '8px', height: '8px', borderRadius: '50%', background: 'var(--vc-primary-hex)', display: 'inline-block', boxShadow: '0 0 10px var(--vc-primary-hex)', animation: 'pulse 2s infinite'}} />
              <div>
                <span style={{fontSize: '10px', color: 'var(--vc-primary-hex)', letterSpacing: '0.1em', textTransform: 'uppercase', display: 'block'}}>VIBECHECK v1.0.0</span>
                <span style={{fontSize: '9px', color: 'var(--vc-primary-hex)', opacity: 0.5, letterSpacing: '0.1em', textTransform: 'uppercase'}}>CONSCIOUSNESS NETWORK ONLINE</span>
              </div>
            </div>
            {/* Signal bars */}
            <div style={{display: 'flex', gap: '2px', alignItems: 'flex-end'}}>
              {[4, 6, 8, 10, 12, 14, 12, 10, 8, 10, 12, 14].map((h, i) => (
                <div key={i} style={{width: '4px', height: `${h}px`, background: 'var(--vc-primary-hex)', opacity: i < 10 ? 1 : 0.5}} />
              ))}
            </div>
          </div>
        </section>
        </div>
        {/* Bezel bottom label */}
        <div style={{display: 'flex', justifyContent: 'flex-end', alignItems: 'center', marginTop: '12px', paddingRight: '16px'}}>
          <span style={{fontSize: '12px', color: 'rgba(255,255,255,0.3)', letterSpacing: '0.2em', fontFamily: 'monospace'}}>VC-1977</span>
          <span style={{width: '10px', height: '10px', borderRadius: '50%', background: 'var(--vc-primary-hex)', marginLeft: '12px', boxShadow: '0 0 8px var(--vc-primary-hex)'}} />
        </div>
      </div>
      <ColorCustomizer />
    </div>
  );
};

// ---------- Sub-panels ----------

type InputPanelProps = {
  groupName: string;
  setGroupName: (v: string) => void;
  paymentMode: PaymentMode;
  setPaymentMode: (m: PaymentMode) => void;
  isConnected: boolean;
  onWrongNetwork: boolean;
  onSwitchChain: () => void;
  isSwitchingChain: boolean;
  ethRequiredFormatted: string;
  clawdRequiredFormatted: string;
  ethBalanceFormatted: string;
  clawdBalanceFormatted: string;
  insufficientFunds: boolean;
  needsApproval: boolean;
  clawdAllowance: bigint;
  clawdDecimals: number;
  requiredClawd: bigint;
  onApprove: () => void;
  approveSubmitting: boolean;
  inApproveCooldown: boolean;
  approveSecondsLeft: number;
  onSubmit: () => void;
  submitting: boolean;
  analysisMode: "meme" | "basic" | "technical";
  setAnalysisMode: (m: "meme" | "basic" | "technical") => void;
};

const InputPanel = ({
  groupName,
  setGroupName,
  paymentMode,
  setPaymentMode,
  analysisMode,
  setAnalysisMode,
  isConnected,
  onWrongNetwork,
  onSwitchChain,
  isSwitchingChain,
  ethRequiredFormatted,
  clawdRequiredFormatted,
  ethBalanceFormatted,
  clawdBalanceFormatted,
  insufficientFunds,
  needsApproval,
  clawdAllowance,
  clawdDecimals,
  requiredClawd,
  onApprove,
  approveSubmitting,
  inApproveCooldown,
  approveSecondsLeft,
  onSubmit,
  submitting,
}: InputPanelProps) => {
  const submitDisabled =
    !isConnected ||
    onWrongNetwork ||
    !groupName.trim() ||
    submitting ||
    insufficientFunds ||
    (paymentMode === "CLAWD" && (needsApproval || approveSubmitting || inApproveCooldown));

  return (
    <div className="space-y-6">
      <div className="text-center">
        <p style={{fontSize: 'clamp(1.5rem, 4vw, 2rem)', fontWeight: 700, color: '#ffffff', marginBottom: '1.2rem', fontFamily: '"Playfair Display", serif', fontStyle: 'italic'}}>Check the vibe of...</p>
        <input
          type="text"
          value={groupName}
          onChange={(e) => setGroupName(e.target.value)}
          placeholder='e.g. NFTs, Monday mornings, vaporwave...'
          maxLength={120}
          className="vibe-input"
          style={{
            width: '100%', 
            background: 'rgba(0,0,0,0.7)', 
            border: '2px solid oklch(var(--vc-primary) / 0.5)', 
            padding: '18px 20px', 
            textAlign: 'center', 
            fontSize: 'clamp(1rem, 2.5vw, 1.2rem)', 
            color: 'var(--vc-primary-hex)', 
            fontFamily: 'Space Mono, monospace', 
            outline: 'none', 
            transition: 'all 0.3s',
            boxShadow: '0 0 20px oklch(var(--vc-primary) / 0.1), inset 0 0 20px oklch(var(--vc-primary) / 0.05)',
          }}
        />
      </div>

      {/* Mode buttons */}
      <div>
        <div style={{display: 'flex', gap: '8px'}}>
          {(["meme", "basic", "technical"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setAnalysisMode(m)}
              style={{
                flex: 1,
                padding: '14px 0',
                fontSize: '0.85rem',
                fontWeight: 700,
                letterSpacing: '0.1em',
                textTransform: 'uppercase',
                transition: 'all 0.2s',
                background: analysisMode === m ? 'var(--vc-primary-hex)' : 'transparent',
                color: analysisMode === m ? '#000000' : 'var(--vc-primary-hex)',
                border: analysisMode === m ? '2px solid var(--vc-primary-hex)' : '2px solid oklch(var(--vc-primary) / 0.4)',
                cursor: 'pointer',
                boxShadow: analysisMode === m 
                  ? '0 0 20px oklch(var(--vc-primary) / 0.4), inset 0 2px 4px rgba(255,255,255,0.2)' 
                  : 'inset 0 2px 4px rgba(0,0,0,0.3)',
              }}
            >
              {m}
            </button>
          ))}
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between mb-3 text-xs px-1" style={{color: 'var(--vc-primary-hex)', opacity: 0.6}}>
          <span className="uppercase tracking-widest">Transmission Fee</span>
        </div>
        <div className="flex gap-3">
          {/* ETH Button */}
          <button
            type="button"
            className="flex-1 py-4 text-sm font-bold flex items-center justify-center gap-3 transition-all"
            style={{
              background: 'transparent',
              color: 'var(--vc-primary-hex)',
              border: paymentMode === "ETH" 
                ? '2px solid var(--vc-primary-hex)' 
                : '1px solid oklch(var(--vc-primary) / 0.3)',
              boxShadow: paymentMode === "ETH" 
                ? '0 0 20px oklch(var(--vc-primary) / 0.3), inset 0 0 20px oklch(var(--vc-primary) / 0.05)' 
                : 'none',
            }}
            onClick={() => setPaymentMode("ETH")}
          >
            <svg viewBox="0 0 24 24" className="w-5 h-5" fill="currentColor">
              <path d="M12 1.5L5.5 12.5L12 16.5L18.5 12.5L12 1.5Z" opacity="0.6"/>
              <path d="M12 16.5L5.5 12.5L12 22.5L18.5 12.5L12 16.5Z"/>
            </svg>
            <span className="tracking-wider">ETH</span>
          </button>
          
          {/* CLAWD Button */}
          <button
            type="button"
            className="flex-1 py-4 text-sm font-bold flex items-center justify-center gap-3 transition-all"
            style={{
              background: 'transparent',
              color: 'var(--vc-primary-hex)',
              border: paymentMode === "CLAWD" 
                ? '2px solid var(--vc-primary-hex)' 
                : '1px solid oklch(var(--vc-primary) / 0.3)',
              boxShadow: paymentMode === "CLAWD" 
                ? '0 0 20px oklch(var(--vc-primary) / 0.3), inset 0 0 20px oklch(var(--vc-primary) / 0.05)' 
                : 'none',
            }}
            onClick={() => setPaymentMode("CLAWD")}
          >
            <svg viewBox="0 0 24 24" className="w-5 h-5" fill="currentColor">
              <path d="M19.35 10.04C18.67 6.59 15.64 4 12 4C9.11 4 6.6 5.64 5.35 8.04C2.34 8.36 0 10.91 0 14C0 17.31 2.69 20 6 20H19C21.76 20 24 17.76 24 15C24 12.36 21.95 10.22 19.35 10.04Z"/>
            </svg>
            <span className="tracking-wider">CLAWD</span>
          </button>
        </div>
        <div className="mt-3 flex items-center justify-between text-xs px-1" style={{color: 'var(--vc-primary-hex)', opacity: 0.6}}>
          <span>{paymentMode === "ETH" ? `~${ethRequiredFormatted} ETH` : `${clawdRequiredFormatted} CLAWD`}</span>
          <span>Bal: {paymentMode === "ETH" ? `${ethBalanceFormatted} ETH` : `${clawdBalanceFormatted} CLAWD`}</span>
        </div>
        {paymentMode === "CLAWD" && requiredClawd > 0n ? (
          <p className="mt-1 text-xs opacity-50 px-1">
            Allowance: {Number(formatUnits(clawdAllowance, clawdDecimals)).toLocaleString()} CLAWD{" "}
            {clawdAllowance >= requiredClawd ? "✓" : "(needs approval)"}
          </p>
        ) : null}
      </div>

      {!isConnected ? (
        <div className="p-4 text-center text-sm" style={{border: '1px dashed oklch(var(--vc-primary) / 0.3)', color: 'var(--vc-primary-hex)', opacity: 0.6}}>
          Connect wallet to transmit
        </div>
      ) : onWrongNetwork ? (
        <button type="button" className="w-full py-4 bg-yellow-500/20 border border-yellow-500/40 text-yellow-300 text-sm hover:bg-yellow-500/30 transition-colors" onClick={onSwitchChain} disabled={isSwitchingChain}>
          {isSwitchingChain ? "Switching…" : "Switch to Base"}
        </button>
      ) : paymentMode === "CLAWD" && needsApproval ? (
        <button
          type="button"
          className="w-full py-4 bg-primary/20 border border-primary/40 text-primary text-sm hover:bg-primary/30 transition-colors disabled:opacity-40"
          onClick={onApprove}
          disabled={approveSubmitting || inApproveCooldown || insufficientFunds}
        >
          {approveSubmitting
            ? "Approving…"
            : inApproveCooldown
              ? `Approving… ready in ${approveSecondsLeft}s`
              : `Approve ${Number(formatUnits(requiredClawd, clawdDecimals)).toLocaleString()} CLAWD`}
        </button>
      ) : (
        <button
          type="button"
          className="w-full font-bold transition-all disabled:cursor-not-allowed vibe-submit-btn flex items-center justify-center gap-3"
          style={submitDisabled 
            ? {padding: '20px', fontSize: 'clamp(1rem, 2.5vw, 1.3rem)', letterSpacing: '0.1em', textTransform: 'uppercase', background: 'oklch(var(--vc-primary) / 0.2)', color: 'var(--vc-primary-hex)', opacity: 0.4, border: 'none'} 
            : {padding: '20px', fontSize: 'clamp(1rem, 2.5vw, 1.3rem)', letterSpacing: '0.1em', textTransform: 'uppercase', background: 'var(--vc-primary-hex)', color: '#000000', boxShadow: '0 0 40px var(--vc-primary-hex), 0 0 80px oklch(var(--vc-primary) / 0.6)', border: 'none'}}
          onClick={onSubmit}
          disabled={submitDisabled}
        >
          <span>
            {submitting
              ? "TRANSMITTING…"
              : insufficientFunds
                ? `INSUFFICIENT ${paymentMode}`
                : "CHECK VIBE"}
          </span>
          {!submitting && !insufficientFunds && !submitDisabled && (
            <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M5 12h14M12 5l7 7-7 7"/>
            </svg>
          )}
        </button>
      )}

      <p className="text-[10px] text-center opacity-40 uppercase tracking-widest">
        Real-time synthesis · Reddit · Farcaster · YouTube · Web · Cached 24h
      </p>
    </div>
  );
};

const LoadingPanel = ({
  groupName,
  loadingText,
  txHash,
}: {
  groupName: string;
  loadingText: string;
  txHash: `0x${string}`;
}) => (
  <div className="space-y-6 text-center py-10">
    <div className="flex justify-center gap-2">
      <div className="loading-dot w-3 h-3 rounded-full" style={{background: '#38bdf8'}} />
      <div className="loading-dot w-3 h-3 rounded-full" style={{background: '#38bdf8'}} />
      <div className="loading-dot w-3 h-3 rounded-full" style={{background: '#38bdf8'}} />
    </div>
    <div>
      <p className="text-xs opacity-40 uppercase tracking-widest mb-2">Diagnosing</p>
      <p className="text-xl font-bold text-white italic" style={{fontSize: 'clamp(1.2rem, 3vw, 1.5rem)'}}>"{groupName}"</p>
    </div>
    <p className="text-sm text-primary animate-pulse">{loadingText}</p>
    <div className="w-full bg-primary/10 h-1 overflow-hidden" style={{borderRadius: '1px'}}>
      <div className="h-full animate-pulse" style={{background: 'linear-gradient(90deg, transparent, #38bdf8, transparent)', width: '50%', animation: 'shimmer 2s infinite'}} />
    </div>
    <a href={`https://basescan.org/tx/${txHash}`} target="_blank" rel="noreferrer" className="block text-[10px] opacity-40 hover:opacity-80 transition-opacity">
      TX: {txHash.slice(0, 10)}...{txHash.slice(-8)} ↗
    </a>
  </div>
);

const ResultPanel = ({ result, onReset }: { result: ZeitgeistResult; onReset: () => void }) => {
  const ageHours = Math.floor((Date.now() / 1000 - result.generatedAt) / 3_600);

  const handleShare = async () => {
    const shareText = `VibeCheck — ${result.groupName}\n\nDiagnosis: ${result.moodHeadline}\n\nTLDR: ${result.tldr}\n\nPowered by VibeCheck · built on Base`;

    if (navigator.share && result.imageUrl) {
      try {
        const response = await fetch(result.imageUrl);
        const blob = await response.blob();
        const file = new File([blob], `vibecheck-${result.groupName.replace(/\s+/g, "-").toLowerCase()}.png`, { type: blob.type });

        await navigator.share({
          title: `VibeCheck: ${result.groupName}`,
          text: shareText,
          files: [file],
        });
      } catch (err) {
        // Web Share failed, fall back to clipboard
        navigator.clipboard.writeText(shareText);
        notification.success("Copied to clipboard!");
      }
    } else {
      navigator.clipboard.writeText(shareText);
      notification.success("Copied to clipboard!");
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between border-b pb-4" style={{borderColor: 'oklch(var(--vc-primary) / 0.2)'}}>
        <div>
          <p className="text-[10px] uppercase tracking-[0.2em] opacity-40 mb-1">
            Vibe #{result.generatedAt.toString().slice(-4)}
          </p>
          <h2 style={{fontSize: 'clamp(1.5rem, 5vw, 2.5rem)', fontWeight: 900, fontStyle: 'italic', color: '#ffffff'}}>{result.groupName}</h2>
        </div>
        <span className="text-[10px] opacity-40 uppercase">
          {result.cached ? `Cached ${ageHours}h` : "Live Signal"}
        </span>
      </div>

      {result.lowConfidence ? (
        <div className="border border-yellow-500/30 bg-yellow-500/10 p-3 text-xs text-yellow-300">
          Low confidence — not enough fresh signal found. Take with extra salt.
        </div>
      ) : null}

      {result.imageUrl ? (
        <div className="relative border-2" style={{borderColor: 'oklch(var(--vc-primary) / 0.2)'}}>
          <Image
            src={result.imageUrl}
            alt={`Vibe snapshot of ${result.groupName}`}
            width={1024}
            height={1024}
            unoptimized
            className="w-full"
            priority
          />
          <a
            href={result.imageUrl}
            download={`vibecheck-${result.groupName.replace(/\s+/g, "-").toLowerCase()}.png`}
            className="absolute top-2 right-2 text-[10px] bg-black/80 border px-2 py-1 hover:opacity-80 transition-colors"
            style={{borderColor: 'oklch(var(--vc-primary) / 0.3)', color: 'var(--vc-primary-hex)'}}
          >
            Download
          </a>
        </div>
      ) : null}

      <div>
        <p style={{fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.2em', color: 'var(--vc-primary-hex)', marginBottom: '8px', opacity: 0.7}}>Diagnosis</p>
        <p style={{fontSize: 'clamp(1.2rem, 4vw, 1.8rem)', fontWeight: 700, color: 'var(--vc-primary-hex)', fontStyle: 'italic', lineHeight: 1.3}}>"{result.moodHeadline}"</p>
      </div>

      {result.signals.length > 0 ? (
        <div>
          <p style={{fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.2em', color: 'var(--vc-primary-hex)', marginBottom: '12px', opacity: 0.7}}>Signals</p>
          <ul style={{display: 'flex', flexDirection: 'column', gap: '10px'}}>
            {result.signals.map((s, i) => (
              <li key={i} className="signal-item" style={{display: 'flex', gap: '14px', fontSize: 'clamp(0.9rem, 2.5vw, 1.05rem)', lineHeight: 1.6}}>
                <span style={{color: 'var(--vc-primary-hex)', fontFamily: 'Space Mono, monospace', flexShrink: 0}}>0{i + 1}</span>
                <span style={{color: '#e0f2fe'}}>{s}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div style={{borderLeft: '2px solid oklch(var(--vc-primary) / 0.3)', paddingLeft: '16px', background: 'oklch(var(--vc-primary) / 0.05)', padding: '12px 16px'}}>
        <p style={{fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.2em', color: 'var(--vc-primary-hex)', marginBottom: '6px', opacity: 0.7}}>TLDR</p>
        <p style={{fontSize: 'clamp(0.95rem, 2.5vw, 1.05rem)', lineHeight: 1.7, color: '#e0f2fe', fontStyle: 'italic'}}>"{result.tldr}"</p>
      </div>

      <div style={{display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingTop: '16px', borderTop: '1px solid oklch(var(--vc-primary) / 0.2)', gap: '8px', flexWrap: 'wrap'}}>
        <div style={{display: 'flex', gap: '8px', flexWrap: 'wrap'}}>
          <button
            style={{background: 'var(--vc-primary-hex)', color: '#000', padding: '8px 20px', fontWeight: 700, fontSize: '0.85rem', border: 'none', cursor: 'pointer'}}
            onClick={onReset}
          >
            New Scan
          </button>
          <button
            style={{background: 'transparent', color: 'var(--vc-primary-hex)', padding: '8px 20px', fontWeight: 700, fontSize: '0.85rem', border: '1px solid oklch(var(--vc-primary) / 0.4)', cursor: 'pointer'}}
            onClick={handleShare}
          >
            Share
          </button>
        </div>
        <a
          style={{fontSize: '10px', color: 'var(--vc-primary-hex)', opacity: 0.6, textTransform: 'uppercase', letterSpacing: '0.1em'}}
          href={`https://basescan.org/tx/${result.txHash}`}
          target="_blank"
          rel="noreferrer"
        >
          Paid in {result.isClawdPayment ? "CLAWD" : "ETH"} · Verify
        </a>
      </div>
    </div>
  );
};

export default Home;
