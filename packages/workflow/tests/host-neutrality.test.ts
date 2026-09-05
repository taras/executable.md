/**
 * Tier WRH — what the shared package may know about a host.
 *
 * `@executablemd/workflow` names no provider. That claim is what lets a second
 * host implement the same lifecycle without the Deno entrypoint being loaded at
 * all, and it is worth exactly as much as the imports underneath it: one
 * `node:sqlite` or `cloudflare:` specifier in a shared module, or one
 * `typeof Deno` test, and every module that resolves through it inherits a host.
 *
 * So this reads the source rather than describing it. It walks the modules a
 * consumer reaches through the package root and fails on anything that names a
 * runtime — the runtime-named entrypoints and their own subtrees excepted,
 * because installing host behavior is what those are for.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { readTextFile, walk } from "@effectionx/fs";
import { each } from "effection";
import type { Operation } from "effection";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE = fileURLToPath(new URL("..", import.meta.url));

/**
 * The subtrees that are allowed to know a host, because naming one is their job.
 *
 * The runtime-named entrypoints and their implementation subtrees, and nothing
 * else. `software-factory.ts` is deliberately absent: it is product-specific
 * rather than host-specific, uses the cross-runtime Web primitives, and is held
 * to these rules like any shared module. `vendor` is pinned upstream source
 * whose drift verifier owns its bytes.
 */
const RUNTIME_OWNED = [
  "deno.ts",
  "cloudflare.ts",
  "src/deno",
  "src/cloudflare",
  "tests/cloudflare",
  "vitest.config.ts",
  "vendor",
];

/** Specifiers only a host adapter may import. */
const HOST_SPECIFIERS = [
  "node:sqlite",
  "node:fs",
  "node:os",
  "node:child_process",
  "cloudflare:workers",
  "cloudflare:test",
  "@cloudflare/",
];

/** Ways a module could ask which runtime it is running under. */
const RUNTIME_DETECTION = [
  /\btypeof\s+Deno\b/,
  /\btypeof\s+Bun\b/,
  /\bnavigator\s*\.\s*userAgent\b/,
  /\bprocess\s*\.\s*versions\s*\.\s*bun\b/,
  /\bglobalThis\s*\.\s*Deno\b/,
  /\bglobalThis\s*\.\s*Bun\b/,
];

function* sharedModules(): Operation<string[]> {
  const owned = RUNTIME_OWNED.map((entry) => join(PACKAGE, entry));
  const found: string[] = [];
  for (const entry of yield* each(walk(PACKAGE, { includeDirs: false }))) {
    const path = entry.path;
    const exempt = owned.some((root) => path === root || path.startsWith(`${root}/`));
    const generated = ["/node_modules/", "/tests/", "/npm/"].some((part) => path.includes(part));
    if (!exempt && !generated && path.endsWith(".ts") && !path.endsWith(".d.ts")) {
      found.push(path);
    }
    yield* each.next();
  }
  return found.toSorted();
}

function* offenders(check: (source: string) => boolean): Operation<string[]> {
  const named: string[] = [];
  for (const path of yield* sharedModules()) {
    const source = yield* readTextFile(path);
    if (check(source)) {
      named.push(relative(PACKAGE, path));
    }
  }
  return named;
}

describe("the shared workflow package", () => {
  it("finds the modules it is making a claim about", function* () {
    const modules = yield* sharedModules();
    expect(modules.length > 20).toEqual(true);
    expect(modules.some((path) => path.endsWith("/src/lifecycle/execution.ts"))).toEqual(true);
    expect(modules.some((path) => path.endsWith("/src/software-factory/run-id.ts"))).toEqual(true);
    expect(modules.some((path) => path.endsWith("/src/sqlite/workflow-schema.ts"))).toEqual(true);
    // The remote seam is ordinary shared code. It is the runner's half of a
    // connection to a provider, which is exactly why it must name none: an
    // exemption here would let the provider's vocabulary back in through the
    // one module whose whole purpose is to keep it out.
    expect(modules.some((path) => path.endsWith("/src/remote/read.ts"))).toEqual(true);
    expect(modules.some((path) => path.endsWith("/src/remote/client.ts"))).toEqual(true);
    expect(modules.some((path) => path.endsWith("/src/remote/records.ts"))).toEqual(true);
    expect(modules.some((path) => path.endsWith("/src/workspace/root-manifest.ts"))).toEqual(true);
    expect(modules.some((path) => path.endsWith("/src/workspace/sha256.ts"))).toEqual(true);
    expect(modules.some((path) => path.includes("/src/deno/"))).toEqual(false);
    expect(modules.some((path) => path.includes("/src/cloudflare/"))).toEqual(false);
  });

  it("imports no host-owned specifier outside a runtime-named entrypoint", function* () {
    const named = yield* offenders((source) =>
      HOST_SPECIFIERS.some(
        (specifier) =>
          source.includes(`from "${specifier}`) || source.includes(`import("${specifier}`),
      ),
    );
    expect(named).toEqual([]);
  });

  it("asks no module which runtime it is running under", function* () {
    const named = yield* offenders((source) =>
      RUNTIME_DETECTION.some((pattern) => pattern.test(source)),
    );
    expect(named).toEqual([]);
  });
});
