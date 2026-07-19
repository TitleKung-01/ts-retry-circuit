import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // We define separate projects for the Core logic and React components
    // to cleanly isolate the environment requirements for each.
    projects: [
      {
        test: {
          name: "core",
          include: ["src/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        test: {
          name: "react",
          include: ["src/**/*.test.tsx"],
          environment: "happy-dom",
        },
      },
    ],
    // Global options can be specified here
    globals: false,
  },
});
