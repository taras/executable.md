/**
 * Rule tests for `local/no-sync-filesystem` (scripts/oxlint-rules).
 *
 * The fixtures cover what the rule recognizes and what it leaves alone. The
 * repository tests cover the other half of the policy: a suppression is a
 * single line with a stated reason, and there is no broad exemption anywhere on
 * the lint surface — neither a file-wide directive nor a configuration entry
 * that turns the rule off for a path.
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { readTextFile, walk } from "@effectionx/fs";
import { each } from "effection";
import type { Operation } from "effection";
import path from "node:path";

import { oxlint, ROOT, violations } from "./oxlint.ts";

const RULE = "no-sync-filesystem";

/** The directories `deno task lint` passes to oxlint. */
const LINTED = ["packages", "scripts", ".reviews/components"];

/** What the lint task's `--ignore-pattern` arguments keep out. */
const UNLINTED = [
  `${path.sep}npm${path.sep}`,
  path.join("scripts", "tests", "fixtures"),
  path.join("packages", "workflow", "vendor", "cloudflare-computer-dofs"),
  `${path.sep}node_modules${path.sep}`,
];

/** A whole-file directive, as opposed to `-next-line` or `-line`. */
const FILE_WIDE = /(?:oxlint|eslint)-disable(?!-next-line|-line)[^\n]*no-sync-filesystem/u;

const NARROW = /oxlint-disable-next-line[^\n]*local\/no-sync-filesystem/u;

function reported(fixture: string): Operation<number[]> {
  return violations(`scripts/tests/fixtures/${fixture}`, RULE);
}

/** The rule's own diagnostics for a fixture, in source order. */
function* diagnostics(fixture: string): Operation<{ message: string }[]> {
  const output = yield* oxlint(["--format=json", `scripts/tests/fixtures/${fixture}`]);
  const report: { diagnostics: { code: string; message: string }[] } = JSON.parse(output);

  return report.diagnostics.filter((entry) => entry.code === `local(${RULE})`);
}

/** Every file `deno task lint` actually reads. */
function* linted(): Operation<string[]> {
  const files: string[] = [];
  for (const directory of LINTED) {
    const entries = walk(path.join(ROOT, directory), {
      includeDirs: false,
      skip: [/node_modules/u, /[/\\]npm[/\\]/u],
    });
    for (const entry of yield* each(entries)) {
      if (
        /\.(?:ts|tsx|js|mjs|cjs)$/u.test(entry.path) &&
        !UNLINTED.some((fragment) => entry.path.includes(fragment))
      ) {
        files.push(entry.path);
      }
      yield* each.next();
    }
  }
  return files;
}

