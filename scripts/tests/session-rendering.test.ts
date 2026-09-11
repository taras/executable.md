/**
 * One session view, proved from source and from a binary.
 *
 * A terminal session is the one part of this system nothing could test: the
 * rendering path only existed inside a running agent UI, so a regression in how
 * a message is selected, replaced, coalesced, scrolled or repainted showed up
 * to a person rather than to a suite. This drives the whole path headlessly —
 * `@bomb.sh/tty` does layout, input decoding and ANSI in pure computation with
 * no terminal attached — and asks it the questions a person would notice:
 * does the right presentation render, does a streaming replacement land in
 * place, does a backlog collapse to its latest revision, does the view stay
 * where the reader put it across an append and a resize, and does an update
 * cost less than a repaint.
 *
 * Every claim has a control that breaks it. Each control is one value from a
 * closed enum, run in a process of its own, and the same invariant checker that
 * admits the positive journey has to reject it by name — so a claim that had
 * stopped being checked fails here instead of passing quietly.
 *
 * The journey runs twice: once from TypeScript under Deno, once from a
 * `deno compile` executable started outside this checkout. A binary that lost
 * an embedded component has nothing to fall back on, so the two records are
 * required to be equal in whole. Neither run may reach the network, spawn a
 * process, write, or read the host beyond the proof's own component roots.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { useTempDirectory } from "@executablemd/test-support/temp";
import { exec } from "@effectionx/process";
import type { ProcessResult } from "@effectionx/process";
import { readTextFile } from "@effectionx/fs";
import { useQuietProcessOutput } from "@executablemd/runtime";
import { scoped } from "effection";
import type { Operation } from "effection";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  categoriesOf,
  checkJourney,
  checkProductionBoundary,
  compareRecords,
  parseJourneyReport,
  PRESENTATION_COMPONENTS,
} from "./session-rendering/evidence.ts";
import type { InvariantCategory } from "./session-rendering/evidence.ts";
import {
  JOURNEY_MUTATIONS,
  REPORT_SCHEMA,
  TTY_PACKAGE,
  TTY_VERSION,
} from "./session-rendering/journey.ts";
import { listWorkspacePaths } from "../lib/workspace.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const PROOF = "scripts/tests/session-rendering";
const ENTRYPOINT = `${PROOF}/entrypoint.ts`;
/** The one asset outside the proof directory an execution reads: core's own catalog. */
const CORE_DOCUMENTATION = "packages/core/src/components/components.md";

/**
 * What neither journey may do.
 *
 * Five of the six are refused outright. Environment is not, and cannot be: the
 * module graph an execution loads probes `process.env` while it is still being
 * imported — `which` reads `OSTYPE`, and `debug` enumerates the whole
 * environment — so a process that denied it could not reach this proof's own
 * code at all. Environment authority is therefore withheld where a document can
 * see it instead: nothing installs a host `Env` provider, and the document
 * filesystem ledger below records every path either journey asked for.
 */
const DENIED = ["--deny-net", "--deny-write", "--deny-run", "--deny-sys", "--deny-ffi"];

/** The smallest read grant either journey needs, spelled the same way for both. */
const READABLE = `${PROOF},packages/core/src`;

const RESOLUTION = ["--frozen", "--cached-only", "--node-modules-dir=none"];

const EMBEDDED = [PROOF + "/defaults", PROOF + "/repository", CORE_DOCUMENTATION];

/**
 * One child process, with its standard output collected rather than echoed.
 *
 * A journey's stdout *is* the answer these cases read, so displaying it as well
 * would put a whole evidence record into the suite's own output for every run.
 * `stderr` is left alone: that is where a failing child explains itself.
 */
function quietly(command: string, argv: string[], cwd: string): Operation<ProcessResult> {
  return scoped(function* () {
    yield* useQuietProcessOutput();
    return yield* exec(command, { arguments: argv, cwd }).join();
  });
}

/** The journey under Deno, reading its components out of the checkout. */
function sourceRun(mutation?: string): Operation<ProcessResult> {
  return quietly(
    Deno.execPath(),
    [
      "run",
      ...RESOLUTION,
      `--allow-read=${READABLE}`,
      "--allow-env",
      ...DENIED,
      ENTRYPOINT,
      ...(mutation === undefined ? [] : [mutation]),
    ],
    ROOT,
  );
}

/** `run`, having exited zero, or a failure carrying what it printed. */
function succeeded(run: ProcessResult, what: string): ProcessResult {
  if (run.code !== 0) {
    throw new Error(`${what} exited ${run.code}\n${run.stdout}\n${run.stderr}`);
  }
  return run;
}

