/**
 * Tier TG21 — the package boundary, and the absence of the paths it replaced
 * (architecture.md §Package ownership, DEC-016).
 *
 * The stack has not merged, so the terminal exports that used to sit in
 * runtime, core and CLI were never a compatibility surface — they were the
 * ownership ambiguity this extraction removes. They are gone, and these rows
 * are what keeps them gone.
 *
 * Three claims, each failing differently if the extraction regresses.
 *
 * Structural: the dependency arrows point at the neutral domain, so a provider
 * can be written without CLI or tmux and the domain consumed without either.
 * A violation is an import statement, so the evidence is the import statements
 * themselves — read from the production sources rather than inferred from a
 * manifest, because a manifest records what was declared and a source records
 * what is actually reached.
 *
 * Absence: the old modules, the old exports and the old CLI implementation
 * path are not merely unused but not there. An unused forwarding barrel is
 * exactly the thing that lets an import drift back.
 *
 * Uniqueness: each contextual descriptor and public error constructor is
 * defined once. These are matched with `instanceof` and carry middleware, so a
 * second definition would not fail loudly — it would split composition between
 * two objects that behave alike, which is the failure this tier exists to make
 * impossible rather than merely unlikely.
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { exists, readTextFile } from "@effectionx/fs";
import { readdir } from "node:fs/promises";
import * as path from "node:path";
import { until } from "effection";
import type { Operation } from "effection";

/**
 * Everything one entrypoint loads, transitively.
 *
 * Read from the module graph rather than from the entrypoint's own export
 * list, because an export list is exactly what hid this: re-exporting three
 * names out of a module that also spawns processes narrows what is *reachable
 * by name* and nothing about what is *loaded*. A facade passes an export-shape
 * check and fails this one.
 */
function* graphOf(entrypoint: string): Operation<string[]> {
  const seen = new Set<string>();
  const pending = [path.resolve("packages/terminal", entrypoint)];
  while (pending.length > 0) {
    const file = pending.pop();
    if (file === undefined || seen.has(file)) {
      continue;
    }
    seen.add(file);
    const source = yield* readTextFile(file);
    for (const match of source.matchAll(/from\s+"([^"]+)"/g)) {
      const specifier = match[1];
      if (specifier === undefined) {
        continue;
      }
      if (specifier.startsWith("node:")) {
        seen.add(specifier);
        continue;
      }
      if (specifier.startsWith(".")) {
        pending.push(path.resolve(path.dirname(file), specifier));
      }
    }
  }
  return [...seen];
}

/**
 * Trees that are an installer's rather than this repository's.
 *
 * `node_modules` has to go, and not only for speed: a workspace install links
 * every dependency package under its dependents, so `packages/terminal-tmux/
 * node_modules/@executablemd/terminal/src/...` is the *same file* reached
 * through a link. Walking it would count one definition many times and would
 * read a vendored copy's imports as if they were the importing package's own —
 * so a package would appear to import whatever its dependencies import. Bun's
 * layout creates those links and Deno's does not, which is why this was
 * invisible until the Bun shard ran.
 */
const INSTALLED = new Set(["node_modules", "npm", "dist", "generated", "vendor"]);

/** Whether any segment of `relative` names a tree this repository does not author. */
function installed(relative: string): boolean {
  return relative.split(path.sep).some((segment) => INSTALLED.has(segment));
}

/** Every production source of one workspace package, tests excluded. */
function* productionSources(pkg: string): Operation<string[]> {
  const root = path.resolve("packages", pkg);
  const files: string[] = [];
  const entries = yield* until(readdir(root, { recursive: true, withFileTypes: true }));
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".ts")) {
      continue;
    }
    const full = path.join(entry.parentPath ?? root, entry.name);
    const relative = path.relative(root, full);
    if (installed(relative)) {
      continue;
    }
    // Tests prove the contract; they do not define the shipped graph. A row may
    // reach across packages to drive a fixture without that being a dependency
    // of the artifact.
    if (relative.startsWith("tests/") || relative.includes(".test.")) {
      continue;
    }
    files.push(full);
  }
  return files;
}

/** The package specifiers one source imports from, bare names only. */
function specifiersOf(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(/(?:^|\n)\s*(?:import|export)[^;]*?from\s+"([^"]+)"/g)) {
    const specifier = match[1];
    if (specifier !== undefined && !specifier.startsWith(".")) {
      found.push(specifier);
    }
  }
  return found;
}

