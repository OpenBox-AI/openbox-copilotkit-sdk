import { createRequire } from "node:module";

/**
 * SDK version, sourced from `package.json` — the single source of truth for
 * the `sdkVersion` identity the base runtime attaches to every governance
 * request (see `sdk-metadata.ts`). Loaded via `createRequire` rather than a
 * `with { type: "json" }` import assertion so no `resolveJsonModule` tsconfig
 * change is needed. `tsup` (`bundle: false`) emits this file to
 * `dist/version.js`, one directory below the package root — identical to this
 * source file's own position relative to `package.json` — so the relative
 * `require("../package.json")` resolves correctly in both the source tree
 * (vitest) and the built package.
 */
const require = createRequire(import.meta.url);
const packageJson = require("../package.json") as { version: string };

export const VERSION: string = packageJson.version;
