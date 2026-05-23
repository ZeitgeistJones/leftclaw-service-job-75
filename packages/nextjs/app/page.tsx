"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import { Address } from "@scaffold-ui/components";
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

const SUGGESTIONS = ["Jets fans", "TikTok traders", "Crypto Twitter", "F1 girlies", "doomer programmers"];

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
  // Best-effort: re-focus the most recent connected wallet via WalletConnect's
  // last-used deeplink. RainbowKit stores this; if not available, no-op.
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

  // cleanup on unmount
  useEffect(() => {
    return () => {
      if (approveFailsafeRef.current) {
        clearTimeout(approveFailsafeRef.current);
        approveFailsafeRef.current = null;
      }
    };
  }, []);

  // ------- Reads -------
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

  // ------- Writes -------
  const { writeContractAsync: approveClawd } = useWriteContract();
  const { writeContractAsync: writeQuery, isMining } = useScaffoldWriteContract({
    contractName: "ZeitgeistPayment",
  });

  // Approve cooldown timer
  useEffect(() => {
    if (approveCooldownUntil <= 0) return;
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [approveCooldownUntil]);

  const inApproveCooldown = approveCooldownUntil > now;

  // Loading text rotation
  useEffect(() => {
    if (pipeline.status !== "loading") return;
    const id = setInterval(() => {
      setLoadingTextIndex(i => (i + 1) % LOADING_STATES.length);
    }, 2_000);
    return () => clearInterval(id);
  }, [pipeline.status]);

  // Result polling
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
            message:
              body.error || "Backend not configured. The on-chain payment succeeded; the analysis service is offline.",
          });
        }
        // any other status: keep polling silently — backend may still be working
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

  // ------- Handlers -------
  const handleApprove = useCallback(async () => {
    if (!connectedAddress || needsApproval === false) return;
    setApproveSubmitting(true);
    // Failsafe: if the receipt is never observed (tx dropped, indexer lag,
    // wallet closed before signing), still re-enable the button after 60s
    // so the user is never stuck.
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
      // start mobile deep-link after a short delay so the wallet has time to surface
      setTimeout(openMobileWallet, 2_000);
      notification.success("Approval submitted. Waiting for confirmation...");
      // don't drop the cooldown until we observe receipt — handled below via useWaitFor
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
        // Send 1% over the quoted price as a slippage buffer; contract refunds excess
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
      // refresh balances after the write resolves
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

  // ------- Render helpers -------
  const formattedEthRequired = requiredEth > 0n ? Number(formatEther(requiredEth)).toFixed(6) : "—";
  const formattedClawdRequired =
    requiredClawd > 0n ? Number(formatUnits(requiredClawd, clawdDecimals)).toLocaleString() : "—";
  const formattedEthBalance = Number(formatEther(ethBalance)).toFixed(4);
  const formattedClawdBalance = Number(formatUnits(clawdBalance, clawdDecimals)).toLocaleString();

  return (
    <div className="font-sans flex flex-col items-center grow w-full px-4 pt-10 pb-24">
      <div className="w-full max-w-2xl">
        <header className="mb-10 text-center">
          <div className="text-6xl mb-4">🔮</div>
          <h1 className="font-display text-5xl font-bold tracking-tight mb-3">Zeitgeist</h1>
          <p className="text-lg opacity-80 max-w-xl mx-auto">
            Pay <span className="font-semibold">$0.25</span> in ETH or CLAWD on Base. Get an AI-synthesized snapshot of
            any cultural group — meme image plus written analysis pulled from real-time web signals.
          </p>
        </header>

        <section className="card bg-base-100 border border-base-300 shadow-center p-6 sm:p-8">
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
              <div className="alert alert-error">
                <span>{pipeline.message}</span>
              </div>
              <button className="btn btn-primary w-full" onClick={reset}>
                Back to start
              </button>
            </div>
          ) : null}
        </section>

        <section className="mt-8 text-center text-xs opacity-60">
          <p>
            Contract:{" "}
            <span className="inline-block align-middle">
              <Address address={ZEITGEIST_PAYMENT_ADDRESS} chain={base} />
            </span>
          </p>
          <p className="mt-1">
            CLAWD:{" "}
            <span className="inline-block align-middle">
              <Address address={CLAWD_ADDRESS} chain={base} />
            </span>
          </p>
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
      <label className="block">
        <span className="text-sm font-medium opacity-70">Cultural group</span>
        <input
          type="text"
          value={groupName}
          onChange={e => setGroupName(e.target.value)}
          placeholder='e.g. "Jets fans", "TikTok traders", "Crypto Twitter"'
          maxLength={120}
          className="input input-bordered w-full mt-2 font-display text-lg"
        />
        <div className="flex flex-wrap gap-1 mt-2 text-xs">
          {SUGGESTIONS.map(s => (
            <button
              key={s}
              type="button"
              className="badge badge-ghost cursor-pointer hover:badge-secondary"
              onClick={() => setGroupName(s)}
            >
              {s}
            </button>
          ))}
        </div>
      </label>

      <div>
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm font-medium opacity-70">Pay with</span>
          <span className="text-xs opacity-60">$0.25 USD per query</span>
        </div>
        <div className="join w-full">
          <button
            type="button"
            className={`btn join-item flex-1 ${paymentMode === "ETH" ? "btn-primary" : "btn-outline"}`}
            onClick={() => setPaymentMode("ETH")}
          >
            ETH
          </button>
          <button
            type="button"
            className={`btn join-item flex-1 ${paymentMode === "CLAWD" ? "btn-primary" : "btn-outline"}`}
            onClick={() => setPaymentMode("CLAWD")}
          >
            CLAWD
          </button>
        </div>
        <div className="mt-3 flex items-center justify-between text-sm">
          <span className="opacity-70">
            {paymentMode === "ETH" ? (
              <>
                ~<span className="font-mono">{ethRequiredFormatted}</span> ETH (~$0.25)
              </>
            ) : (
              <>
                <span className="font-mono">{clawdRequiredFormatted}</span> CLAWD
              </>
            )}
          </span>
          <span className="opacity-60 text-xs">
            Bal:{" "}
            <span className="font-mono">
              {paymentMode === "ETH" ? `${ethBalanceFormatted} ETH` : `${clawdBalanceFormatted} CLAWD`}
            </span>
          </span>
        </div>
        {paymentMode === "CLAWD" && requiredClawd > 0n ? (
          <p className="mt-2 text-xs opacity-60">
            Allowance:{" "}
            <span className="font-mono">{Number(formatUnits(clawdAllowance, clawdDecimals)).toLocaleString()}</span>{" "}
            CLAWD {clawdAllowance >= requiredClawd ? "✓" : "(needs approval)"}
          </p>
        ) : null}
      </div>

      {!isConnected ? (
        <div className="alert">
          <span>Connect your wallet to continue.</span>
        </div>
      ) : onWrongNetwork ? (
        <button type="button" className="btn btn-warning w-full" onClick={onSwitchChain} disabled={isSwitchingChain}>
          {isSwitchingChain ? "Switching…" : "Switch to Base"}
        </button>
      ) : paymentMode === "CLAWD" && needsApproval ? (
        <button
          type="button"
          className="btn btn-secondary w-full"
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
        <button type="button" className="btn btn-primary w-full" onClick={onSubmit} disabled={submitDisabled}>
          {submitting
            ? "Sending…"
            : insufficientFunds
              ? `Insufficient ${paymentMode}`
              : !groupName.trim()
                ? "Type a group name"
                : `Generate snapshot (~$0.25)`}
        </button>
      )}

      <p className="text-xs text-center opacity-50">
        Payment goes to a smart contract on Base. Result generation is off-chain. Cached results are returned for free
        for 24h.
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
}) => {
  return (
    <div className="space-y-6 text-center py-8">
      <div className="text-5xl animate-pulse">🔮</div>
      <div>
        <p className="text-sm opacity-60">Generating snapshot of</p>
        <p className="text-2xl font-display font-bold mt-1">{groupName}</p>
      </div>
      <p className="text-base opacity-80">{loadingText}</p>
      <a
        href={`https://basescan.org/tx/${txHash}`}
        target="_blank"
        rel="noreferrer"
        className="link text-xs opacity-60"
      >
        View payment on Basescan ↗
      </a>
      <progress className="progress progress-primary w-full" />
    </div>
  );
};

