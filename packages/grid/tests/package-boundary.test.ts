/**
 * Tier TG21 — the grid package boundary, the vocabulary it replaced, and the
 * technical vocabulary it kept (architecture.md §Package ownership, DEC-016).
 *
 * The stack has not merged, so `Terminal.Grid`, `<Terminal>`, the terminal
 * exports that used to sit in runtime, core and CLI, and the
 * `@executablemd/terminal` packages were never a compatibility surface — they
 * were the naming this rename removes. They are gone, and these rows are what
 * keeps them gone.
 *
 * Five claims, each failing differently if the rename regresses.
 *
 * Structural: the dependency arrows point at the neutral domain, so a provider
 * can be written without CLI or tmux and the domain consumed without either.
 * A violation is an import statement, so the evidence is the import statements
 * themselves — read from the production sources rather than inferred from a
 * manifest, because a manifest records what was declared and a source records
 * what is actually reached.
 *
 * Absence: the old directories, modules, exports, packages and authored names
 * are not merely unused but not there. An unused forwarding barrel is exactly
 * the thing that lets an import drift back, and a reserved alias is exactly
 * what lets an author keep writing the rejected syntax.
 *
 * Discrimination: every absence row above is a claim over a set that could be
 * empty for the wrong reason. One row plants each rejected name into the very
 * scanners the others use and requires them to report it.
 *
 * Exactness: the public roots are pinned as complete sets rather than as
 * required names, because a name that reached a root by being added to it is
 * what a required-names check lets stay.
 *
 * Preservation: a terminal is still a real capability. `NO_TERMINAL`,
 * `reserveTerminal`, `PaneTerminal` and `TerminalProcesses` describe a PTY, a
 * lease and a process boundary, and this rename keeps every one of them — so
 * the rows below prove they are still reachable while the presentation names
 * that were rejected are not.
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { exists, readTextFile } from "@effectionx/fs";
import { readdir } from "node:fs/promises";
import * as path from "node:path";
import { until } from "effection";
import type { Operation } from "effection";

/**
 * What a canonical grid name used to be called.
 *
 * Derived rather than written out, so this file states the rejected spelling
 * nowhere and the scans below can read it like any other source without
 * reporting themselves.
 */
function rejected(canonical: string): string {
  return canonical.replaceAll("grid", "terminal").replaceAll("Grid", "Terminal");
}

/** The two packages this rename replaced, by specifier and by directory. */
const REJECTED_PACKAGES = [
  rejected("@executablemd/grid-tmux"),
  rejected("@executablemd/grid"),
  rejected("packages/grid-tmux"),
  rejected("packages/grid"),
] as const;

/** The authored names this rename replaced: `Terminal.Grid` and `Terminal`. */
const REJECTED_CONSTRUCTS = [`${rejected("Grid")}.Grid`, rejected("Grid")] as const;

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
  const pending = [path.resolve("packages/grid", entrypoint)];
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
 * every dependency package under its dependents, so `packages/grid-tmux/
 * node_modules/@executablemd/grid/src/...` is the *same file* reached through a
 * link. Walking it would count one definition many times and would read a
 * vendored copy's imports as if they were the importing package's own — so a
 * package would appear to import whatever its dependencies import. Bun's layout
 * creates those links and Deno's does not, which is why this was invisible
 * until the Bun shard ran.
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
        // `@executablemd/grid/posix` is the grid package.
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

/**
 * The declared dependency state a rejected package name could survive in.
 *
 * A source that imports a deleted package fails loudly; a manifest, a lockfile
 * or the generated publication workflow that still names one fails nothing at
 * all until a release runs, which is why they are read here by name.
 */
function* declaredState(): Operation<string[]> {
  const files = [
    "deno.json",
    "deno.lock",
    "package.json",
    "pnpm-lock.yaml",
    "bun.lock",
    ".github/workflows/publish-packages.yml",
  ];
  const present: string[] = [];
  for (const file of files) {
    if (yield* exists(path.resolve(file))) {
      present.push(file);
    }
  }
  const root = path.resolve("packages");
  const entries = yield* until(readdir(root, { recursive: true, withFileTypes: true }));
  for (const entry of entries) {
    if (!entry.isFile() || (entry.name !== "package.json" && entry.name !== "deno.json")) {
      continue;
    }
    const full = path.join(entry.parentPath ?? root, entry.name);
    if (installed(path.relative(root, full))) {
      continue;
    }
    present.push(path.relative(path.resolve("."), full));
  }
  return present;
}

