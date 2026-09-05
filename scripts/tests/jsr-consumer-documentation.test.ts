/**
 * Tier SYN — a JSR consumer's named lookup.
 *
 * `deno publish --dry-run` listing `components.md` proves the asset is in the
 * payload. It does not prove a consumer can *load* it: the module resolves the
 * asset from its own URL, and under JSR that URL is a published module URL
 * rather than a path in somebody's checkout. Only running a consumer answers
 * that.
 *
 * Staged rather than published, because publishing from a test is not a thing to
 * do: the package is copied to a directory outside the workspace, imported by a
 * consumer that has no access to this repository's import map, and asked for a
 * component's documentation. A build that shipped the module and not the asset,
 * or that resolved the asset relative to the process, fails here.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, until } from "effection";
import type { Operation } from "effection";
import { ensureDir, writeTextFile } from "@effectionx/fs";
import { exec } from "@effectionx/process";
import { timebox } from "@effectionx/timebox";
import type { ProcessResult } from "@effectionx/process";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const TIMEOUT = 120_000;

/** The consumer program: import core, build the index, print one entry. */
const CONSUMER = `
import { documentationIndexFor } from "@executablemd/core";
import { main } from "effection";

await main(function* () {
  const index = yield* documentationIndexFor();
  const elicit = index.documentationFor("Elicit", {
    kind: "registered",
    origin: "@executablemd/core",
    reserved: false,
  });
  const syntax = index.documentationFor("Syntax", {
    kind: "protected",
    origin: "@executablemd/core",
  });
  console.log(JSON.stringify({ elicit, syntax }));
});
`;

describe("Tier SYN — a staged JSR consumer", () => {
  it("SYN47: loads the packaged documentation from the published module layout", function* () {
    const staged = yield* until(mkdtemp(path.join(tmpdir(), "xmd-jsr-consumer-")));
    yield* ensure(function* () {
      yield* until(rm(staged, { recursive: true, force: true }));
    });

    // The packages as JSR would ship them: source trees, without the
    // repository's own tooling, node_modules or tests. Core's own workspace
    // siblings come too, because a JSR consumer resolves those as published
    // dependencies rather than as directories in somebody's checkout — and it
    // is core's asset resolution under test, not its dependency graph.
    const SIBLINGS = ["core", "runtime", "durable-streams", "acp"];
    const staging: Record<string, string> = {};
    for (const name of SIBLINGS) {
      const from = path.join(ROOT, "packages", name);
      const to = path.join(staged, name);
      yield* until(cp(from, to, { recursive: true }));
      for (const excluded of ["npm", "tests", "node_modules"]) {
        yield* until(rm(path.join(to, excluded), { recursive: true, force: true }));
      }
      staging[name] = to;
    }
    const pkg = staging.core ?? "";

    // A consumer with an import map of its own, naming the staged package by
    // path — which is what an installed JSR dependency looks like from the
    // consumer's side: a module tree somewhere else entirely.
    const consumer = path.join(staged, "consumer");
    yield* ensureDir(consumer);
    yield* writeTextFile(path.join(consumer, "main.ts"), CONSUMER);
    const rootImports = JSON.parse(
      yield* until(Deno.readTextFile(path.join(ROOT, "deno.json"))),
    ) as { imports: Record<string, string> };
    const imports: Record<string, string> = {};
    for (const [name, target] of Object.entries(rootImports.imports)) {
      if (target.startsWith("npm:") || target.startsWith("jsr:") || target.startsWith("http")) {
        imports[name] = target;
      }
    }
    // Each staged package's own `exports`, which is what a resolver uses: a
    // subpath like `@executablemd/runtime/files` names an export entry, not a
    // file called `files`.
    for (const [name, dir] of Object.entries(staging)) {
      const manifest = JSON.parse(yield* until(Deno.readTextFile(path.join(dir, "deno.json")))) as {
        exports?: Record<string, string> | string;
      };
      const exportsMap =
        typeof manifest.exports === "string" ? { ".": manifest.exports } : (manifest.exports ?? {});
      for (const [subpath, target] of Object.entries(exportsMap)) {
        const specifier =
          subpath === "."
            ? `@executablemd/${name}`
            : `@executablemd/${name}/${subpath.replace(/^\.\//, "")}`;
        imports[specifier] = path.join(dir, target);
      }
    }
    yield* writeTextFile(path.join(consumer, "deno.json"), JSON.stringify({ imports }, null, 2));

    const run = yield* timebox<ProcessResult>(TIMEOUT, function* () {
      return yield* exec(Deno.execPath(), {
        arguments: ["run", "--allow-all", "main.ts"],
        cwd: consumer,
        env: Deno.env.toObject(),
      }).join();
    });
    if (run.timeout) {
      throw new Error("the staged JSR consumer timed out");
    }
    if (run.value.code !== 0) {
      throw new Error(`the staged JSR consumer exited ${run.value.code}\n${run.value.stderr}`);
    }

    const loaded = JSON.parse(run.value.stdout) as {
      elicit?: string;
      syntax?: string;
    };

    // The asset loaded from the staged tree, not from this checkout: the
    // consumer's working directory is elsewhere and its import map names no
    // path inside the repository.
    expect(loaded.elicit).toContain("Asks a person a structured question");
    expect(loaded.syntax).toContain("Renders the catalog of components");

    // And byte-for-byte what the source tree serves for the same component.
    const fromSource = yield* timebox<ProcessResult>(TIMEOUT, function* () {
      return yield* exec(Deno.execPath(), {
        arguments: ["run", "-A", path.join(ROOT, "packages/cli/src/deno.ts"), "syntax", "Elicit"],
        cwd: ROOT,
      }).join();
    });
    if (fromSource.timeout) {
      throw new Error("the source CLI timed out");
    }
    expect(fromSource.value.stdout).toContain(loaded.elicit ?? "<missing>");
  });
});
