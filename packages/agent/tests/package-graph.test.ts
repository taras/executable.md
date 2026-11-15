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
import { scoped } from "effection";
import type { Operation } from "effection";
import { exec, useQuietProcessOutput } from "@executablemd/runtime";
import * as path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPOSITORY = fileURLToPath(new URL("../../../", import.meta.url));
const AGENT_PACKAGE = pathToFileURL(path.join(REPOSITORY, "packages/agent/")).href;
const OLD_AGENT_SOURCE = pathToFileURL(path.join(REPOSITORY, "packages/core/src/agent/")).href;

/**
 * The Agent package as a registry resolves it: a bare or `npm:`/`jsr:` name,
 * resolved npm and JSR package ids, and a jsr.io module URL. A Core entry that
 * imported a published Agent instead of the workspace copy reaches no local
 * path, so the local prefixes alone would pass it.
 */
const REGISTRY_AGENT = /^(?:(?:npm|jsr):\/?)?@executablemd\/agent(?:$|[@/])/;
const JSR_AGENT_MODULE = "https://jsr.io/@executablemd/agent/";

/** Every public Core entry, by manifest subpath. */
const CORE_ENTRIES = [
  "mod.ts",
  "api.ts",
  "host.ts",
  "component-modules/deno.ts",
  "component-modules/node.ts",
  "component-modules/bun.ts",
];

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? Object(value) : {};
}

/**
 * Everything one entry's resolved graph names, failing on any graph error.
 *
 * Module specifiers, the requested specifiers of their dependencies, redirects
 * in both directions and the resolved npm and JSR package ids — each place a
 * registry spelling of the Agent package could appear.
 */
function* graphOf(entry: string): Operation<{ modules: string[]; names: string[] }> {
  // `deno info --json` prints megabytes for one graph; the answer is parsed
  // here, and a passing run has nothing to show.
  const info = yield* scoped(function* () {
    yield* useQuietProcessOutput();
    return yield* exec({
      command: [process.execPath, "info", "--json", "--frozen", "--node-modules-dir=none", entry],
      cwd: REPOSITORY,
    });
  });
  if (info.exitCode !== 0) {
    throw new Error(`deno info failed for ${entry}:\n${info.stderr}`);
  }
  const parsed = record(JSON.parse(info.stdout));
  const listed = parsed.modules;
  if (!Array.isArray(listed) || listed.length === 0) {
    throw new Error(`deno info reported no modules for ${entry}`);
  }
  const modules: string[] = [];
  const names: string[] = [];
  for (const one of listed) {
    const module = record(one);
    if (module.error !== undefined) {
      throw new Error(
        `${entry} has a graph error at ${String(module.specifier)}: ${String(module.error)}`,
      );
    }
    if (typeof module.specifier === "string") {
      modules.push(module.specifier);
    }
    for (const dependency of Array.isArray(module.dependencies) ? module.dependencies : []) {
      const requested = record(dependency).specifier;
      if (typeof requested === "string") {
        names.push(requested);
      }
    }
  }
  for (const [from, to] of Object.entries(record(parsed.redirects))) {
    names.push(from, String(to));
  }
  for (const [requested, resolved] of Object.entries(record(parsed.packages))) {
    names.push(requested, String(resolved));
  }
  names.push(...Object.keys(record(parsed.npmPackages)));
  return { modules, names: [...modules, ...names] };
}

function namesAgent(name: string): boolean {
  return (
    name.startsWith(AGENT_PACKAGE) ||
    name.startsWith(OLD_AGENT_SOURCE) ||
    name.startsWith(JSR_AGENT_MODULE) ||
    REGISTRY_AGENT.test(name)
  );
}

describe("Tier PB — Core resolves no Agent package", () => {
  it("PB1: no public Core entry's module graph reaches the Agent package", function* () {
    // The registry spellings no workspace graph contains, so the predicate the
    // graph rows rely on is checked against them directly.
    for (const spelling of [
      "@executablemd/agent",
      "@executablemd/agent/api",
      "npm:@executablemd/agent@0.14.1/host",
      "npm:/@executablemd/agent@0.14.1/esm/api.js",
      "@executablemd/agent@0.14.1",
      "jsr:@executablemd/agent@^0.14.1/api",
      "jsr:/@executablemd/agent@0.14.1/host",
      "https://jsr.io/@executablemd/agent/0.14.1/api.ts",
    ]) {
      expect([spelling, namesAgent(spelling)]).toEqual([spelling, true]);
    }
    for (const unrelated of [
      "@executablemd/agentic",
      "npm:/@executablemd/core@0.14.1/esm/mod.js",
      "https://jsr.io/@executablemd/core/0.14.1/mod.ts",
    ]) {
      expect([unrelated, namesAgent(unrelated)]).toEqual([unrelated, false]);
    }

    for (const entry of CORE_ENTRIES) {
      const graph = yield* graphOf(path.join("packages/core", entry));
      expect([entry, graph.names.filter(namesAgent)]).toEqual([entry, []]);
    }
    // The positive control: the same probe sees the Agent package, and Core
    // beneath it, where they are actually in the graph.
    const agent = yield* graphOf("packages/agent/host.ts");
    expect(agent.names.filter(namesAgent)).toContain(`${AGENT_PACKAGE}src/components.ts`);
    expect(agent.modules).toContain(
      pathToFileURL(path.join(REPOSITORY, "packages/core/mod.ts")).href,
    );
    expect(agent.modules.some((one) => one.startsWith(OLD_AGENT_SOURCE))).toBe(false);
  });
});
