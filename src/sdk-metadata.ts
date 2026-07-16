import { VERSION } from "./version.js";

/**
 * SDK identity triple threaded into `OpenBoxConfig.resolve({ sdkEngine,
 * sdkLanguage, sdkVersion })` so every governance request's signed
 * `User-Agent`/SDK-identifier header reads `openbox-copilotkit-typescript-vX`
 * instead of the base SDK's own default identity.
 */
export const SDK_METADATA = {
  engine: "copilotkit",
  language: "typescript",
  version: VERSION
} as const;
