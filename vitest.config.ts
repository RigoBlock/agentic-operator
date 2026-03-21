import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
    server: {
      deps: {
        // Force Vite to bundle WDK's sodium dependency chain instead of leaving
        // them as external Node.js imports. This lets Vite's resolve.alias work
        // on the nested CJS imports (sodium-universal → sodium-native), fixing
        // the ESM named-import-from-CJS interop issue.
        inline: [
          "@tetherto/wdk-wallet-evm",
          "@tetherto/wdk-wallet",
          "@tetherto/wdk-secret-manager",
          "sodium-universal",
          "sodium-native",
          "sodium-javascript",
        ],
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "sodium-universal": path.resolve(__dirname, "node_modules/sodium-javascript"),
      "sodium-native": path.resolve(__dirname, "node_modules/sodium-javascript"),
    },
  },
});
