"use client";

import { hardhat } from "viem/chains";
import { FaucetButton, RainbowKitCustomConnectButton } from "~~/components/scaffold-eth";
import { useTargetNetwork } from "~~/hooks/scaffold-eth";

export const menuLinks: { label: string; href: string }[] = [];
export const HeaderMenuLinks = () => null;

/**
 * Site header — VibeCheck logo + wallet connect
 */
export const Header = () => {
  const { targetNetwork } = useTargetNetwork();
  const isLocalNetwork = targetNetwork.id === hardhat.id;

  return (
    <header className="sticky lg:static top-0 z-20 px-4 sm:px-6 py-3">
      <div className="flex items-center justify-between max-w-[900px] mx-auto">
        {/* Logo icon */}
        <div 
          className="flex items-center justify-center w-12 h-12 border"
          style={{ 
            borderColor: 'oklch(var(--vc-primary) / 0.5)',
            background: 'oklch(var(--vc-primary) / 0.1)'
          }}
        >
          <svg 
            viewBox="0 0 24 24" 
            className="w-7 h-7"
            style={{ color: 'var(--vc-primary-hex)' }}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          >
            {/* Stylized eye/horizon icon */}
            <ellipse cx="12" cy="12" rx="10" ry="6" />
            <path d="M2 12 C2 12, 7 6, 12 6 C17 6, 22 12, 22 12" />
            <path d="M2 12 C2 12, 7 18, 12 18 C17 18, 22 12, 22 12" />
            <line x1="4" y1="12" x2="20" y2="12" />
            <line x1="6" y1="10" x2="18" y2="10" />
            <line x1="6" y1="14" x2="18" y2="14" />
          </svg>
        </div>

        {/* Wallet */}
        <div className="flex items-center gap-2">
          <RainbowKitCustomConnectButton />
          {isLocalNetwork && <FaucetButton />}
        </div>
      </div>
    </header>
  );
};