/** Exactly one JSON record, or a failure that says what the process printed. */
function recordOf(run: ProcessResult, what: string): unknown {
  const lines = run.stdout.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length !== 1) {
    throw new Error(
      `${what} printed ${lines.length} stdout records, not one\n${run.stdout}\n${run.stderr}`,
    );
  }
  return JSON.parse(lines[0]);
}

function outcomeOf(record: unknown): string {
  if (typeof record === "object" && record !== null && "outcome" in record) {
    const outcome = Reflect.get(record, "outcome");
    return typeof outcome === "string" ? outcome : "unknown";
  }
  return "report";
}

function categoriesIn(record: unknown): string[] {
  if (typeof record === "object" && record !== null && "categories" in record) {
    const categories = Reflect.get(record, "categories");
    if (Array.isArray(categories)) {
      return categories.map((category) => String(category));
    }
  }
  return [];
}

function detailOf(record: unknown): string {
  return JSON.stringify(record).slice(0, 2000);
}

describe("the session rendering proof", { sanitizeOps: false, sanitizeResources: false }, () => {
  it("renders the same versioned journey from source and from a compiled executable", function* () {
    const source = succeeded(yield* sourceRun(), "the source journey");
    const sourceRecord = recordOf(source, "the source journey");
    expect(outcomeOf(sourceRecord)).toBe("report");

    const build = yield* useTempDirectory("xmd-session-rendering-build-");
    const binary = join(build, "session-rendering");
    const compiled = yield* quietly(
      Deno.execPath(),
      [
        "compile",
        ...RESOLUTION,
        "--exclude-unused-npm",
        `--allow-read=${READABLE}`,
        "--allow-env",
        ...DENIED,
        ...EMBEDDED.flatMap((asset) => ["--include", asset]),
        "--output",
        binary,
        ENTRYPOINT,
      ],
      ROOT,
    );
    succeeded(compiled, "the compile");

    // Somewhere that is not the checkout: a binary that resolved a component
    // through the working directory would find nothing here, so what it
    // renders is what `--include` embedded and nothing else.
    const elsewhere = yield* useTempDirectory("xmd-session-rendering-run-");
    const binaryRun = yield* quietly(binary, [], elsewhere);
    succeeded(binaryRun, "the compiled journey");
    const compiledRecord = recordOf(binaryRun, "the compiled journey");

    expect(compareRecords(sourceRecord, compiledRecord)).toEqual([]);

    const parsed = parseJourneyReport(sourceRecord);
    expect(parsed.schema).toBe(REPORT_SCHEMA);
    expect(parsed.dependency).toEqual({ name: TTY_PACKAGE, version: TTY_VERSION });
    expect(checkJourney(parsed)).toEqual([]);

    // The seven names, where each resolved, and the one that came from the
    // repository root rather than from the defaults beneath it.
    expect(parsed.presentations.map((one) => one.component)).toEqual(PRESENTATION_COMPONENTS);
    expect(
      parsed.presentations
        .filter((one) => one.root === "repository/components")
        .map((one) => one.component),
    ).toEqual(["Session.Message.Tool"]);

    // An incremental update that is cheaper than a repaint, measured rather
    // than spelled: neither the bytes nor the escape sequence is written down
    // anywhere here.
    expect(parsed.diff.incrementalBytes).toBeGreaterThan(0);
    expect(parsed.diff.incrementalBytes).toBeLessThan(parsed.diff.freshBytes);

    // Nothing either journey asked the document filesystem for was outside
    // the proof's own roots, and five authorities were refused outright.
    expect(parsed.files.filter((request) => !request.admitted)).toEqual([]);
    for (const authority of ["net", "write", "run", "sys", "ffi"]) {
      expect(parsed.authorities[authority]).toBe("denied");
    }
  });

  describe("every claim has a control that breaks it", () => {
    const EXPECTED: Record<string, InvariantCategory> = {
      "omit-component": "presentation-selection",
      "default-before-repository": "override-precedence",
      "plain-markdown": "structured-markdown",
      "unstable-regions": "stable-replacement",
      "no-coalescing": "coalescing",
      "forced-follow": "follow-unread",
      "row-offset-viewport": "resize-preservation",
      "whole-history-repaint": "bounded-diff",
      "forbidden-read": "forbidden-integration",
    };

    it("names every mutation exactly once", function* () {
      expect([...JOURNEY_MUTATIONS].sort()).toEqual(Object.keys(EXPECTED).sort());
    });

    for (const mutation of JOURNEY_MUTATIONS) {
      it(`rejects ${mutation} as ${EXPECTED[mutation]}`, function* () {
        const run = yield* sourceRun(mutation);
        const record = recordOf(run, `the ${mutation} control`);
        // Exit status separates a named rejection from an accident: a control
        // that crashed, or one nobody caught, is not a control.
        succeeded(run, `the ${mutation} control`);
        expect(outcomeOf(record)).toBe("rejected");
        expect(categoriesIn(record)).toContain(EXPECTED[mutation]);
      });
    }

    it("proves the scroll transition is necessary, not incidental", function* () {
      const run = yield* sourceRun("forced-follow");
      const record = recordOf(run, "the forced-follow control");
      expect(categoriesIn(record)).toContain("history-and-newest");
      expect(categoriesIn(record)).toContain("follow-unread");
    });
  });

  describe("the host pair and the private boundary", () => {
    it("rejects a compiled record that lost or changed a member", function* () {
      const source = succeeded(yield* sourceRun(), "the source journey");
      const record = recordOf(source, "the source journey");
      expect(typeof record).toBe("object");
      if (typeof record !== "object" || record === null) {
        throw new Error("the source journey printed no record to compare against");
      }

      const withoutMember = { ...record };
      Reflect.deleteProperty(withoutMember, "presentations");
      expect(compareRecords(record, withoutMember).join("; ")).toContain("presentations");

      const mismatched = { ...record, dependency: { name: TTY_PACKAGE, version: "0.8.0" } };
      expect(compareRecords(record, mismatched).join("; ")).toContain("0.8.0");

      // And a record identical to itself names no difference at all, so the
      // comparison above is not passing because everything differs.
      expect(compareRecords(record, record)).toEqual([]);
    });

    it("keeps the proof and its dependency out of every production package", function* () {
      const surface = yield* productionSurface();
      expect(Object.keys(surface.dependencies).length).toBeGreaterThan(0);
      expect(checkProductionBoundary(surface)).toEqual([]);

      expect(
        checkProductionBoundary({
          dependencies: { "packages/core/package.json": ["@bomb.sh/tty"] },
          exports: {},
        }),
      ).toEqual(["packages/core/package.json depends on @bomb.sh/tty"]);
      expect(
        checkProductionBoundary({
          dependencies: {},
          exports: { "packages/core/deno.json": ["./scripts/tests/session-rendering/journey.ts"] },
        }),
      ).toHaveLength(1);
    });
  });

  it("is admitted by the checker only when nothing is wrong with it", function* () {
    const source = succeeded(yield* sourceRun(), "the source journey");
    const parsed = parseJourneyReport(recordOf(source, "the source journey"));
    expect(categoriesOf(checkJourney(parsed))).toEqual([]);

    // The checker is not vacuous: a record with its history emptied is
    // rejected by the claims that read history.
    const emptied = parseJourneyReport({ ...JSON.parse(JSON.stringify(parsed)), history: [] });
    expect(categoriesOf(checkJourney(emptied))).toContain("stable-replacement");
  });
});

