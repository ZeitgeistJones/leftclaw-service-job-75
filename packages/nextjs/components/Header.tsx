"use client";

import { hardhat } from "viem/chains";
import { FaucetButton, RainbowKitCustomConnectButton } from "~~/components/scaffold-eth";
import { useTargetNetwork } from "~~/hooks/scaffold-eth";

export const menuLinks: { label: string; href: string }[] = [];
export const HeaderMenuLinks = () => null;

/**
 * Site header — wallet connect only (Acid Paper shell)
 */
export const Header = () => {
  const { targetNetwork } = useTargetNetwork();
  const isLocalNetwork = targetNetwork.id === hardhat.id;

  return (
    <div
      className="sticky lg:static top-0 navbar min-h-0 shrink-0 justify-end z-20 px-0 sm:px-2"
      style={{
        background: "transparent",
        boxShadow: "none",
        borderBottom: "1.5px solid #0A0A0A",
      }}
    >
      <div className="navbar-end grow mr-4 py-2">
        <RainbowKitCustomConnectButton />
        {isLocalNetwork && <FaucetButton />}
      </div>
    </div>
  );
};