/** Which workspace packages `pkg`'s production code actually imports. */
function* importsOf(pkg: string): Operation<Set<string>> {
  const reached = new Set<string>();
  for (const file of yield* productionSources(pkg)) {
    for (const specifier of specifiersOf(yield* readTextFile(file))) {
      if (specifier.startsWith("@executablemd/")) {
        // `@executablemd/terminal/posix` is the terminal package.
        reached.add(specifier.split("/").slice(0, 2).join("/"));
      }
    }
  }
  return reached;
}

/** Every `.ts` file in the repository's packages, tests included. */
function* everySource(): Operation<string[]> {
  const root = path.resolve("packages");
  const files: string[] = [];
  const entries = yield* until(readdir(root, { recursive: true, withFileTypes: true }));
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".ts")) {
      continue;
    }
    const full = path.join(entry.parentPath ?? root, entry.name);
    if (installed(path.relative(root, full))) {
      continue;
    }
    files.push(full);
  }
  return files;
}

/** The names the terminal domain owns, whatever path someone might reach for. */
const TERMINAL_EXPORTS = [
  "NativeLauncher",
  "nativeLaunch",
  "reserveTerminal",
  "flushOutput",
  "installForegroundLauncher",
  "installControlledLauncher",
  "TerminalGrids",
  "TerminalProviders",
  "TerminalProcesses",
  "registerTerminalProvider",
  "installTerminalProvider",
  "useTerminalInstallation",
  "paneTerminal",
  "prepareControlledComposite",
  "terminalProviderLog",
  "installDenoTerminalProcesses",
  "processTable",
  "processReachable",
] as const;

