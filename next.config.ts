import type { NextConfig } from "next";

const apiPort = Number(process.env.API_PORT ?? 4000);
if (!Number.isInteger(apiPort) || apiPort < 1 || apiPort > 65535) throw new Error('Invalid local API_PORT');

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      { source: "/api/:path*", destination: `http://127.0.0.1:${apiPort}/api/:path*` },
    ];
  },
};

export default nextConfig;
