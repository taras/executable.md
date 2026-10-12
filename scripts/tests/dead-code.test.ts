import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensureDir, exists, readdir, readTextFile, rm, writeTextFile } from "@effectionx/fs";
import { exec } from "@effectionx/process";
import { scoped, until } from "effection";
import type { Operation } from "effection";
import { symlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { useTempDirectory } from "@executablemd/test-support/temp";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

/**
 * The dead-code gate, proved by mutation rather than by reading its report.
 *
 * A configuration that ignored the first-party source directories, or declared
 * an implementation module to be an entry point, would report nothing and look
 * exactly like a clean repository. So each case changes the tree and asks
 * whether the real command notices: the positive cases add dead code and
 * require the offending path or symbol in the report, and the negative cases
 * add the kinds of module nothing in the repository imports *by design* — a
 * public package export, a runtime entry point, a standalone script, a site
 * route and island, a package example, and the fixtures and components a test
 * loads by name or spawns as a subprocess — and require silence.
 *
 * Every case runs in a clone of `HEAD` with this checkout's installed
 * dependencies linked in, so a mutation can never reach the worktree another
 * check is reading and nothing is installed to make the clone usable. A clone
 * carries the committed configuration, so run these against a committed change.
 */
function* clone(): Operation<string> {
  const target = yield* useTempDirectory("dead-code-");

  yield* exec("git", {
    arguments: ["clone", "--shared", "--quiet", ROOT, target],
    cwd: ROOT,
  }).expect();

  // Knip resolves the import graph, and pnpm gives each workspace member its
  // own `node_modules` beside the root one. Linking both layouts is what lets
  // the clone resolve what this checkout already resolved; a clone that had to
  // install first would move dependency state the rest of the battery is
  // reading through.
  yield* link(path.join(ROOT, "node_modules"), path.join(target, "node_modules"));
  for (const member of yield* readdir(path.join(ROOT, "packages"))) {
    const dependencies = path.join(ROOT, "packages", member, "node_modules");
    if (yield* exists(dependencies)) {
      yield* link(dependencies, path.join(target, "packages", member, "node_modules"));
    }
  }

  return target;
}

function link(from: string, to: string): Operation<void> {
  return until(symlink(from, to, "dir"));
}

/**
 * The command the repository checks in, read from where it is defined.
 *
 * Derived rather than restated: a test carrying its own copy of the arguments
 * would keep passing after `lint:dead-code` stopped checking files, exports or
 * types, which is the one thing these cases exist to establish.
 */
function* deadCodeArguments(): Operation<string[]> {
  const manifest: unknown = JSON.parse(yield* readTextFile(path.join(ROOT, "package.json")));
  const scripts =
    typeof manifest === "object" && manifest !== null && "scripts" in manifest
      ? manifest.scripts
      : undefined;
  const command =
    typeof scripts === "object" && scripts !== null && "lint:dead-code" in scripts
      ? scripts["lint:dead-code"]
      : undefined;
  if (typeof command !== "string") {
    throw new Error("package.json declares no lint:dead-code script");
  }

  const argv = command.split(/\s+/).filter((token) => token !== "");
  expect(argv[0]).toEqual("knip");
  return argv.slice(1);
}

interface Report {
  code: number | undefined;
  output: string;
}

/**
 * One run of the check, with its report captured rather than forwarded.
 *
 * Intercepted, because the positive cases expect findings: a report that
 * reached this process's own stdout would put `Unused files (1)` in the log of
 * a passing suite, where it reads as the failure it is proving cannot hide.
 */
function* runDeadCode(target: string): Operation<Report> {
  return yield* scoped(function* () {
    const knip = yield* exec(path.join(ROOT, "node_modules", ".bin", "knip"), {
      arguments: yield* deadCodeArguments(),
      cwd: target,
    });

    // A streaming decoder holds the bytes of a split multi-byte character until
    // the next chunk, so the two pipes cannot share one.
    const outDecoder = new TextDecoder();
    const errDecoder = new TextDecoder();
    const report: string[] = [];
    yield* knip.around({
      *stdout([bytes]) {
        report.push(outDecoder.decode(bytes, { stream: true }));
      },
      *stderr([bytes]) {
        report.push(errDecoder.decode(bytes, { stream: true }));
      },
    });

    const status = yield* knip.join();
    report.push(outDecoder.decode(), errDecoder.decode());

    return { code: status.code, output: report.join("") };
  });
}

function* write(target: string, file: string, source: string): Operation<void> {
  const destination = path.join(target, file);
  yield* ensureDir(path.dirname(destination));
  yield* writeTextFile(destination, source);
}

function* append(target: string, file: string, source: string): Operation<void> {
  const destination = path.join(target, file);
  const before = yield* readTextFile(destination);
  yield* writeTextFile(destination, `${before}\n${source}`);
}

/** A module under a first-party source directory that nothing imports. */
const UNREFERENCED_FILE = "packages/core/src/dead-code-probe.ts";

/** A module the import graph already reaches, so only the new export is dead. */
const REACHED_MODULE = "packages/core/src/expansion.ts";

/** The same, for a type: a module whose types other modules already import. */
const REACHED_TYPES = "packages/cli/src/repl/route.ts";

const DEAD_FUNCTION = `export function deadCodeProbe(): string {
  return "dead";
}
`;

const DEAD_TYPE = `export type DeadCodeProbe = { readonly dead: true };
`;

/**
 * Modules nothing imports on purpose, which the gate must not call dead.
 *
 * Each one is reached by something the import graph cannot see — a consumer of
 * the published package, the runtime that starts a command, the browser, a
 * document that names a component, or a subprocess a test spawns — so a gate
 * that reported these would be unusable and a gate that found them by widening
 * its entry points to whole source directories would report nothing at all.
 */
const REACHED_OTHERWISE: readonly { readonly file: string; readonly source: string }[] = [
  {
    file: "site/routes/dead-code-probe.tsx",
    source: "export default function Probe() {\n  return null;\n}\n",
  },
  {
    file: "site/islands/DeadCodeProbe.tsx",
    source: "export default function Probe() {\n  return null;\n}\n",
  },
  { file: "scripts/dead-code-probe.ts", source: DEAD_FUNCTION },
  { file: "smoke-test/dead-code-probe.ts", source: DEAD_FUNCTION },
  { file: "packages/core/tests/fixtures/dead-code-probe.ts", source: DEAD_FUNCTION },
  { file: "packages/git/tests/components/DeadCodeProbe.ts", source: DEAD_FUNCTION },
  { file: "packages/web/examples/dead-code-probe.ts", source: DEAD_FUNCTION },
];

describe("the repository-wide dead-code gate", () => {
  it("reports nothing on the committed tree", function* () {
    const target = yield* clone();

    const report = yield* runDeadCode(target);

    expect(report.output).toEqual("");
    expect(report.code).toEqual(0);
  });

  it("rejects an unreferenced first-party source file, and passes once it is gone", function* () {
    const target = yield* clone();

    yield* write(target, UNREFERENCED_FILE, DEAD_FUNCTION);
    const rejected = yield* runDeadCode(target);

    expect(rejected.code).toEqual(1);
    expect(rejected.output).toContain("Unused files");
    expect(rejected.output).toContain(UNREFERENCED_FILE);

    yield* rm(path.join(target, UNREFERENCED_FILE));

    expect((yield* runDeadCode(target)).code).toEqual(0);
  });

  it("rejects an unused export on a module the graph already reaches", function* () {
    const target = yield* clone();
    const before = yield* readTextFile(path.join(target, REACHED_MODULE));

    yield* append(target, REACHED_MODULE, DEAD_FUNCTION);
    const rejected = yield* runDeadCode(target);

    expect(rejected.code).toEqual(1);
    expect(rejected.output).toContain("Unused exports");
    expect(rejected.output).toContain("deadCodeProbe");
    expect(rejected.output).toContain(REACHED_MODULE);

    yield* writeTextFile(path.join(target, REACHED_MODULE), before);

    expect((yield* runDeadCode(target)).code).toEqual(0);
  });

  it("rejects an unused exported type", function* () {
    const target = yield* clone();
    const before = yield* readTextFile(path.join(target, REACHED_TYPES));

    yield* append(target, REACHED_TYPES, DEAD_TYPE);
    const rejected = yield* runDeadCode(target);

    expect(rejected.code).toEqual(1);
    expect(rejected.output).toContain("Unused exported types");
    expect(rejected.output).toContain("DeadCodeProbe");
    expect(rejected.output).toContain(REACHED_TYPES);

    yield* writeTextFile(path.join(target, REACHED_TYPES), before);

    expect((yield* runDeadCode(target)).code).toEqual(0);
  });

  it("keeps public exports, entry points and dynamically loaded modules clean", function* () {
    const target = yield* clone();

    // A published package export has no internal consumer by definition, and
    // removing one is a compatibility break rather than a cleanup.
    yield* append(target, "packages/core/api.ts", DEAD_FUNCTION);
    for (const { file, source } of REACHED_OTHERWISE) {
      yield* write(target, file, source);
    }

    const report = yield* runDeadCode(target);

    expect(report.output).toEqual("");
    expect(report.code).toEqual(0);
  });
});
