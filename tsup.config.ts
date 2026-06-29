import { defineConfig } from "tsup";

export default defineConfig({
  bundle: false,
  clean: true,
  dts: true,
  entry: ["src/**/*.ts"],
  format: ["esm"],
  outDir: "dist",
  platform: "node",
  sourcemap: false,
  splitting: false,
  target: "node24"
});