describe("Tier TG21 — the terminal package boundary", () => {
  it("TG21a: the neutral domain reaches no engine, host or provider", function* () {
    const reached = yield* importsOf("terminal");
    // The whole point of the extraction: a provider or a consumer takes the
    // domain without taking the document engine, the CLI, or tmux with it.
    for (const forbidden of [
      "@executablemd/runtime",
      "@executablemd/core",
      "@executablemd/cli",
      "@executablemd/terminal-tmux",
    ]) {
      expect([forbidden, reached.has(forbidden)]).toEqual([forbidden, false]);
    }
  });

  it("TG21b: the tmux adapter reaches the domain and nothing above it", function* () {
    const reached = yield* importsOf("terminal-tmux");
    expect(reached.has("@executablemd/terminal")).toBe(true);
    for (const forbidden of ["@executablemd/runtime", "@executablemd/core", "@executablemd/cli"]) {
      expect([forbidden, reached.has(forbidden)]).toEqual([forbidden, false]);
    }
  });

  it("TG21m: the repository supplies test dependencies without reversing the domain boundary", function* () {
    const root = JSON.parse(yield* readTextFile(path.resolve("package.json")));
    expect(root.private).toBe(true);
    for (const name of ["@executablemd/terminal", "@executablemd/terminal-tmux"]) {
      expect([name, root.devDependencies[name]]).toEqual([name, "workspace:*"]);
    }
    const domain = JSON.parse(yield* readTextFile(path.resolve("packages/terminal/package.json")));
    expect(domain.dependencies).not.toHaveProperty("@executablemd/terminal-tmux");
  });

  it("TG21c: runtime owns no terminal dependency, and only CLI composes both", function* () {
    // The amendment's load-bearing change: runtime keeps no terminal edge at
    // all, in its sources or its manifest, because there is no unreleased path
    // left for it to keep alive.
    expect((yield* importsOf("runtime")).has("@executablemd/terminal")).toBe(false);
    const manifest = yield* readTextFile(path.resolve("packages/runtime/package.json"));
    expect(manifest.includes("@executablemd/terminal")).toBe(false);

    expect((yield* importsOf("core")).has("@executablemd/terminal")).toBe(true);
    // Core is the document engine, not a host: it never selects a provider.
    expect((yield* importsOf("core")).has("@executablemd/terminal-tmux")).toBe(false);
    const cli = yield* importsOf("cli");
    for (const required of [
      "@executablemd/core",
      "@executablemd/runtime",
      "@executablemd/terminal",
      "@executablemd/terminal-tmux",
    ]) {
      expect([required, cli.has(required)]).toEqual([required, true]);
    }
  });

  it("TG21i: the neutral entrypoints load no host process code and no fixture", function* () {
    // The defect this replaced: the root re-exported a handful of neutral names
    // from a module that also spawned children and carried a test double, so
    // importing the domain loaded `node:child_process` and a fixture. Selective
    // re-export narrows the names, never the load.
    for (const entrypoint of ["mod.ts", "lifecycle.ts", "processes.ts"]) {
      const graph = yield* graphOf(entrypoint);
      const host = graph.filter(
        (module) =>
          module === "node:child_process" ||
          module === "node:process" ||
          module.endsWith("/posix-launcher.ts") ||
          module.endsWith("/posix-processes.ts"),
      );
      const fixtures = graph.filter((module) => module.includes("/controlled-"));
      expect([entrypoint, host]).toEqual([entrypoint, []]);
      expect([entrypoint, fixtures]).toEqual([entrypoint, []]);
    }
  });

  it("TG21j: the host and fixture facets are where that code actually lives", function* () {
    // The complement, and the discriminator for the row above: if the split had
    // simply deleted this code rather than moved it, TG21i would pass over an
    // empty graph and prove nothing.
    const posix = yield* graphOf("posix.ts");
    expect(posix.some((module) => module.endsWith("/posix-launcher.ts"))).toBe(true);
    expect(posix.some((module) => module.endsWith("/posix-processes.ts"))).toBe(true);
    expect(posix.includes("node:child_process")).toBe(true);

    // `testing.ts`, not `test.ts`: Deno's own test-file pattern matches a bare
    // `test.ts`, so an entrypoint by that name would be loaded as a test file.
    const fixtures = yield* graphOf("testing.ts");
    expect(fixtures.some((module) => module.endsWith("/controlled-launcher.ts"))).toBe(true);
    expect(fixtures.some((module) => module.endsWith("/controlled-composite.ts"))).toBe(true);
  });

  it("TG21l: an installer's linked copies are not read as a package's own source", function* () {
    // A workspace install links each dependency under its dependents, so the
    // same file is reachable at `packages/<pkg>/node_modules/@executablemd/...`.
    // Counting those would report one definition many times, and reading their
    // imports would make a package appear to import whatever its dependencies
    // import. Bun's layout creates the links, Deno's does not — so every row
    // above was passing under one runtime for a reason that does not hold under
    // the other.
    for (const pkg of ["terminal", "terminal-tmux", "core", "cli"]) {
      const strayed = (yield* productionSources(pkg)).filter((file) =>
        file.includes(`${path.sep}node_modules${path.sep}`),
      );
      expect([pkg, strayed]).toEqual([pkg, []]);
    }
    expect(
      (yield* everySource()).filter((file) => file.includes(`${path.sep}node_modules${path.sep}`)),
    ).toEqual([]);
  });

  it("TG21d: a walked package with no sources would not pass vacuously", function* () {
    // The rows above are absence claims, and an absence claim over an empty set
    // is free. This is the discriminator: the walk finds real files.
    expect((yield* productionSources("terminal")).length).toBeGreaterThan(10);
    expect((yield* productionSources("terminal-tmux")).length).toBeGreaterThan(8);
    expect((yield* everySource()).length).toBeGreaterThan(100);
  });
});

