import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-plugin";

/**
 * The workerd suite.
 *
 * These tests run against a real Durable Object namespace, real SQLite storage
 * and a real WebSocket, because acquisition lifetime, owner eviction and
 * transaction atomicity are properties of that runtime rather than of any model
 * of it. Nothing here is discoverable by `deno task test`: the corpus walks
 * `*.test.ts`, and these are `*.vitest.ts`, so the Deno, Node and Bun shards
 * never see a file importing `cloudflare:test`.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "cloudflare",
          include: ["packages/workflow/tests/cloudflare/**/*.vitest.ts"],
        },
        plugins: [
          cloudflareTest({
            wrangler: { configPath: "./packages/workflow/tests/cloudflare/wrangler.jsonc" },
          }),
        ],
      },
    ],
  },
});
