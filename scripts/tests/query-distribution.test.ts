/**
 * Tier QDIST — the query engine in every distribution this repository ships.
 *
 * `<Query>` and `<Yaml>` reach their expression language through one published
 * package whose root export compiles embedded WebAssembly during its own
 * top-level await, loaded through a dynamic import. Each of those is a thing a
 * distribution can lose: a module graph may omit a specifier nothing statically
 * imports, a compiled binary has no `node_modules` to fall back to, and a
 * published package carries whatever its emitted manifest declares.
 *
 * So one document is run five ways and compared against the source reading of
 * it: under Deno, under Node through the repository's own loader, under Bun,
 * from one compiled host binary, and from the built npm closure packed and
 * installed into a directory of its own. The document reads a file, decodes it
 * explicitly, queries a globbed list, renders both ways and prints each unbound
 * type — so a distribution that loaded the engine but lost a capability fails
 * here rather than at a reader's first document.
 *
 * One compile and one closure build, reused by every consumption below. The
 * cwd of each consumption holds the fixture and nothing else: no checkout, no
 * `node_modules` beside it, and — for the compiled binary — no executable on
 * `PATH` at all, because an engine that shelled out to a `yq` on the machine
 * would otherwise pass this.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { useTempDirectory } from "@executablemd/test-support/temp";
import { scoped, until } from "effection";
import type { Operation } from "effection";
import { exec, Stdio } from "@effectionx/process";
import type { ProcessResult } from "@effectionx/process";
import { timebox } from "@effectionx/timebox";
import { ensureDir, exists, readTextFile, writeTextFile } from "@effectionx/fs";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "../lib/compile.ts";
import { useNpmWorkspace } from "./npm-output.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** dnt's install and type-check dominate the closure build. */
const TIMEOUT = 900_000;

/** The one document every distribution runs. */
const DOCUMENT = [
  '<File path="input.json" as="text" />',
  "",
  `<Query value={text} yq='from_json | [.checks[] | select(.ok == false) | .name]' as="failing" />`,
  "",
  '<Glob include={["input.json"]} as="paths" />',
  "",
  `<Query value={paths} yq='[.[] | {"path": .}]' as="listed" />`,
  "",
  "JSON:<Json value={failing} />",
  "",
  "YAML:<Yaml value={failing} />",
  "",
  'OBJ:<Query value={listed} yq=".[0]" />',
  "",
  'FALSE:<Query value={text} yq="from_json | .checks[0].ok | not" />',
  "",
  'NULL:<Query value={text} yq="from_json | .missing" />',
  "",
  'EMPTY:<Query value={text} yq="[from_json | .missing[]?]" />',
  "",
].join("\n");

/** Its input, with a next marker nothing is allowed to follow. */
const INPUT = JSON.stringify(
  {
    service: "api",
    checks: [
      { name: "boot", ok: true },
      { name: "ping", ok: false },
    ],
    next: "cursor-2",
  },
  null,
  2,
);

/** A directory holding the fixture and nothing else. */
function* useDocument(): Operation<string> {
  const dir = yield* useTempDirectory("xmd-query-dist-");
  yield* writeTextFile(path.join(dir, "input.json"), INPUT);
  yield* writeTextFile(path.join(dir, "doc.md"), DOCUMENT);
  return dir;
}

function* run(
  command: string,
  args: readonly string[],
  cwd: string,
  env?: Record<string, string>,
): Operation<ProcessResult> {
  const attempt = yield* timebox<ProcessResult>(TIMEOUT, function* () {
    return yield* exec(command, {
      arguments: [...args],
      cwd,
      ...(env === undefined ? {} : { env }),
    }).join();
  });
  if (attempt.timeout) {
    throw new Error(`${command} timed out`);
  }
  return attempt.value;
}

/** What each distribution has to say, read as the operator reads it. */
function reading(result: ProcessResult): string {
  if (result.code !== 0) {
    throw new Error(`the distribution exited ${result.code}\n${result.stderr}`);
  }
  expect(result.stdout).not.toContain("ERROR");
  return result.stdout.trim();
}

