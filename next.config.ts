import type { NextConfig } from "next";

const apiPort = Number(process.env.API_PORT ?? 4000);
if (!Number.isInteger(apiPort) || apiPort < 1 || apiPort > 65535) throw new Error('Invalid local API_PORT');
// Local smoke tests can isolate Amazon quotes without redirecting the storefront's
// catalog, account or checkout endpoints away from the regular backend.
const amazonApiPort = Number(process.env.AMAZON_QUOTES_API_PORT ?? apiPort);
if (!Number.isInteger(amazonApiPort) || amazonApiPort < 1 || amazonApiPort > 65535) throw new Error('Invalid local AMAZON_QUOTES_API_PORT');

const nextConfig: NextConfig = {
  output: "standalone",
  ...(process.env.NEXT_BUILD_DIR ? { distDir: process.env.NEXT_BUILD_DIR } : {}),
  async rewrites() {
    return [
      ...(amazonApiPort !== apiPort ? [
        { source: "/api/amazon/:path*", destination: `http://127.0.0.1:${amazonApiPort}/api/amazon/:path*` },
      ] : []),
      { source: "/api/:path*", destination: `http://127.0.0.1:${apiPort}/api/:path*` },
    ];
  },
};

export default nextConfig;
