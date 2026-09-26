import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Workspace packages point `exports` at `dist/`, which a plain `tsc` build
    // fills without non-TS assets such as `@sona/db`'s `.sql` migrations. Tests
    // resolve `@sona/*` to source so cross-package imports run against the same
    // files the typecheck covers.
    alias: [
      {
        find: /^@sona\/([a-z-]+)$/,
        replacement: fileURLToPath(new URL("./packages/$1/src/index.ts", import.meta.url)),
      },
    ],
  },
  test: {
    include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts"],
    environment: "node",
  },
});