describe("local/no-sync-filesystem", () => {
  /**
   * In fixture order: a directory listing, a text read and write, metadata, a
   * link target, a canonical path, and a removal, then the same global reached
   * through `globalThis` — once by name and once by a member spelled out as a
   * string.
   */
  it("reports the filesystem members of the Deno global", function* () {
    expect(yield* reported("sync-deno-filesystem.ts")).toEqual([
      5, 9, 10, 12, 13, 14, 15, 22, 23, 28, 29, 31, 32,
    ]);
  });

  /** Lines 28, 29, 31 and 32 above: the stdio descriptors and an opened one. */
  it("reports the descriptors the Deno global exposes and the ones it opens", function* () {
    const lines = yield* reported("sync-deno-filesystem.ts");

    expect(lines).toContain(28);
    expect(lines).toContain(29);
    expect(lines).toContain(32);
  });

  /**
   * In fixture order: three members of a default import — the last named by a
   * string — two of a namespace import, the second reached past the member
   * itself, then a named import and one imported under another name.
   */
  it("reports node:fs through default, namespace, named and aliased imports", function* () {
    expect(yield* reported("sync-node-filesystem.ts")).toEqual([10, 11, 12, 17, 18, 23, 24]);
  });

  /** The repository's own synchronous filesystem, by module and export. */
  it("reports the vendored DOFS filesystem bindings", function* () {
    expect(yield* reported("sync-dofs-filesystem.ts")).toEqual([7, 8]);
  });

  it("accepts synchronous functions that no filesystem binding names", function* () {
    expect(yield* reported("sync-named-not-filesystem.ts")).toEqual([]);
  });

  /**
   * Subprocess output is not filesystem work, a `Deno` of somebody's own is a
   * different value, and neither a type-only import nor `node:fs/promises`
   * binds one.
   */
  it("accepts shadowed bindings, type imports and the asynchronous form", function* () {
    const deno = yield* reported("sync-deno-filesystem.ts");
    expect(deno).not.toContain(40);
    expect(deno).not.toContain(45);

    const node = yield* reported("sync-node-filesystem.ts");
    expect(node).not.toContain(29);
    expect(node).not.toContain(34);
    expect(node).not.toContain(43);
    expect(node).not.toContain(48);
  });

  it("names both accepted destinations in the diagnostic", function* () {
    const report = yield* diagnostics("sync-node-filesystem.ts");

    expect(report[0].message).toContain("@effectionx/fs operation");
    expect(report[0].message).toContain("Effection operation");
    expect(report[0].message).not.toContain("await");
  });

  it("suppresses the line a narrow directive covers, and no other", function* () {
    expect(yield* reported("sync-filesystem-suppressed.ts")).toEqual([23]);
  });

  /**
   * A file-wide directive silences every call below it while stating an
   * invariant for none of them. Nothing is reported here, which is exactly why
   * the form is forbidden and why the repository is checked for it below.
   */
  it("is silenced entirely by a file-wide exemption", function* () {
    expect(yield* reported("sync-filesystem-exempted.ts")).toEqual([]);
  });

  it("finds no broad exemption anywhere on the lint surface", function* () {
    const exempted: string[] = [];
    for (const file of yield* linted()) {
      if (FILE_WIDE.test(yield* readTextFile(file))) {
        exempted.push(path.relative(ROOT, file));
      }
    }

    expect(exempted).toEqual([]);
  });

  it("finds no configuration entry turning the rule off for a path", function* () {
    for (const config of [".oxlintrc.json", "oxlint.shared.json", ".reviews/.oxlintrc.json"]) {
      const source = yield* readTextFile(path.join(ROOT, config));
      const off = /"local\/no-sync-filesystem":\s*(?:"off"|\["off")/u.test(source);
      expect([config, off]).toEqual([config, false]);
    }
  });

  it("keeps every suppression narrow and explained", function* () {
    const unexplained: string[] = [];
    for (const file of yield* linted()) {
      const lines = (yield* readTextFile(file)).split("\n");
      for (const [index, line] of lines.entries()) {
        if (!NARROW.test(line)) {
          continue;
        }
        // The invariant is stated above the directive, in the comment block or
        // the comment lines that lead into it.
        const preceding = lines
          .slice(Math.max(0, index - 8), index)
          .filter((entry) => /^\s*(?:\/\/|\*|\/\*)/u.test(entry))
          .filter((entry) => !NARROW.test(entry));
        if (preceding.length === 0) {
          unexplained.push(`${path.relative(ROOT, file)}:${index + 1}`);
        }
      }
    }

    expect(unexplained).toEqual([]);
  });

  /**
   * Non-vacuous on both sweeps: they have files to read and suppressions to
   * look at, and the pattern that finds no broad exemption above does find the
   * one the fixture carries.
   */
  it("sweeps a populated lint surface with a pattern that matches", function* () {
    const files = yield* linted();
    let suppressions = 0;
    for (const file of files) {
      suppressions += (yield* readTextFile(file))
        .split("\n")
        .filter((line) => NARROW.test(line)).length;
    }

    expect(files.length).toBeGreaterThan(100);
    expect(suppressions).toBeGreaterThan(0);

    const exempted = yield* readTextFile(
      path.join(ROOT, "scripts/tests/fixtures/sync-filesystem-exempted.ts"),
    );
    expect(FILE_WIDE.test(exempted)).toBe(true);
    expect(NARROW.test(exempted)).toBe(false);
  });
});