/** Every selected value and both renderings, as one comparable text. */
function selections(output: string): string[] {
  return output
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line !== "");
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * What one launch was, as the log keeps it.
 *
 * The identities belong in the output rather than only in an assertion: a
 * passing consumption says that some artifact ran, and this says which one,
 * from where, under which runtime, before the owned scratch is released.
 */
interface Launch {
  readonly distribution: string;
  readonly command: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly runtime: string;
  /** A child killed by a signal reports none, which is not a success. */
  readonly exit: number | undefined;
}

/** Everything one run of this tier observed, printed as its own evidence. */
interface Evidence {
  readonly artifacts: Record<string, { readonly bytes: number; readonly sha256: string }>;
  readonly emitted: Record<string, string>;
  readonly launches: Launch[];
}

function record(
  evidence: Evidence,
  distribution: string,
  command: string,
  argv: readonly string[],
  cwd: string,
  runtime: string,
  result: ProcessResult,
): string {
  evidence.launches.push({ distribution, command, argv, cwd, runtime, exit: result.code });
  return reading(result);
}

/** The version string one runtime reports for itself. */
function* runtimeVersion(command: string, args: readonly string[], cwd: string): Operation<string> {
  const reported = yield* run(command, args, cwd);
  return reported.stdout.trim().split("\n")[0] ?? "";
}

function report(evidence: Evidence): void {
  console.log(`QDIST evidence: ${JSON.stringify(evidence, null, 2)}`);
}

