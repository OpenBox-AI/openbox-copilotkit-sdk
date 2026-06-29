import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  output: "standalone",
  turbopack: {
    root: path.resolve(process.cwd(), "../../../.."),
  },
  serverExternalPackages: [
    "@copilotkit/runtime",
    "@openbox-ai/openbox-copilotkit",
    "@openbox-ai/openbox-mastra-sdk",
  ],
  env: {
    NEXT_PUBLIC_COPILOTKIT_THREADS_ENABLED: process.env.COPILOTKIT_LICENSE_TOKEN
      ? "true"
      : "false",
  },
  typescript: {
    // @mastra/memory beta packages have unstable types that break strict checking
    ignoreBuildErrors: true,
  },
};

export default nextConfig;
