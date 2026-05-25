import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  devIndicators: false,
  typescript: {
    ignoreBuildErrors: true
  },
  eslint: {
    ignoreDuringBuilds: true
  },
  webpack: config => { 
    config.resolve.fallback = { fs: false, net: false, tls: false }; 
    config.externals.push("pino-pretty", "lokijs", "encoding"); 
    // Redirect wagmi/chains to our shim that re-exports from viem/chains
    config.resolve.alias = {
      ...config.resolve.alias,
      'wagmi/chains': path.resolve(__dirname, 'shims/wagmi-chains.ts'),
    };
    return config; 
  }
};
const isIpfs = process.env.NEXT_PUBLIC_IPFS_BUILD === "true";
if (isIpfs) {
  nextConfig.output = "export";
  nextConfig.trailingSlash = true;
  nextConfig.images = {
    unoptimized: true,
  };
}
module.exports = nextConfig;
