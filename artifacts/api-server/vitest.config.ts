import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Some local checkouts lack pg in this package's node_modules (see
// docs/OPERATIONS.md). Fall back to the copy in the pnpm store so route tests
// still load; on Vercel and fresh installs pg resolves normally and no alias
// is added.
function pg_alias(): Record<string, string> {
  try {
    createRequire(import.meta.url).resolve("pg");
    return {};
  } catch {
    const store = fileURLToPath(new URL("../../node_modules/.pnpm/pg@8.20.0/node_modules/pg", import.meta.url));
    return existsSync(store) ? { pg: store } : {};
  }
}

export default defineConfig({
  resolve: { alias: pg_alias() },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
