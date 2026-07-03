import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  turbopack: {
    root: __dirname,
  },
  serverExternalPackages: ["@copilotkit/runtime"],
  env: {
    NEXT_PUBLIC_COPILOTKIT_THREADS_ENABLED: process.env.COPILOTKIT_LICENSE_TOKEN
      ? "true"
      : "false",
  },
  typescript: {
    // CrewAIAgent type mismatch with CopilotRuntime — pending upstream fix in @copilotkit/runtime
    ignoreBuildErrors: true,
  },
};

export default nextConfig;