/** Where a rejected package name appears in the given text. */
function namesRejectedPackage(text: string): string[] {
  return REJECTED_PACKAGES.filter((name) => text.includes(name));
}

/** The names the grid domain owns, whatever path someone might reach for. */
const GRID_EXPORTS = [
  "NativeLauncher",
  "nativeLaunch",
  "reserveTerminal",
  "flushOutput",
  "installForegroundLauncher",
  "installControlledLauncher",
  "Grids",
  "GridProviders",
  "TerminalProcesses",
  "registerGridProvider",
  "installGridProvider",
  "useGridInstallation",
  "paneTerminal",
  "prepareControlledComposite",
  "gridProviderLog",
  "installDenoTerminalProcesses",
  "processTable",
  "processReachable",
] as const;

/**
 * Presentation names the rename rejected.
 *
 * Every one of them described the grid, the pane request, the provider or the
 * lifecycle — never a PTY — so none of them may come back under any facet.
 */
const REJECTED_EXPORTS = [
  "TerminalGrids",
  "TerminalProviders",
  "TerminalComposite",
  "registerTerminalProvider",
  "installTerminalProvider",
  "useTerminalInstallation",
  "createTerminalAuthority",
  "createTerminalGridClaims",
  "openTerminalGrid",
  "terminalGridLayout",
  "terminalProviderLog",
  "TerminalProviderUnavailableError",
  "TerminalProviderInstallError",
  "TerminalAuthorityError",
  "TerminalTeardownFailed",
  "TERMINAL_GRIDS_API",
  "TERMINAL_PROVIDERS_API",
  "TERMINAL_PROVIDER_UNAVAILABLE",
] as const;

