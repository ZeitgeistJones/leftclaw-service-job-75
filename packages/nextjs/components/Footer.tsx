import React from "react";

/**
 * Site footer — minimal, no theme toggle
 */
export const Footer = () => {
  return (
    <div className="min-h-0 py-5 px-1 mb-4 lg:mb-0">
      <div className="w-full">
        <ul className="menu menu-horizontal w-full">
          <div className="flex justify-center items-center gap-2 text-sm w-full">
            <div className="text-center opacity-60">VibeCheck · diagnosing the collective unconscious since today · built on Base</div>
          </div>
        </ul>
      </div>
    </div>
  );
};