describe(
  "Tier QDIST — one document, every distribution",
  {
    sanitizeOps: false,
    sanitizeResources: false,
  },
  () => {
    it("QD1: the three source runtimes select, render and print the same values", function* () {
      const dir = yield* useDocument();
      const evidence: Evidence = { artifacts: {}, emitted: {}, launches: [] };

      const denoArgv = [
        "run",
        "--allow-all",
        "--cached-only",
        "--frozen",
        "--config",
        path.join(ROOT, "deno.json"),
        path.join(ROOT, "packages/cli/src/deno.ts"),
        "run",
        "doc.md",
      ];
      const deno = record(
        evidence,
        "source deno",
        Deno.execPath(),
        denoArgv,
        dir,
        yield* runtimeVersion(Deno.execPath(), ["--version"], dir),
        yield* run(Deno.execPath(), denoArgv, dir),
      );

      // The selected values, both renderings and each unbound type.
      expect(selections(deno)).toEqual([
        "JSON:[",
        '  "ping"',
        "]",
        "YAML:- ping",
        "OBJ:{",
        '  "path": "input.json"',
        "}",
        "FALSE:false",
        "NULL:null",
        "EMPTY:[]",
      ]);
      // The page it was given, and no next page: the marker is in the file and
      // nothing followed it.
      expect(deno).not.toContain("cursor-2");

      const nodeArgv = [
        "--tsconfig",
        path.join(ROOT, "tsconfig.node.json"),
        path.join(ROOT, "packages/cli/src/node.ts"),
        "run",
        "doc.md",
      ];
      const node = record(
        evidence,
        "source node (repository tsx loader)",
        path.join(ROOT, "node_modules/.bin/tsx"),
        nodeArgv,
        dir,
        yield* runtimeVersion("node", ["--version"], dir),
        yield* run(path.join(ROOT, "node_modules/.bin/tsx"), nodeArgv, dir),
      );

      const bunArgv = [path.join(ROOT, "packages/cli/src/bun.ts"), "run", "doc.md"];
      const bun = record(
        evidence,
        "source bun",
        "bun",
        bunArgv,
        dir,
        yield* runtimeVersion("bun", ["--version"], dir),
        yield* run("bun", bunArgv, dir),
      );

      expect(selections(node)).toEqual(selections(deno));
      expect(selections(bun)).toEqual(selections(deno));
      expect(evidence.launches.map((launch) => launch.exit)).toEqual([0, 0, 0]);
      report(evidence);
    });

    it("QD2: one compiled host binary runs it with no checkout and no PATH", function* () {
      const dir = yield* useDocument();
      const scratch = yield* useTempDirectory("xmd-query-binary-");
      const binary = path.join(scratch, "xmd");

      // The canonical compile, once, with the repository's own flags.
      yield* scoped(function* () {
        yield* Stdio.around({
          *stdout() {},
          *stderr() {},
        });
        yield* compile({ output: binary });
      });

      const evidence: Evidence = { artifacts: {}, emitted: {}, launches: [] };
      const bytes = yield* until(readFile(binary));
      // Which binary ran, by its own bytes, recorded while it still exists.
      evidence.artifacts[path.basename(binary)] = {
        bytes: bytes.byteLength,
        sha256: digest(bytes),
      };

      // Nothing on PATH, so an engine that reached for a `yq` executable has
      // none to find, and nothing beside the document to resolve from.
      const compiled = record(
        evidence,
        "compiled host binary",
        binary,
        ["run", "doc.md"],
        dir,
        yield* runtimeVersion(binary, ["--version"], dir),
        yield* run(binary, ["run", "doc.md"], dir, { HOME: scratch, PATH: "" }),
      );

      expect(selections(compiled)).toEqual([
        "JSON:[",
        '  "ping"',
        "]",
        "YAML:- ping",
        "OBJ:{",
        '  "path": "input.json"',
        "}",
        "FALSE:false",
        "NULL:null",
        "EMPTY:[]",
      ]);

      // The same bytes afterwards: the hash above names what actually ran.
      const after = yield* until(readFile(binary));
      expect(digest(after)).toBe(evidence.artifacts[path.basename(binary)]?.sha256);
      expect(evidence.launches.map((launch) => launch.exit)).toEqual([0]);
      report(evidence);
    });

    it("QD3: the built npm closure declares the engine and runs it under Node and Bun", function* () {
      const dir = yield* useDocument();
      const workspace = yield* useNpmWorkspace();
      const evidence: Evidence = { artifacts: {}, emitted: {}, launches: [] };
      const version = "0.0.0-query-distribution";

      const built = yield* scoped(function* () {
        yield* Stdio.around({
          *stdout() {},
          *stderr() {},
        });
        return yield* run(
          Deno.execPath(),
          [
            "run",
            "-A",
            "--node-modules-dir=manual",
            "--cached-only",
            "--frozen",
            "scripts/build-npm.ts",
            "packages/cli",
            version,
          ],
          workspace,
          { ...Deno.env.toObject(), NPM_CONFIG_LEGACY_PEER_DEPS: "true" },
        );
      });
      if (built.code !== 0) {
        throw new Error(`build-npm.ts exited ${built.code}\n${built.stderr}`);
      }

      // The emitted manifest declares the exact pinned engine, which is what a
      // consumer installs: a build that dropped it would resolve nothing.
      const emitted = JSON.parse(
        yield* readTextFile(path.join(workspace, "packages/core/npm/package.json")),
      );
      expect(emitted.dependencies["yq.rs"]).toBe("0.1.4");
      evidence.emitted["core dependency"] = `yq.rs@${emitted.dependencies["yq.rs"]}`;

      // The specifier survived the build: a graph that dropped the literal
      // import would install the engine and never reach it.
      const emittedEngine = yield* readTextFile(
        path.join(workspace, "packages/core/npm/esm/src/components/query-engine.js"),
      );
      expect(emittedEngine).toContain('import("yq.rs")');
      evidence.emitted["core root import"] = 'import("yq.rs")';

      // The closure, packed as artifacts and installed into a directory of its
      // own — never resolved from the registry, and never from this checkout.
      const scratch = yield* useTempDirectory("xmd-query-closure-");
      const tarballs = path.join(scratch, "tarballs");
      const consumer = path.join(scratch, "consumer");
      yield* ensureDir(tarballs);
      yield* ensureDir(consumer);
      yield* writeTextFile(
        path.join(consumer, "package.json"),
        // React is the peer `@executablemd/web`'s form surface reaches through
        // `@rjsf`, and the CLI's module graph loads that surface at startup. An
        // ordinary consumer receives it as a resolved peer; this one declares
        // it, because the install below is told to resolve none.
        `${JSON.stringify(
          {
            name: "query-consumer",
            private: true,
            type: "module",
            dependencies: { react: "19.2.0", "react-dom": "19.2.0" },
          },
          null,
          2,
        )}\n`,
      );

      const members = (yield* until(
        readdir(path.join(workspace, "packages"), {
          withFileTypes: true,
        }),
      ))
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(workspace, "packages", entry.name, "npm"));
      for (const member of members) {
        const manifest = path.join(member, "package.json");
        if (!(yield* exists(manifest))) {
          continue;
        }
        const packed = yield* run(
          "npm",
          ["pack", "--silent", "--pack-destination", tarballs],
          member,
        );
        if (packed.code !== 0) {
          throw new Error(`npm pack failed in ${member}\n${packed.stderr}`);
        }
      }

      const artifacts = (yield* until(readdir(tarballs))).filter((name) => name.endsWith(".tgz"));
      for (const name of artifacts) {
        const packedBytes = yield* until(readFile(path.join(tarballs, name)));
        evidence.artifacts[name] = {
          bytes: packedBytes.byteLength,
          sha256: digest(packedBytes),
        };
      }
      // Every workspace member the CLI's closure holds, as artifacts this build
      // produced.
      expect(artifacts.length).toBeGreaterThanOrEqual(10);
      expect(artifacts).toContain(`executablemd-cli-${version}.tgz`);

      const installed = yield* run(
        "npm",
        [
          "install",
          "--no-audit",
          "--no-fund",
          "--legacy-peer-deps",
          ...artifacts.map((name) => path.join(tarballs, name)),
          "react@19.2.0",
          "react-dom@19.2.0",
        ],
        consumer,
      );
      if (installed.code !== 0) {
        throw new Error(`npm install failed\n${installed.stderr}`);
      }

      const bin = path.join(consumer, "node_modules/@executablemd/cli/esm/src/node.js");
      const consumed = JSON.parse(
        yield* readTextFile(path.join(consumer, "node_modules/@executablemd/core/package.json")),
      );
      // The installed copy, not the checkout: its own manifest names the version
      // this build emitted and the engine it declared.
      expect(consumed.dependencies["yq.rs"]).toBe("0.1.4");

      evidence.emitted["installed core dependency"] = `yq.rs@${consumed.dependencies["yq.rs"]}`;
      evidence.emitted["installed cli version"] = String(
        JSON.parse(
          yield* readTextFile(path.join(consumer, "node_modules/@executablemd/cli/package.json")),
        ).version,
      );

      const node = record(
        evidence,
        "packed npm closure under node",
        "node",
        [bin, "run", "doc.md"],
        dir,
        yield* runtimeVersion("node", ["--version"], dir),
        yield* run("node", [bin, "run", "doc.md"], dir),
      );
      const bun = record(
        evidence,
        "packed npm closure under bun",
        "bun",
        [bin, "run", "doc.md"],
        dir,
        yield* runtimeVersion("bun", ["--version"], dir),
        yield* run("bun", [bin, "run", "doc.md"], dir),
      );

      expect(selections(node)).toEqual([
        "JSON:[",
        '  "ping"',
        "]",
        "YAML:- ping",
        "OBJ:{",
        '  "path": "input.json"',
        "}",
        "FALSE:false",
        "NULL:null",
        "EMPTY:[]",
      ]);
      expect(selections(bun)).toEqual(selections(node));

      // Every artifact this build produced is named by its own hash, and the
      // two launches are recorded, before the owned scratch is released.
      expect(Object.keys(evidence.artifacts).length).toBe(artifacts.length);
      for (const artifact of Object.values(evidence.artifacts)) {
        expect(artifact.sha256).toMatch(/^[0-9a-f]{64}$/);
      }
      expect(evidence.launches.map((launch) => launch.exit)).toEqual([0, 0]);
      report(evidence);
    });
  },
);
