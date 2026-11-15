/**
 * Tier PB, PB1 — no public Core entry's resolved module graph reaches the Agent
 * package.
 *
 * Asked of Deno's resolver through `deno info --json`, so a graph error fails
 * the row rather than hiding an edge. Deno-only for that reason; the rest of
 * Tier PB is runtime-neutral and lives in package-boundary.test.ts.
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import type { Operation } from "effection";
import { exec } from "@effectionx/process";
import * as path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPOSITORY = fileURLToPath(new URL("../../../", import.meta.url));
const AGENT_PACKAGE = pathToFileURL(path.join(REPOSITORY, "packages/agent/")).href;
const OLD_AGENT_SOURCE = pathToFileURL(path.join(REPOSITORY, "packages/core/src/agent/")).href;

/** Every public Core entry, by manifest subpath. */
const CORE_ENTRIES = [
  "mod.ts",
  "api.ts",
  "host.ts",
  "component-modules/deno.ts",
  "component-modules/node.ts",
  "component-modules/bun.ts",
];

/** The modules one entry's resolved graph contains, failing on any graph error. */
function* graphOf(entry: string): Operation<string[]> {
  const info = yield* exec(process.execPath, {
    arguments: ["info", "--json", "--frozen", "--node-modules-dir=none", entry],
    cwd: REPOSITORY,
  }).join();
  if (info.code !== 0) {
    throw new Error(`deno info failed for ${entry}:\n${info.stderr}`);
  }
  const parsed: unknown = JSON.parse(info.stdout);
  const modules =
    typeof parsed === "object" && parsed !== null ? Reflect.get(parsed, "modules") : undefined;
  if (!Array.isArray(modules) || modules.length === 0) {
    throw new Error(`deno info reported no modules for ${entry}`);
  }
  const specifiers: string[] = [];
  for (const module of modules) {
    const specifier: unknown = Reflect.get(module, "specifier");
    const error: unknown = Reflect.get(module, "error");
    if (error !== undefined) {
      throw new Error(`${entry} has a graph error at ${String(specifier)}: ${String(error)}`);
    }
    if (typeof specifier === "string") {
      specifiers.push(specifier);
    }
  }
  return specifiers;
}

function agentModules(specifiers: readonly string[]): string[] {
  return specifiers.filter(
    (specifier) => specifier.startsWith(AGENT_PACKAGE) || specifier.startsWith(OLD_AGENT_SOURCE),
  );
}

describe("Tier PB — Core resolves no Agent package", () => {
  it("PB1: no public Core entry's module graph reaches the Agent package", function* () {
    for (const entry of CORE_ENTRIES) {
      const modules = yield* graphOf(path.join("packages/core", entry));
      expect([entry, agentModules(modules)]).toEqual([entry, []]);
    }
    // The positive control: the same probe sees the Agent package, and Core
    // beneath it, where they are actually in the graph.
    const agent = yield* graphOf("packages/agent/host.ts");
    expect(agentModules(agent)).toContain(`${AGENT_PACKAGE}src/components.ts`);
    expect(agent).toContain(pathToFileURL(path.join(REPOSITORY, "packages/core/mod.ts")).href);
    expect(agentModules(agent).some((one) => one.startsWith(OLD_AGENT_SOURCE))).toBe(false);
  });
});
