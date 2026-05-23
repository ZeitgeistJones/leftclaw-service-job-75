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
    const url = `${apiBase}/api/zeitgeist?txHash=${pipeline.txHash}&groupName=${encodeURIComponent(groupName)}`;
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
  }, [pipeline, groupName]);

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
      <div className="w-full max-w-xl">
        {/* Header */}
        <header className="mb-8 text-center">
          <div className="mb-3">
            <Image src="/clawd_icon_blue.png" alt="VibeCheck" width={56} height={56} className="mx-auto opacity-90" />
          </div>
          <h1 style={{fontFamily: '"Playfair Display", serif', fontWeight: 900, fontStyle: 'italic'}} className="text-7xl text-white mb-2 leading-none">VibeCheck</h1>
          <div className="w-full h-[3px] bg-primary opacity-70 mb-[3px]" />
          <div className="w-full h-[2px] bg-primary opacity-45 mb-[2px]" />
          <div className="w-full h-px bg-primary opacity-25 mb-4" />
          <p className="text-xs opacity-60 tracking-[0.15em] uppercase">
            Diagnosing the collective unconscious since today.
          </p>
        </header>

        {/* Main card */}
        <section className="border border-primary/40 bg-black/70 p-6 sm:p-8 rounded-none" style={{boxShadow: '0 0 20px rgba(56,189,248,0.12), inset 0 0 20px rgba(56,189,248,0.03)'}}>
          {pipeline.status === "input" || pipeline.status === "submitting" ? (
            <InputPanel
              groupName={groupName}
              setGroupName={setGroupName}
              paymentMode={paymentMode}
              setPaymentMode={setPaymentMode}
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
        <div className="relative w-full h-40 mt-8 overflow-hidden">
          {/* Grid floor */}
          <div className="absolute bottom-0 left-0 right-0 h-24" style={{backgroundImage: 'linear-gradient(rgba(56,189,248,0.2) 1px, transparent 1px), linear-gradient(90deg, rgba(56,189,248,0.2) 1px, transparent 1px)', backgroundSize: '40px 20px', transform: 'perspective(180px) rotateX(50deg)', transformOrigin: 'bottom center'}} />
          {/* Sun */}
          <div className="absolute left-1/2 -translate-x-1/2" style={{bottom: '40px', width: '80px', height: '40px', background: 'linear-gradient(to bottom, #ffffff, #38bdf8)', clipPath: 'ellipse(50% 50% at 50% 100%)', overflow: 'hidden'}}>
            <div style={{position:'absolute',inset:0,backgroundImage:'repeating-linear-gradient(to bottom, transparent 0px, transparent 5px, #020c18 5px, #020c18 7px)'}} />
          </div>
          {/* Mountains left */}
          <div className="absolute bottom-10 left-0" style={{width:'45%', height:'60px', background:'rgba(56,189,248,0.15)', clipPath:'polygon(0% 100%, 20% 20%, 40% 70%, 60% 10%, 80% 50%, 100% 100%)'}} />
          {/* Mountains right */}
          <div className="absolute bottom-10 right-0" style={{width:'45%', height:'60px', background:'rgba(56,189,248,0.15)', clipPath:'polygon(0% 100%, 20% 50%, 40% 10%, 60% 70%, 80% 20%, 100% 100%)'}} />
        </div>

        {/* Footer */}
        <section className="mt-4 text-center text-[10px] opacity-40 font-mono space-y-1">
          <p>
            Contract:{" "}
            <a href={`https://basescan.org/address/${ZEITGEIST_PAYMENT_ADDRESS}`} target="_blank" rel="noreferrer" className="hover:opacity-100 underline underline-offset-2">
              {ZEITGEIST_PAYMENT_ADDRESS.slice(0, 6)}...{ZEITGEIST_PAYMENT_ADDRESS.slice(-4)}
            </a>
            {" · "}
            CLAWD:{" "}
            <a href={`https://basescan.org/address/${CLAWD_ADDRESS}`} target="_blank" rel="noreferrer" className="hover:opacity-100 underline underline-offset-2">
              {CLAWD_ADDRESS.slice(0, 6)}...{CLAWD_ADDRESS.slice(-4)}
            </a>
          </p>
          <div className="flex items-center justify-center gap-2 mt-3">
            <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
            <span className="uppercase tracking-[0.15em]">VIBECHECK v1.0.0 · CONSCIOUSNESS NETWORK ONLINE</span>
          </div>
        </section>
      </div>
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
};

const InputPanel = ({
  groupName,
  setGroupName,
  paymentMode,
  setPaymentMode,
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
        <p className="text-2xl font-bold text-white mb-4">Check the vibe of...</p>
        <input
          type="text"
          value={groupName}
          onChange={e => setGroupName(e.target.value)}
          placeholder='e.g. "farcaster maxis", "doomer programmers", "finance bros"'
          maxLength={120}
          className="w-full bg-black/60 border border-primary/30 focus:border-primary/70 outline-none px-4 py-3 text-center text-base text-white placeholder:opacity-40 font-mono"
        />
      </div>

      <div>
        <div className="flex items-center justify-between mb-2 text-xs opacity-60">
          <span className="uppercase tracking-widest">Transmission Fee</span>
          <span>5,000 CLAWD / ~$0.25 ETH</span>
        </div>
        <div className="flex border border-primary/30">
          <button
            type="button"
            className={`flex-1 py-3 text-sm font-bold transition-colors ${paymentMode === "ETH" ? "bg-primary text-black" : "bg-transparent text-primary/60 hover:bg-primary/10"}`}
            onClick={() => setPaymentMode("ETH")}
          >
            ETH
          </button>
          <button
            type="button"
            className={`flex-1 py-3 text-sm font-bold flex items-center justify-center gap-2 transition-colors ${paymentMode === "CLAWD" ? "bg-primary text-black" : "bg-transparent text-primary/60 hover:bg-primary/10"}`}
            onClick={() => setPaymentMode("CLAWD")}
          >
            <Image
              src="/clawd_icon_blue.png"
              alt=""
              width={16}
              height={16}
              className={paymentMode === "CLAWD" ? "invert" : "opacity-60"}
            />
            CLAWD
          </button>
        </div>
        <div className="mt-2 flex items-center justify-between text-xs opacity-60 px-1">
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
        <div className="border border-dashed border-primary/20 p-4 text-center text-sm opacity-50">
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
          className="w-full py-4 bg-primary text-black text-lg font-bold hover:bg-primary/80 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          onClick={onSubmit}
          disabled={submitDisabled}
        >
          {submitting
            ? "Transmitting..."
            : insufficientFunds
              ? `Insufficient ${paymentMode}`
              : !groupName.trim()
                ? "Input target"
                : "Check Vibe →"}
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
    <div className="text-5xl animate-pulse">📡</div>
    <div>
      <p className="text-xs opacity-40 uppercase tracking-widest mb-2">Diagnosing</p>
      <p className="text-2xl font-bold text-white italic">"{groupName}"</p>
    </div>
    <p className="text-sm text-primary animate-pulse">{loadingText}</p>
    <div className="w-full bg-primary/10 h-0.5">
      <div className="bg-primary h-full w-1/3 animate-[pulse_1.5s_ease-in-out_infinite]" />
    </div>
    <a href={`https://basescan.org/tx/${txHash}`} target="_blank" rel="noreferrer" className="block text-[10px] opacity-40 hover:opacity-80 transition-opacity">
      TX: {txHash.slice(0, 10)}...{txHash.slice(-8)} ↗
    </a>
  </div>
);

const ResultPanel = ({ result, onReset }: { result: ZeitgeistResult; onReset: () => void }) => {
  const ageHours = Math.floor((Date.now() / 1000 - result.generatedAt) / 3_600);
  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between border-b border-primary/20 pb-4">
        <div>
          <p className="text-[10px] uppercase tracking-[0.2em] opacity-40 mb-1">
            Vibe #{result.generatedAt.toString().slice(-4)}
          </p>
          <h2 className="text-3xl font-black italic text-white">{result.groupName}</h2>
        </div>
        <span className="text-[10px] opacity-40 uppercase">
          {result.cached ? `Cached ${ageHours}h` : "Live Signal"}
        </span>
      </div>

      {result.lowConfidence ? (
        <div className="border border-yellow-500/30 bg-yellow-500/10 p-3 text-xs text-yellow-300">
          ⚠ Low confidence — not enough fresh signal found. Take with extra salt.
        </div>
      ) : null}

      {result.imageUrl ? (
        <div className="relative border-2 border-primary/20">
          <Image
            src={result.imageUrl}
            alt={`Vibe snapshot of ${result.groupName}`}
            width={1024}
            height={1024}
            unoptimized
            className="w-full"
          />
          <a
            href={result.imageUrl}
            download={`vibecheck-${result.groupName.replace(/\s+/g, "-").toLowerCase()}.png`}
            className="absolute top-2 right-2 text-[10px] bg-black/80 border border-primary/30 text-primary px-2 py-1 hover:bg-primary/20 transition-colors"
          >
            Download
          </a>
        </div>
      ) : null}

      <div>
        <p className="text-[10px] uppercase tracking-[0.2em] opacity-40 mb-2">Diagnosis</p>
        <p className="text-xl font-bold text-primary italic">"{result.moodHeadline}"</p>
      </div>

      {result.signals.length > 0 ? (
        <div>
          <p className="text-[10px] uppercase tracking-[0.2em] opacity-40 mb-3">Signals</p>
          <ul className="space-y-2">
            {result.signals.map((s, i) => (
              <li key={i} className="flex gap-3 text-sm">
                <span className="text-primary font-mono shrink-0">0{i + 1}</span>
                <span className="opacity-80">{s}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="border-l-2 border-primary/30 pl-4 bg-primary/5 py-3">
        <p className="text-[10px] uppercase tracking-[0.2em] opacity-40 mb-1">TLDR</p>
        <p className="text-sm leading-relaxed opacity-90 italic">"{result.tldr}"</p>
      </div>

      <div className="flex items-center justify-between pt-4 border-t border-primary/20">
        <button
          className="bg-primary text-black px-6 py-2 font-bold text-sm hover:bg-primary/80 transition-colors"
          onClick={onReset}
        >
          New Scan
        </button>
        <a
          className="text-[10px] opacity-40 hover:opacity-80 transition-opacity uppercase tracking-widest"
          href={`https://basescan.org/tx/${result.txHash}`}
          target="_blank"
          rel="noreferrer"
        >
          Paid in {result.isClawdPayment ? "CLAWD" : "ETH"} · Verify ↗
        </a>
      </div>
    </div>
  );
};

export default Home;
