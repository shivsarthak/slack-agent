import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The dashboard imports the agent's zod schemas from ../src/*.ts.
  turbopack: {
    root: path.join(import.meta.dirname, ".."),
  },
  experimental: {
    externalDir: true,
  },
};

export default nextConfig;
