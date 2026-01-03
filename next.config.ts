import type { NextConfig } from "next";

const config: NextConfig = {
  cacheComponents: true,
  output: "standalone",
  reactCompiler: true,
  async redirects() {
    return [{ destination: "/", permanent: true, source: "/home" }];
  },
  async rewrites() {
    return [{ destination: "/home", source: "/" }];
  },
};

export default config;
