import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    react: "src/react.ts",
    otel: "src/otel-entry.ts",
  },
  format: ["cjs", "esm"],
  dts: true,
  splitting: true,
  clean: true,
  minify: true,
  external: ["react", "@opentelemetry/api"],
});
