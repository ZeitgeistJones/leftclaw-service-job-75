"use client";

import { useEffect, useState } from "react";

type ColorPreset = {
  name: string;
  primary: string;
  background: string;
};

const PRESETS: ColorPreset[] = [
  { name: "VibeCheck", primary: "#38bdf8", background: "#020c18" },
  { name: "Terminal", primary: "#22c55e", background: "#0a0a0a" },
  { name: "Sunset", primary: "#f97316", background: "#1a0a0a" },
  { name: "Purple Haze", primary: "#a855f7", background: "#0f0520" },
  { name: "Gold Rush", primary: "#eab308", background: "#0f0a00" },
  { name: "Rose", primary: "#f43f5e", background: "#150508" },
  { name: "Cyan", primary: "#06b6d4", background: "#001a1f" },
  { name: "Lime", primary: "#84cc16", background: "#0a1000" },
];

const STORAGE_KEY = "vibecheck-colors";

function hexToHsl(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;

  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r:
        h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
        break;
      case g:
        h = ((b - r) / d + 2) / 6;
        break;
      case b:
        h = ((r - g) / d + 4) / 6;
        break;
    }
  }

  return `${Math.round(h * 360)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%`;
}

export function ColorCustomizer() {
  const [isOpen, setIsOpen] = useState(false);
  const [primary, setPrimary] = useState("#38bdf8");
  const [background, setBackground] = useState("#020c18");

  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      try {
        const parsed = JSON.parse(stored);
        if (parsed.primary) setPrimary(parsed.primary);
        if (parsed.background) setBackground(parsed.background);
      } catch {
        // ignore
      }
    }
  }, []);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ primary, background }));
    document.documentElement.style.setProperty("--vc-primary", hexToHsl(primary));
    document.documentElement.style.setProperty("--vc-primary-hex", primary);
    document.documentElement.style.setProperty("--vc-bg", hexToHsl(background));
    document.documentElement.style.setProperty("--vc-bg-hex", background);
    document.documentElement.style.setProperty("--vc-card", hexToHsl(adjustBrightness(background, 15)));
    document.documentElement.style.setProperty("--card-bg", adjustBrightness(background, 15));
  }, [primary, background]);

  const applyPreset = (preset: ColorPreset) => {
    setPrimary(preset.primary);
    setBackground(preset.background);
  };

  return (
    <div className="fixed bottom-4 right-4 z-50">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="w-10 h-10 flex items-center justify-center transition-all hover:scale-110"
        style={{
          background: "var(--vc-card)",
          border: "1px solid var(--vc-primary-hex)",
          color: "var(--vc-primary-hex)",
        }}
        aria-label="Customize colors"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="3" />
          <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
        </svg>
      </button>

      {isOpen && (
        <div
          className="absolute bottom-12 right-0 p-4 space-y-4 min-w-[200px] backdrop-blur-sm"
          style={{
            background: "var(--vc-bg-hex)",
            border: "1px solid var(--vc-primary-hex)",
            boxShadow: "0 0 30px var(--vc-primary-hex)",
          }}
        >
          <div className="text-xs uppercase tracking-widest" style={{ color: "var(--vc-primary-hex)", opacity: 0.6 }}>
            Customize Theme
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <label className="text-xs" style={{ color: "var(--vc-primary-hex)" }}>
                Accent
              </label>
              <input
                type="color"
                value={primary}
                onChange={e => setPrimary(e.target.value)}
                className="w-8 h-8 cursor-pointer border-0 p-0"
                style={{ background: "transparent" }}
              />
            </div>
            <div className="flex items-center justify-between gap-3">
              <label className="text-xs" style={{ color: "var(--vc-primary-hex)" }}>
                Background
              </label>
              <input
                type="color"
                value={background}
                onChange={e => setBackground(e.target.value)}
                className="w-8 h-8 cursor-pointer border-0 p-0"
                style={{ background: "transparent" }}
              />
            </div>
          </div>

          <div className="space-y-2">
            <div className="text-xs uppercase tracking-wider" style={{ color: "var(--vc-primary-hex)", opacity: 0.5 }}>
              Presets
            </div>
            <div className="grid grid-cols-4 gap-1">
              {PRESETS.map(preset => (
                <button
                  key={preset.name}
                  onClick={() => applyPreset(preset)}
                  className="w-8 h-8 transition-transform hover:scale-110"
                  style={{
                    background: `linear-gradient(135deg, ${preset.background}, ${preset.primary})`,
                    border:
                      primary === preset.primary && background === preset.background
                        ? `2px solid white`
                        : "1px solid rgba(255,255,255,0.2)",
                  }}
                  title={preset.name}
                />
              ))}
            </div>
          </div>

          <button
            onClick={() => {
              setPrimary("#38bdf8");
              setBackground("#020c18");
            }}
            className="w-full text-xs py-2 transition-colors"
            style={{
              background: "transparent",
              border: "1px solid var(--vc-primary-hex)",
              color: "var(--vc-primary-hex)",
            }}
          >
            Reset to Default
          </button>
        </div>
      )}
    </div>
  );
}

function adjustBrightness(hex: string, percent: number): string {
  const num = parseInt(hex.slice(1), 16);
  const r = Math.min(255, Math.max(0, (num >> 16) + percent));
  const g = Math.min(255, Math.max(0, ((num >> 8) & 0x00ff) + percent));
  const b = Math.min(255, Math.max(0, (num & 0x0000ff) + percent));
  return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
}
