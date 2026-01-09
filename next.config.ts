import type { NextConfig } from "next";

const config: NextConfig = {
  output: "export",
  reactCompiler: true,
  // Static export doesn't support redirects/rewrites - handled by Rust server
  trailingSlash: true,
};

export default config;