describe("Tier TG21 — the grid package boundary", () => {
  it("TG21a: the neutral domain reaches no engine, host or provider", function* () {
    const reached = yield* importsOf("grid");
    // The whole point of the extraction: a provider or a consumer takes the
    // domain without taking the document engine, the CLI, or tmux with it.
    for (const forbidden of [
      "@executablemd/runtime",
      "@executablemd/core",
      "@executablemd/cli",
      "@executablemd/grid-tmux",
    ]) {
      expect([forbidden, reached.has(forbidden)]).toEqual([forbidden, false]);
    }
  });

  it("TG21b: the tmux adapter reaches the domain and nothing above it", function* () {
    const reached = yield* importsOf("grid-tmux");
    expect(reached.has("@executablemd/grid")).toBe(true);
    for (const forbidden of ["@executablemd/runtime", "@executablemd/core", "@executablemd/cli"]) {
      expect([forbidden, reached.has(forbidden)]).toEqual([forbidden, false]);
    }
  });

  it("TG21c: runtime owns no grid dependency, and only CLI composes both", function* () {
    // The amendment's load-bearing change: runtime keeps no grid edge at all,
    // in its sources or its manifest, because there is no unreleased path left
    // for it to keep alive.
    expect((yield* importsOf("runtime")).has("@executablemd/grid")).toBe(false);
    const manifest = yield* readTextFile(path.resolve("packages/runtime/package.json"));
    expect(manifest.includes("@executablemd/grid")).toBe(false);

    expect((yield* importsOf("core")).has("@executablemd/grid")).toBe(true);
    // Core is the document engine, not a host: it never selects a provider.
    expect((yield* importsOf("core")).has("@executablemd/grid-tmux")).toBe(false);
    const cli = yield* importsOf("cli");
    for (const required of [
      "@executablemd/core",
      "@executablemd/runtime",
      "@executablemd/grid",
      "@executablemd/grid-tmux",
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
    for (const pkg of ["grid", "grid-tmux", "core", "cli"]) {
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
    expect((yield* productionSources("grid")).length).toBeGreaterThan(10);
    expect((yield* productionSources("grid-tmux")).length).toBeGreaterThan(8);
    expect((yield* everySource()).length).toBeGreaterThan(100);
  });
});

describe("Tier TG21 — the replaced paths and packages are absent", () => {
  it("TG21e: no old module, package directory or core subtree remains", function* () {
    // Deleted rather than emptied. A module that still resolves is a path an
    // import can drift back onto, whether or not anything uses it today, and a
    // package directory that still exists is one a workspace glob still finds.
    for (const gone of [
      "packages/runtime/launcher.ts",
      "packages/runtime/terminal.ts",
      "packages/runtime/terminal-processes.ts",
      "packages/runtime/deno-terminal-processes.ts",
      "packages/core/src/terminal-grid.ts",
      rejected("packages/core/src/grid"),
      rejected("packages/grid"),
      rejected("packages/grid-tmux"),
      "packages/cli/src/terminal",
    ]) {
      expect([gone, yield* exists(path.resolve(gone))]).toEqual([gone, false]);
    }
  });

  it("TG21m: no manifest, lock or publication workflow names either old package", function* () {
    // A source that imports a deleted package fails at resolution. A manifest,
    // a lockfile or the generated publish workflow that still names one fails
    // nothing until a release runs, so each is read here by name.
    const offenders: string[] = [];
    for (const file of yield* declaredState()) {
      for (const name of namesRejectedPackage(yield* readTextFile(path.resolve(file)))) {
        offenders.push(`${file}: ${name}`);
      }
    }
    expect(offenders).toEqual([]);
    // And the state it walked is really there, so the absence is not free.
    expect((yield* declaredState()).length).toBeGreaterThan(10);
  });

  it("TG21n: no repository source names either old package", function* () {
    const here = path.resolve("packages/grid/tests/package-boundary.test.ts");
    const offenders: string[] = [];
    for (const file of yield* everySource()) {
      // This file is where the rejected vocabulary is deliberately written
      // down, which is why it derives those spellings instead of spelling them.
      if (file === here) {
        continue;
      }
      for (const name of namesRejectedPackage(yield* readTextFile(file))) {
        offenders.push(`${path.relative(path.resolve("packages"), file)}: ${name}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("TG21f: runtime and core export none of the grid domain", function* () {
    const runtime = yield* until(import("@executablemd/runtime"));
    const core = yield* until(import("@executablemd/core"));
    for (const name of GRID_EXPORTS) {
      expect([`runtime.${name}`, name in runtime]).toEqual([`runtime.${name}`, false]);
      expect([`core.${name}`, name in core]).toEqual([`core.${name}`, false]);
    }
    // What core does still own is the profile that composes a grid into an
    // `Execution` — the adaptation, not the domain.
    expect("installGridProfile" in core).toBe(true);
  });

  it("TG21g: every repository grid import names a canonical surface", function* () {
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
        for (const name of GRID_EXPORTS) {
          if (new RegExp(`\\b${name}\\b`).test(statement)) {
            offenders.push(`${path.relative(path.resolve("packages"), file)}: ${name}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("TG21h: each descriptor and public error constructor is defined once", function* () {
    // Identity used to be provable by comparing two import paths. With one path
    // left, the claim that replaces it is that there is only one definition to
    // reach — so a second `createApi` or a second class cannot quietly appear
    // and split middleware composition between two objects that behave alike.
    const sources = yield* everySource();
    const definitions = new Map<string, string[]>();
    // Any exported class, not just one whose name ends in `Error`:
    // `GridTeardownFailed` is a refusal too, and a scan that keyed on the
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
      "Grids",
      "GridProviders",
      "TerminalProcesses",
      "NativeLauncherUnavailableError",
      "GridProviderUnavailableError",
      "TerminalProcessesUnavailableError",
      "GridProviderInstallError",
      "GridAuthorityError",
      "TmuxUnavailableError",
      "GridTeardownFailed",
    ]) {
      expect([name, definitions.get(name) ?? []]).toEqual([name, [expect.any(String)]]);
    }
    // And the scan is not vacuous: it found the descriptors it was told to look
    // for, in the package that owns them.
    expect(definitions.get("NativeLauncher")?.[0]).toContain("grid/src/native-launcher.ts");
    expect(definitions.get("TerminalProcesses")?.[0]).toContain("grid/src/processes.ts");
  });
});

describe("Tier TG21 — the authored names and the public roots", () => {
  it("TG21o: only Grid and Pane are declared, and neither old construct is reserved", function* () {
    const core = yield* until(import("@executablemd/core"));
    const declared = core.STRUCTURAL_DECLARATIONS.map((declaration) => declaration.name);
    expect(declared).toContain("Grid");
    expect(declared).toContain("Pane");
    for (const construct of REJECTED_CONSTRUCTS) {
      expect([construct, declared.includes(construct)]).toEqual([construct, false]);
      expect([construct, core.RESERVED_STRUCTURAL.has(construct)]).toEqual([construct, false]);
    }
    // A declaration describes itself, so a construct cannot be reserved without
    // a catalog entry — which is what makes the two checks above one claim.
    expect(core.RESERVED_STRUCTURAL.has("Grid")).toBe(true);
    expect(core.RESERVED_STRUCTURAL.has("Pane")).toBe(true);
  });

  it("TG21p: restoring an old alias or an old import is what these scans catch", function* () {
    // Every row above is an absence claim, and an absence claim proves nothing
    // unless the scanner behind it can see the thing it says is gone. Each
    // rejected spelling is planted into the exact scanner that must report it.
    for (const name of REJECTED_PACKAGES) {
      // Reported, not reported *alone*: the scoped names contain the unscoped
      // ones, so a `-tmux` mention is honestly two rejected names at once.
      const reported = namesRejectedPackage(`a source that mentions ${name} somewhere`);
      expect([name, reported.includes(name)]).toEqual([name, true]);
    }
    expect(namesRejectedPackage("a source that mentions packages/grid and nothing else")).toEqual(
      [],
    );
    const restored = `import { x } from "${rejected("@executablemd/grid")}";\n`;
    expect(specifiersOf(restored)).toEqual([rejected("@executablemd/grid")]);

    const core = yield* until(import("@executablemd/core"));
    const withAlias: ReadonlySet<string> = new Set([
      ...core.RESERVED_STRUCTURAL,
      REJECTED_CONSTRUCTS[0],
    ]);
    // The membership test TG21o makes is the same one, on a set that does hold
    // the alias — so a reserved set that regained it would be reported rather
    // than passing over a check that cannot see it.
    expect(withAlias.has(REJECTED_CONSTRUCTS[0])).toBe(true);
    expect(core.RESERVED_STRUCTURAL.has(REJECTED_CONSTRUCTS[0])).toBe(false);
  });

  it("TG21q: each public root is exactly this set of names", function* () {
    // Pinned as exact sets rather than as required names. `paneEnvironment` — a
    // host's decision about which of *its own* variables a pane inherits —
    // reached the tmux root by being added to it, and a row that only checked
    // for required names would have let it stay.
    // Each facet is imported by its literal specifier: a specifier held in a
    // variable resolves at runtime but is invisible to the typecheck, and this
    // row exists to be checked statically as well as run.
    const roots: [string, Record<string, unknown>, string[]][] = [
      [
        "@executablemd/grid",
        yield* until(import("@executablemd/grid")),
        [
          "GRIDS_API",
          "GRID_PROVIDERS_API",
          "GRID_PROVIDER_UNAVAILABLE",
          "GridProviderInstallError",
          "GridProviderUnavailableError",
          "GridProviders",
          "Grids",
          "NATIVE_LAUNCHER_UNAVAILABLE",
          "NO_TERMINAL",
          "NativeLauncher",
          "NativeLauncherUnavailableError",
          "flushOutput",
          "nativeLaunch",
          "notifyTerminal",
          "paneTerminal",
          "registerGridProvider",
          "reserveTerminal",
          "usePaneNativeLauncher",
          "usePaneTerminal",
        ],
      ],
      [
        "@executablemd/grid/lifecycle",
        yield* until(import("@executablemd/grid/lifecycle")),
        [
          "GridAuthorityError",
          "awaitReadiness",
          "createCloseBoundary",
          "createGridAuthority",
          "createGridClaims",
          "createGridRegistry",
          "durableGrid",
          "gridInstallation",
          "gridLayout",
          "installGridProvider",
          "openGrid",
          "paneNeverStartedMessage",
          "retainedLayout",
          "sealOnTeardown",
          "toRequest",
          "useGridInstallation",
        ],
      ],
      [
        "@executablemd/grid/processes",
        yield* until(import("@executablemd/grid/processes")),
        [
          "TERMINAL_PROCESSES_API",
          "TERMINAL_PROCESSES_UNAVAILABLE",
          "TerminalProcesses",
          "TerminalProcessesUnavailableError",
          "deliverSignal",
          "descendantsOf",
          "establishQuiescence",
          "groupMembers",
          "paneOccupants",
          "processReachable",
          "processTable",
          "terminalHolders",
        ],
      ],
      [
        "@executablemd/grid/posix",
        yield* until(import("@executablemd/grid/posix")),
        ["installDenoTerminalProcesses", "installForegroundLauncher", "posixProcessProbes"],
      ],
      [
        "@executablemd/grid/test",
        yield* until(import("@executablemd/grid/test")),
        ["gridProviderLog", "installControlledLauncher", "prepareControlledComposite"],
      ],
      [
        "@executablemd/grid-tmux",
        yield* until(import("@executablemd/grid-tmux")),
        [
          "GridTeardownFailed",
          "PANE_WORKER_COMMAND",
          "PaneNotQuiescent",
          "TMUX_PROVIDER",
          "TMUX_UNAVAILABLE",
          "TmuxUnavailableError",
          "installTmuxGridProvider",
          "paneWorkerInvocation",
          "runPaneWorkerProcess",
          "tmuxGridProvider",
        ],
      ],
    ];
    for (const [specifier, facet, names] of roots) {
      expect([specifier, Object.keys(facet).toSorted()]).toEqual([specifier, names.toSorted()]);
    }

    // The low-level tmux seams stay behind `./test`, and are really there — so
    // the assertion above is a boundary rather than an empty package.
    const seams = yield* until(import("@executablemd/grid-tmux/test"));
    for (const name of ["useTmuxGrid", "usePaneChannels", "usePaneChild", "tmuxAt", "runInPane"]) {
      expect([name, name in seams]).toEqual([name, true]);
    }
  });

  it("TG21r: the technical terminal surface survives and the presentation names do not", function* () {
    // The rename kept every name that describes a PTY, a lease, a signal or a
    // process boundary. This row is the complement of the absence rows: without
    // it, deleting the terminal capability outright would satisfy them all.
    const root = yield* until(import("@executablemd/grid"));
    for (const kept of ["NO_TERMINAL", "reserveTerminal", "NativeLauncher", "paneTerminal"]) {
      expect([kept, kept in root]).toEqual([kept, true]);
    }
    const processes = yield* until(import("@executablemd/grid/processes"));
    for (const kept of ["TerminalProcesses", "TERMINAL_PROCESSES_API", "terminalHolders"]) {
      expect([kept, kept in processes]).toEqual([kept, true]);
    }
    const posix = yield* until(import("@executablemd/grid/posix"));
    expect("installDenoTerminalProcesses" in posix).toBe(true);

    // And no facet brings back a presentation name the rename rejected.
    const facets: [string, Record<string, unknown>][] = [
      ["@executablemd/grid", root],
      ["@executablemd/grid/lifecycle", yield* until(import("@executablemd/grid/lifecycle"))],
      ["@executablemd/grid/processes", processes],
      ["@executablemd/grid/posix", posix],
      ["@executablemd/grid/test", yield* until(import("@executablemd/grid/test"))],
      ["@executablemd/grid-tmux", yield* until(import("@executablemd/grid-tmux"))],
    ];
    for (const [specifier, facet] of facets) {
      for (const gone of REJECTED_EXPORTS) {
        expect([`${specifier}.${gone}`, gone in facet]).toEqual([`${specifier}.${gone}`, false]);
      }
    }
  });
});