/**
 * Every dependency a shipped package declares and every specifier it publishes.
 *
 * The root manifest's own `devDependencies` are deliberately absent: that is
 * where the exact `@bomb.sh/tty` pin belongs, and reading it here would make
 * the boundary check pass or fail for the wrong reason.
 */
function* productionSurface(): Operation<{
  dependencies: Record<string, string[]>;
  exports: Record<string, string[]>;
}> {
  const dependencies: Record<string, string[]> = {};
  const exports: Record<string, string[]> = {};

  const root = new URL("../../", import.meta.url);
  const manifest = JSON.parse(yield* readTextFile(new URL("deno.json", root)));
  const members = yield* listWorkspacePaths(manifest.workspace, root);

  dependencies["package.json"] = names(
    JSON.parse(yield* readTextFile(new URL("package.json", root))).dependencies,
  );

  for (const member of members) {
    for (const file of ["package.json", "deno.json"]) {
      const url = new URL(`${member}/${file}`, root);
      let source: string;
      try {
        source = yield* readTextFile(url);
      } catch {
        continue;
      }
      const parsed = JSON.parse(source);
      dependencies[`${member}/${file}`] = [
        ...names(parsed.dependencies),
        ...names(parsed.devDependencies),
        ...names(parsed.imports),
      ];
      exports[`${member}/${file}`] = specifiers(parsed.exports);
    }
  }
  return { dependencies, exports };
}

function names(value: unknown): string[] {
  return typeof value === "object" && value !== null ? Object.keys(value) : [];
}

function specifiers(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (typeof value !== "object" || value === null) {
    return [];
  }
  return Object.values(value).flatMap((entry) => specifiers(entry));
}
