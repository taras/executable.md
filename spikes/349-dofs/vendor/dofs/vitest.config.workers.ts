import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Workerd-backed runner. Same .test.ts files as the node project, but
// withDB resolves to the Durable Object-backed implementation via the
// alias below.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./tests/wrangler.jsonc" },
    }),
  ],
  resolve: {
    // Match any relative import that lands on src/fs/with-db.js so
    // tests under src/fs/, src/, and src/sync/ all resolve to the
    // workerd-backed implementation regardless of their depth.
    alias: [
      {
        find: /^.*\/with-db\.js$/,
        replacement: new URL("./src/fs/with-db.workers.ts", import.meta.url).pathname,
      },
    ],
  },
  test: {
    globals: true,
    include: ["src/**/*.test.ts"],
    // testing.test.ts exercises SQLiteTestStorage directly — the
    // node:sqlite-backed fixture has no analogue under workerd, so
    // the test is meaningful only against the real node runtime.
    // All other tests run under both backends; provider/provider-fd
    // use a withProvider helper that delegates to withDB, which the
    // workers config aliases to a DO-backed implementation.
    exclude: ["src/testing.test.ts"],
  },
});
