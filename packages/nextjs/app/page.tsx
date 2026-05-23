"use strict";

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
  | {
      status: "result";
      result: ZeitgeistResult;
    }
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

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (pipeline.status === "loading") {
      const t = setInterval(() => {
        setLoadingTextIndex(prev => (prev + 1) % LOADING_STATES.length);
      }, 3000);
      return () => clearInterval(t);
    }
  }, [pipeline.status]);

  const { data: ethBalance } = useBalance({
    address: connectedAddress,
  });

  const { data: clawdBalance } = useBalance({
    address: connectedAddress,
    token: CLAWD_ADDRESS,
  });

  const { data: requiredEth } = useScaffoldReadContract({
    contractName: "ZeitgeistPayment",
    functionName: "requiredEth",
  });

  const { data: requiredClawd } = useScaffoldReadContract({
    contractName: "ZeitgeistPayment",
    functionName: "requiredClawd",
  });

  const { data: clawdAllowance } = useReadContract({
    address: CLAWD_ADDRESS,
    abi: CLAWD_ABI,
    functionName: "allowance",
    args: [connectedAddress as AddressType, ZEITGEIST_PAYMENT_ADDRESS],
    query: {
      enabled: !!connectedAddress && paymentMode === "CLAWD",
    },
  });

  const { writeContractAsync: writeApprove } = useWriteContract();
  const { writeContractAsync: writePayment } = useScaffoldWriteContract("ZeitgeistPayment");

  const ethRequiredFormatted = requiredEth ? formatEther(requiredEth) : "0.00012";
  const clawdRequiredFormatted = requiredClawd ? formatUnits(requiredClawd, 18) : "5000";
  const ethBalanceFormatted = ethBalance ? Number(formatEther(ethBalance.value)).toFixed(4) : "0.0000";
  const clawdBalanceFormatted = clawdBalance ? Number(formatUnits(clawdBalance.value, 18)).toLocaleString() : "0";

  const insufficientFunds = useMemo(() => {
    if (!isConnected || onWrongNetwork) return false;
    if (paymentMode === "ETH") {
      return ethBalance ? ethBalance.value < (requiredEth ?? 0n) : true;
    } else {
      return clawdBalance ? clawdBalance.value < (requiredClawd ?? 0n) : true;
    }
  }, [isConnected, onWrongNetwork, paymentMode, ethBalance, requiredEth, clawdBalance, requiredClawd]);

  const needsApproval = useMemo(() => {
    if (paymentMode !== "CLAWD" || !requiredClawd) return false;
    return (clawdAllowance ?? 0n) < requiredClawd;
  }, [paymentMode, clawdAllowance, requiredClawd]);

  const pollResult = useCallback(async (txHash: `0x${string}`) => {
    try {
      const res = await fetch(`/api/zeitgeist?txHash=${txHash}`);
      if (res.status === 200) {
        const data = await res.json();
        setPipeline({ status: "result", result: data });
        if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
      }
    } catch (e) {
      console.error("Poll error", e);
    }
  }, []);

  const onSubmit = async () => {
    if (!groupName.trim()) return;
    setPipeline({ status: "submitting" });

    try {
      let txHash: `0x${string}`;
      if (paymentMode === "ETH") {
        txHash = await writePayment({
          functionName: "queryETH",
          args: [groupName],
          value: requiredEth,
        });
      } else {
        txHash = await writePayment({
          functionName: "queryCLAWD",
          args: [groupName],
        });
      }

      setPipeline({ status: "loading", txHash });
      openMobileWallet();

      pollIntervalRef.current = setInterval(() => pollResult(txHash), POLL_INTERVAL_MS);
    } catch (e: any) {
      console.error(e);
      const message = getParsedErrorWithAllAbis(e);
      notification.error(message);
      setPipeline({ status: "input" });
    }
  };

  const onApprove = async () => {
    if (!requiredClawd) return;
    setApproveSubmitting(true);
    try {
      const txHash = await writeApprove({
        address: CLAWD_ADDRESS,
        abi: CLAWD_ABI,
        functionName: "approve",
        args: [ZEITGEIST_PAYMENT_ADDRESS, requiredClawd * 100n],
      });
      notification.success("Approval transaction sent");
      setApproveCooldownUntil(Date.now() + APPROVE_COOLDOWN_MS);
      approveFailsafeRef.current = setTimeout(() => setApproveSubmitting(false), 15000);
    } catch (e: any) {
      console.error(e);
      notification.error(getParsedErrorWithAllAbis(e));
      setApproveSubmitting(false);
    }
  };

  const inApproveCooldown = now < approveCooldownUntil;
  const approveSecondsLeft = Math.ceil((approveCooldownUntil - now) / 1000);

  return (
    <div className="flex items-center flex-col flex-grow pt-4 pb-12 px-4 font-serif">
      <div className="flex flex-col items-center text-center max-w-2xl w-full">
        <div className="mb-2">
          <Image src="/home/ubuntu/clawd_icon_blue.png" alt="📡" width={64} height={64} className="opacity-90" />
        </div>
        <h1 className="text-7xl font-black tracking-tighter text-white mb-0 italic">VibeCheck</h1>
        <div className="w-full h-1 bg-gradient-to-r from-transparent via-primary to-transparent mt-2 mb-1 opacity-50"></div>
        <div className="w-full h-0.5 bg-gradient-to-r from-transparent via-primary to-transparent mb-1 opacity-30"></div>
        <div className="w-full h-px bg-gradient-to-r from-transparent via-primary to-transparent mb-4 opacity-20"></div>
        
        <p className="text-lg opacity-80 mb-6 italic">
          Diagnosing the collective unconscious since today.
        </p>

        <section className="bg-base-100 border border-primary/30 rounded-sm p-8 w-full shadow-2xl shadow-primary/5">
          {pipeline.status === "input" || pipeline.status === "submitting" ? (
            <InputPanel
              groupName={groupName}
              setGroupName={setGroupName}
              paymentMode={paymentMode}
              setPaymentMode={setPaymentMode}
              isConnected={isConnected}
              onWrongNetwork={onWrongNetwork}
              onSwitchChain={() => switchChain?.({ chainId: base.id })}
              isSwitchingChain={isSwitchingChain}
              ethRequiredFormatted={ethRequiredFormatted}
              clawdRequiredFormatted={clawdRequiredFormatted}
              ethBalanceFormatted={ethBalanceFormatted}
              clawdBalanceFormatted={clawdBalanceFormatted}
              insufficientFunds={insufficientFunds}
              needsApproval={needsApproval}
              clawdAllowance={clawdAllowance ?? 0n}
              clawdDecimals={18}
              requiredClawd={requiredClawd ?? 0n}
              onApprove={onApprove}
              approveSubmitting={approveSubmitting}
              inApproveCooldown={inApproveCooldown}
              approveSecondsLeft={approveSecondsLeft}
              onSubmit={onSubmit}
              submitting={pipeline.status === "submitting"}
            />
          ) : pipeline.status === "loading" ? (
            <LoadingPanel
              groupName={groupName}
              loadingText={LOADING_STATES[loadingTextIndex]}
              txHash={pipeline.txHash}
            />
          ) : pipeline.status === "result" ? (
            <ResultPanel result={pipeline.result} onReset={() => setPipeline({ status: "input" })} />
          ) : null}
        </section>

        <div className="mt-8 flex flex-col items-center gap-2 text-xs opacity-40 font-mono">
          <div className="flex gap-4">
            <a href={`https://basescan.org/address/${ZEITGEIST_PAYMENT_ADDRESS}`} target="_blank" rel="noreferrer" className="hover:text-primary transition-colors">
              Contract: {ZEITGEIST_PAYMENT_ADDRESS.slice(0,6)}...{ZEITGEIST_PAYMENT_ADDRESS.slice(-4)}
            </a>
            <a href={`https://basescan.org/address/${CLAWD_ADDRESS}`} target="_blank" rel="noreferrer" className="hover:text-primary transition-colors">
              CLAWD: {CLAWD_ADDRESS.slice(0,6)}...{CLAWD_ADDRESS.slice(-4)}
            </a>
          </div>
          <div className="flex items-center gap-2 mt-4">
            <span className="w-2 h-2 rounded-full bg-primary animate-pulse"></span>
            <span>VIBECHECK v1.0.0 / CONSCIOUSNESS NETWORK ONLINE</span>
          </div>
        </div>
      </div>
    </div>
  );
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
}: any) => {
  const submitDisabled =
    !isConnected ||
    onWrongNetwork ||
    !groupName.trim() ||
    submitting ||
    insufficientFunds ||
    (paymentMode === "CLAWD" && (needsApproval || approveSubmitting || inApproveCooldown));

  return (
    <div className="space-y-8">
      <div className="text-center">
        <h2 className="text-3xl font-bold mb-4 text-white">Check the vibe of...</h2>
        <input
          type="text"
          value={groupName}
          onChange={e => setGroupName(e.target.value)}
          placeholder='e.g. "farcaster maxis", "doomer programmers", "finance bros"'
          maxLength={120}
          className="input input-bordered w-full bg-black/40 border-primary/20 focus:border-primary/60 text-center text-xl h-16 rounded-none font-mono"
        />
      </div>

      <div className="pt-4">
        <div className="flex items-center justify-between mb-3 px-1">
          <span className="text-xs uppercase tracking-widest opacity-60">Transmission Fee</span>
          <span className="text-xs opacity-60 font-mono">5,000 CLAWD / ~$0.25 ETH</span>
        </div>
        <div className="join w-full rounded-none border border-primary/20">
          <button
            type="button"
            className={`btn join-item flex-1 rounded-none border-none ${paymentMode === "ETH" ? "bg-primary text-black" : "bg-transparent text-primary/60 hover:bg-primary/10"}`}
            onClick={() => setPaymentMode("ETH")}
          >
            ETH
          </button>
          <button
            type="button"
            className={`btn join-item flex-1 rounded-none border-none flex items-center justify-center gap-2 ${paymentMode === "CLAWD" ? "bg-primary text-black" : "bg-transparent text-primary/60 hover:bg-primary/10"}`}
            onClick={() => setPaymentMode("CLAWD")}
          >
            <Image src="/home/ubuntu/clawd_icon_blue.png" alt="" width={18} height={18} className={paymentMode === "CLAWD" ? "invert" : ""} />
            CLAWD
          </button>
        </div>
        <div className="mt-4 flex items-center justify-between text-xs font-mono opacity-60 px-1">
          <span>
            {paymentMode === "ETH" ? `~${ethRequiredFormatted} ETH` : `${clawdRequiredFormatted} CLAWD`}
          </span>
          <span>
            Bal: {paymentMode === "ETH" ? `${ethBalanceFormatted} ETH` : `${clawdBalanceFormatted} CLAWD`}
          </span>
        </div>
      </div>

      <div className="pt-4">
        {!isConnected ? (
          <div className="p-4 border border-dashed border-primary/30 text-center text-sm opacity-60">
            Connect wallet to transmit
          </div>
        ) : onWrongNetwork ? (
          <button type="button" className="btn btn-warning w-full rounded-none" onClick={onSwitchChain} disabled={isSwitchingChain}>
            {isSwitchingChain ? "Switching…" : "Switch to Base"}
          </button>
        ) : paymentMode === "CLAWD" && needsApproval ? (
          <button
            type="button"
            className="btn bg-primary text-black hover:bg-primary/80 w-full rounded-none border-none"
            onClick={onApprove}
            disabled={approveSubmitting || inApproveCooldown || insufficientFunds}
          >
            {approveSubmitting
              ? "Approving…"
              : inApproveCooldown
                ? `Ready in ${approveSecondsLeft}s`
                : `Approve CLAWD`}
          </button>
        ) : (
          <button type="button" className="btn bg-primary text-black hover:bg-primary/80 w-full rounded-none border-none text-lg h-16" onClick={onSubmit} disabled={submitDisabled}>
            {submitting
              ? "Transmitting..."
              : insufficientFunds
                ? `Insufficient ${paymentMode}`
                : !groupName.trim()
                  ? "Input target"
                  : `Check Vibe →`}
          </button>
        )}
      </div>

      <p className="text-[10px] text-center opacity-40 leading-relaxed font-mono uppercase tracking-tighter">
        Real-time synthesis from Reddit, Farcaster, YouTube, and the web. Results cached for 24h.
      </p>
    </div>
  );
};