describe("Tier TG21 — the replaced paths are absent", () => {
  it("TG21e: no old terminal module remains where it used to live", function* () {
    // Deleted rather than emptied. A module that still resolves is a path an
    // import can drift back onto, whether or not anything uses it today.
    for (const gone of [
      "packages/runtime/launcher.ts",
      "packages/runtime/terminal.ts",
      "packages/runtime/terminal-processes.ts",
      "packages/runtime/deno-terminal-processes.ts",
      "packages/core/src/terminal-grid.ts",
      "packages/core/src/terminal/authority.ts",
      "packages/core/src/terminal/provider-api.ts",
      "packages/core/src/terminal/grid.ts",
      "packages/core/src/terminal/pane.ts",
      "packages/core/src/terminal/pane-launcher.ts",
      "packages/cli/src/terminal",
    ]) {
      expect([gone, yield* exists(path.resolve(gone))]).toEqual([gone, false]);
    }
  });

  it("TG21f: runtime and core export none of the terminal domain", function* () {
    const runtime = yield* until(import("@executablemd/runtime"));
    const core = yield* until(import("@executablemd/core"));
    for (const name of TERMINAL_EXPORTS) {
      expect([`runtime.${name}`, name in runtime]).toEqual([`runtime.${name}`, false]);
      expect([`core.${name}`, name in core]).toEqual([`core.${name}`, false]);
    }
    // What core does still own is the profile that composes a grid into an
    // `Execution` — the adaptation, not the domain.
    expect("installTerminalGridProfile" in core).toBe(true);
  });

  it("TG21g: every repository terminal import names a canonical surface", function* () {
    // The complement of TG21f. An export that is gone cannot be imported, but a
    // *type-only* import of a vanished name fails at typecheck rather than
    // here, and this row is what says where such an import would have to move.
    const offenders: string[] = [];
    for (const file of yield* everySource()) {
      const source = yield* readTextFile(file);
      for (const match of source.matchAll(
        /(?:^|\n)\s*(?:import|export)[^;]*?from\s+"(@executablemd\/(?:runtime|core))"/g,
      )) {
        const statement = match[0];
        for (const name of TERMINAL_EXPORTS) {
          if (new RegExp(`\\b${name}\\b`).test(statement)) {
            offenders.push(`${path.relative(path.resolve("packages"), file)}: ${name}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("TG21k: the tmux root exposes exactly its narrow provider API", function* () {
    // Pinned as an exact set rather than a set of required names. `paneEnvironment`
    // — a host's decision about which of *its own* variables a pane inherits —
    // reached this root by being added to it, and a row that only checked for
    // required names would have let it stay.
    const tmux = yield* until(import("@executablemd/terminal-tmux"));
    expect(Object.keys(tmux).toSorted()).toEqual(
      [
        // Provider installation and factory.
        "TMUX_PROVIDER",
        "installTmuxGridProvider",
        "tmuxGridProvider",
        // Worker dispatch.
        "PANE_WORKER_COMMAND",
        "PaneNotQuiescent",
        "paneWorkerInvocation",
        "runPaneWorkerProcess",
        // The refusals a reader can actually meet.
        "TMUX_UNAVAILABLE",
        "TerminalTeardownFailed",
        "TmuxUnavailableError",
      ].toSorted(),
    );

    // The low-level seams stay behind `./test`, and are really there — so the
    // assertion above is a boundary rather than an empty package.
    const seams = yield* until(import("@executablemd/terminal-tmux/test"));
    for (const name of ["useTmuxGrid", "usePaneChannels", "usePaneChild", "tmuxAt", "runInPane"]) {
      expect([name, name in seams]).toEqual([name, true]);
    }
  });

  it("TG21h: each descriptor and public error constructor is defined once", function* () {
    // Identity used to be provable by comparing two import paths. With one path
    // left, the claim that replaces it is that there is only one definition to
    // reach — so a second `createApi` or a second class cannot quietly appear
    // and split middleware composition between two objects that behave alike.
    const sources = yield* everySource();
    const definitions = new Map<string, string[]>();
    // Any exported class, not just one whose name ends in `Error`:
    // `TerminalTeardownFailed` is a refusal too, and a scan that keyed on the
    // suffix would have reported it as having no definition at all.
    const declared = /export\s+(?:const\s+(\w+)\s*(?::[^=]+)?=\s*createApi|class\s+(\w+))/g;
    for (const file of sources) {
      for (const match of (yield* readTextFile(file)).matchAll(declared)) {
        const name = match[1] ?? match[2];
        if (name === undefined) {
          continue;
        }
        definitions.set(name, [
          ...(definitions.get(name) ?? []),
          path.relative(path.resolve("packages"), file),
        ]);
      }
    }

    for (const name of [
      "NativeLauncher",
      "TerminalGrids",
      "TerminalProviders",
      "TerminalProcesses",
      "NativeLauncherUnavailableError",
      "TerminalProviderUnavailableError",
      "TerminalProcessesUnavailableError",
      "TerminalProviderInstallError",
      "TerminalAuthorityError",
      "TmuxUnavailableError",
      "TerminalTeardownFailed",
    ]) {
      expect([name, definitions.get(name) ?? []]).toEqual([name, [expect.any(String)]]);
    }
    // And the scan is not vacuous: it found the descriptors it was told to look
    // for, in the package that owns them.
    expect(definitions.get("NativeLauncher")?.[0]).toContain("terminal/src/native-launcher.ts");
    expect(definitions.get("TerminalProcesses")?.[0]).toContain("terminal/src/processes.ts");
  });
});
