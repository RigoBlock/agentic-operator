import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    alias: {
      "@": path.resolve(__dirname, "./src"),
      // The SDK's ESM build omits .js extensions on relative imports, which
      // breaks native Node/Vitest resolution. Load the CJS build in tests
      // while wrangler's esbuild still bundles the ESM build for the Worker.
      "@gmx-io/sdk": path.resolve(__dirname, "./node_modules/@gmx-io/sdk/build/cjs/src/clients/v1/index.js"),
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