const LoadingPanel = ({ groupName, loadingText, txHash }: any) => (
  <div className="space-y-8 text-center py-12 font-mono">
    <div className="text-6xl animate-pulse text-primary">📡</div>
    <div>
      <p className="text-xs opacity-40 uppercase tracking-widest">Diagnosing</p>
      <p className="text-3xl font-bold mt-2 text-white italic">"{groupName}"</p>
    </div>
    <p className="text-sm text-primary animate-pulse">{loadingText}</p>
    <div className="w-full bg-primary/10 h-1 mt-8">
      <div className="bg-primary h-full animate-[progress_2s_ease-in-out_infinite]" style={{width: '30%'}}></div>
    </div>
    <a href={`https://basescan.org/tx/${txHash}`} target="_blank" rel="noreferrer" className="block text-[10px] opacity-40 hover:opacity-100 transition-opacity">
      TX: {txHash.slice(0,10)}...{txHash.slice(-8)} ↗
    </a>
  </div>
);

const ResultPanel = ({ result, onReset }: any) => {
  const ageHours = Math.floor((Date.now() / 1000 - result.generatedAt) / 3_600);
  return (
    <div className="space-y-8 text-left">
      <div className="flex items-end justify-between border-b border-primary/20 pb-4">
        <div>
          <p className="text-[10px] uppercase tracking-[0.2em] opacity-40 mb-1">Vibe ID: #{result.generatedAt.toString().slice(-4)}</p>
          <h2 className="text-4xl font-black italic text-white">{result.groupName}</h2>
        </div>
        <span className="text-[10px] font-mono opacity-40 uppercase">{result.cached ? `Cached ${ageHours}h` : "Live Signal"}</span>
      </div>

      {result.imageUrl && (
        <div className="relative border-4 border-black shadow-[0_0_20px_rgba(56,189,248,0.1)]">
          <Image src={result.imageUrl} alt="" width={1024} height={1024} unoptimized className="w-full grayscale-[0.2] contrast-[1.1]" />
          <div className="absolute inset-0 pointer-events-none bg-gradient-to-t from-black/60 to-transparent"></div>
        </div>
      )}

      <div className="space-y-6">
        <div>
          <p className="text-[10px] uppercase tracking-[0.2em] opacity-40 mb-2">Diagnosis</p>
          <p className="text-2xl font-bold text-primary leading-tight italic">"{result.moodHeadline}"</p>
        </div>

        <div>
          <p className="text-[10px] uppercase tracking-[0.2em] opacity-40 mb-3">Signals</p>
          <ul className="space-y-3">
            {result.signals.map((s: string, i: number) => (
              <li key={i} className="flex gap-3 text-sm leading-snug">
                <span className="text-primary font-mono">0{i+1}</span>
                <span className="opacity-80">{s}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="bg-primary/5 p-4 border-l-2 border-primary/30">
          <p className="text-[10px] uppercase tracking-[0.2em] opacity-40 mb-2">TLDR</p>
          <p className="text-sm leading-relaxed opacity-90 italic">"{result.tldr}"</p>
        </div>
      </div>

      <div className="pt-6 flex items-center justify-between">
        <button className="btn bg-primary text-black hover:bg-primary/80 rounded-none border-none px-8" onClick={onReset}>
          New Scan
        </button>
        <a className="text-[10px] font-mono opacity-40 hover:opacity-100 transition-opacity uppercase tracking-widest" href={`https://basescan.org/tx/${result.txHash}`} target="_blank" rel="noreferrer">
          Verify on-chain ↗
        </a>
      </div>
    </div>
  );
};

export default Home;