const ResultPanel = ({ result, onReset }: { result: ZeitgeistResult; onReset: () => void }) => {
  const ageHours = Math.floor((Date.now() / 1000 - result.generatedAt) / 3_600);
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs uppercase tracking-wider opacity-60">Snapshot</p>
          <h2 className="font-display text-2xl font-bold">{result.groupName}</h2>
        </div>
        {result.cached ? (
          <span className="badge badge-ghost text-xs">Cached {ageHours}h ago</span>
        ) : (
          <span className="badge badge-success text-xs">Fresh</span>
        )}
      </div>

      {result.lowConfidence ? (
        <div className="alert alert-warning text-sm">
          <span>
            ⚠ Low confidence: not enough fresh signal was found for this group. Take the analysis below with extra
            salt.
          </span>
        </div>
      ) : null}

      {result.imageUrl ? (
        <div className="relative">
          <Image
            src={result.imageUrl}
            alt={`Meme snapshot of ${result.groupName}`}
            width={1024}
            height={1024}
            unoptimized
            className="w-full rounded-lg border border-base-300"
          />
          <a
            href={result.imageUrl}
            download={`zeitgeist-${result.groupName.replace(/\s+/g, "-").toLowerCase()}.png`}
            className="btn btn-sm btn-secondary absolute top-3 right-3"
          >
            Download
          </a>
        </div>
      ) : null}

      <div>
        <p className="text-xs uppercase tracking-wider opacity-60 mb-1">Mood</p>
        <p className="font-display text-xl font-semibold">{result.moodHeadline}</p>
      </div>

      {result.signals.length > 0 ? (
        <div>
          <p className="text-xs uppercase tracking-wider opacity-60 mb-2">Signals</p>
          <ul className="list-disc pl-5 space-y-1 text-sm">
            {result.signals.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <div>
        <p className="text-xs uppercase tracking-wider opacity-60 mb-1">TLDR</p>
        <p className="text-sm leading-relaxed">{result.tldr}</p>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 pt-4 border-t border-base-300 text-xs opacity-60">
        <span>
          Paid in {result.isClawdPayment ? "CLAWD" : "ETH"} ·{" "}
          <a className="link" href={`https://basescan.org/tx/${result.txHash}`} target="_blank" rel="noreferrer">
            tx ↗
          </a>
        </span>
        <button className="btn btn-primary btn-sm" onClick={onReset}>
          Generate another
        </button>
      </div>
    </div>
  );
};

export default Home;
