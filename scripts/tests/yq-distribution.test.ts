/**
 * The `yq` engine reaches every distribution, and only through the loader.
 *
 * `yq` selection and `<Yaml>` are one WebAssembly engine, and what makes it
 * present everywhere is that its bytes are **committed source**: a compiled
 * binary and an installed npm package each carry core's own module graph and
 * nothing beside it, so bytes reached through a path, a `fetch` or a host
 * filesystem API would work in a source checkout and be absent in both — and
 * the failure would reach only the published artifact.
 *
 * So these cases ask the artifacts rather than the source. One real compile and
 * one real npm build, each reused for every assertion made against it, because
 * compiling per scenario would spend minutes proving the same closure twice.
 *
 * The drift cases are separate and cheap. Generation is deliberate: nothing
 * regenerates those bytes on its way to doing something else, so what is
 * checked here is that `--check` reproduces them exactly, that it writes
 * nothing, and that the graph which carries them names the loader and never the
 * entry that instantiates a singleton.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { useTempDirectory } from "@executablemd/test-support/temp";
import { exec } from "@effectionx/process";
import { readTextFile, writeTextFile } from "@effectionx/fs";
import { until } from "effection";
import type { Operation } from "effection";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { compile, compileArguments, PACKAGED_NOTICES } from "../lib/compile.ts";
import { useNpmWorkspace } from "./npm-output.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

/**
 * Every published member the CLI's installed closure is made of.
 *
 * `packages/code-review-agent` is deliberately absent: it is published, and the
 * CLI does not depend on it, so building it here would cost a build to install
 * nothing.
 */
const CLOSURE: readonly string[] = [
  "packages/core",
  "packages/runtime",
  "packages/durable-streams",
  "packages/acp",
  "packages/git",
  "packages/test-agent",
  "packages/testing",
  "packages/web",
  "packages/workflow",
  "packages/cli",
];

/**
 * Each runtime's own source entrypoint, and how that runtime is started.
 *
 * Node reaches TypeScript through the repository's own `tsx`, which is what
 * `pnpm test:node` runs the corpus with; Bun and Deno read the source
 * directly. The paths are absolute so the document's directory stays a
 * directory holding only the document.
 */
const SOURCE_RUNTIMES: readonly (readonly [string, string, readonly string[]])[] = [
  [
    "deno",
    Deno.execPath(),
    [
      "run",
      "--allow-all",
      "--cached-only",
      "--frozen",
      fileURLToPath(new URL("../../packages/cli/src/deno.ts", import.meta.url)),
    ],
  ],
  [
    "node",
    fileURLToPath(new URL("../../node_modules/.bin/tsx", import.meta.url)),
    [fileURLToPath(new URL("../../packages/cli/src/node.ts", import.meta.url))],
  ],
  ["bun", "bun", [fileURLToPath(new URL("../../packages/cli/src/bun.ts", import.meta.url))]],
];

/** The pin, restated here so a changed dependency fails this suite too. */
const PINNED_VERSION = "0.1.0";
const PINNED_BYTES = 468387;
const PINNED_SHA256 = "97252eddd0dd7c2d80c25f8b73aec0874af954ca77ea33d8eb892c0a845eac46";

/**
 * The one document every distribution runs.
 *
 * Small on purpose, and complete: an explicit decode through `File`, a `Glob`
 * whose paths are selected, and both renderers over the selected data. A
 * distribution that carried the loader and not the bytes, or the bytes and not
 * the loader, fails on the first element.
 */
const DOCUMENT = [
  `<File path="input.json" yq='from_json | .records[0].name' as="first" />`,
  "",
  `<Glob include={["*.json"]} yq='[.[] | select(. == "input.json")]' as="paths" />`,
  "",
  "<Output>",
  "first: {first}",
  "",
  "<Json value={paths} />",
  "",
  "<Yaml value={paths} />",
  "</Output>",
  "",
].join("\n");

const FIXTURE = JSON.stringify({ records: [{ name: "widget" }] });

/** What every distribution has to say about that document. */
function held(output: string): void {
  expect(output).toContain("first: widget");
  // Json's text and Yaml's text, from one selected value.
  expect(output).toContain('"input.json"');
  expect(output).toContain("- input.json");
}

/** A directory holding the document and its fixture, and nothing else. */
function* useDocument(): Operation<string> {
  const root = yield* useTempDirectory("xmd-yq-document-");
  yield* writeTextFile(path.join(root, "input.json"), FIXTURE);
  yield* writeTextFile(path.join(root, "doc.md"), DOCUMENT);
  return root;
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("the generated yq bytes", () => {
  it("YD1: --check reproduces the committed module, provenance and notices", function* () {
    const outcome = yield* exec(Deno.execPath(), {
      arguments: [
        "run",
        "--allow-read",
        "--cached-only",
        "--frozen",
        "scripts/generate-yq-wasm.ts",
        "--check",
      ],
      cwd: ROOT,
    }).join();
    expect(outcome.code).toBe(0);
    // Read-only, and it says how many files it compared: a check that silently
    // compared none would pass on a repository with nothing generated in it.
    expect(outcome.stdout).toContain(`yq.rs@${PINNED_VERSION}`);
    expect(outcome.stdout).toContain("4 files");
  });

  it("YD1: the committed module is the pinned bytes, and the provenance says so", function* () {
    const encoded = yield* readTextFile(path.join(ROOT, "packages/core/src/yq-wasm.ts"));
    const lines = [...encoded.matchAll(/^ {2}"([A-Za-z0-9+/=]+)",$/gm)].map((match) => match[1]);
    expect(lines.length).toBeGreaterThan(0);
    const binary = atob(lines.join(""));
    const bytes = new Uint8Array(binary.length);
    for (let at = 0; at < binary.length; at++) {
      bytes[at] = binary.charCodeAt(at);
    }

    // The exact published asset, decoded out of the committed source.
    expect(bytes.byteLength).toBe(PINNED_BYTES);
    expect(digest(bytes)).toBe(PINNED_SHA256);

    const provenance = JSON.parse(
      yield* readTextFile(path.join(ROOT, "packages/core/src/yq-wasm.provenance.json")),
    );
    expect(provenance.package).toBe("yq.rs");
    expect(provenance.version).toBe(PINNED_VERSION);
    expect(provenance.sha256).toBe(PINNED_SHA256);
    expect(provenance.bytes).toBe(PINNED_BYTES);
    expect(provenance.runtimeExport).toBe("yq.rs/loader");
    // The notices are named with their own digests, so a notice that changed
    // without being regenerated is drift rather than something nobody noticed.
    for (const notice of provenance.notices) {
      const text = yield* readTextFile(path.join(ROOT, "packages/core/src", notice.path));
      expect(digest(new TextEncoder().encode(text))).toBe(notice.sha256);
    }
  });

  it("YD1: drift refuses and writes nothing", function* () {
    const module = path.join(ROOT, "packages/core/src/yq-wasm.ts");
    const before = yield* readTextFile(module);
    // A copy of this repository with the generated module edited. The generator
    // resolves its own tree from its own module URL, so the copied script
    // checks the copied tree — which is the only way to ask what a check does
    // about drift without writing into the tree under test.
    const drifted = yield* useNpmWorkspace();
    const copied = path.join(drifted, "packages/core/src/yq-wasm.ts");
    yield* writeTextFile(copied, `${yield* readTextFile(copied)}\n// drift\n`);
    const refused = yield* exec(Deno.execPath(), {
      arguments: [
        "run",
        "--allow-read",
        "--cached-only",
        "--frozen",
        "scripts/generate-yq-wasm.ts",
        "--check",
      ],
      cwd: drifted,
    }).join();

    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toContain("out of date");
    // Read-only: the drifted file is still drifted, so the check repaired
    // nothing — and this repository's own module is untouched.
    expect(yield* readTextFile(copied)).toContain("// drift");
    expect(yield* readTextFile(module)).toBe(before);
  });

  it("YD1: the imported graph names the loader and never the instantiating entry", function* () {
    const sources = yield* until(readdir(path.join(ROOT, "packages/core/src")));
    const importing: string[] = [];
    for (const name of sources) {
      if (!name.endsWith(".ts")) {
        continue;
      }
      const text = yield* readTextFile(path.join(ROOT, "packages/core/src", name));
      if (text.includes("yq.rs")) {
        importing.push(name);
      }
    }
    // One module reaches the vendor, and it reaches the loader.
    expect(importing.toSorted()).toEqual(["value-query.ts", "yq-wasm.ts"]);
    const engine = yield* readTextFile(path.join(ROOT, "packages/core/src/value-query.ts"));
    expect(engine).toContain('from "yq.rs/loader"');
    expect(engine).not.toContain('from "yq.rs"');
    expect(engine).not.toContain("yq.rs/inline");

    // And the manifests pin it under that one subpath.
    const manifest = JSON.parse(yield* readTextFile(path.join(ROOT, "packages/core/deno.json")));
    expect(manifest.imports["yq.rs/loader"]).toBe(`npm:yq.rs@${PINNED_VERSION}/loader`);
    const pkg = JSON.parse(yield* readTextFile(path.join(ROOT, "packages/core/package.json")));
    expect(pkg.dependencies["yq.rs"]).toBe(PINNED_VERSION);
  });

  it("YD1: the compile names the notice directory that exists", function* () {
    for (const asset of PACKAGED_NOTICES) {
      const entries = yield* until(readdir(path.join(ROOT, asset)));
      expect(entries.toSorted()).toEqual(["LICENSE", "THIRD_PARTY_NOTICES.md"]);
    }
    const argv = compileArguments({ output: "dist/xmd" });
    for (const asset of PACKAGED_NOTICES) {
      expect(argv).toContain(asset);
    }
  });
});

describe(
  "every distribution runs the same document",
  { sanitizeOps: false, sanitizeResources: false },
  () => {
    it("YD2: the source graph runs it under Deno", function* () {
      const root = yield* useDocument();
      const outcome = yield* exec(Deno.execPath(), {
        arguments: [
          "run",
          "--allow-all",
          "--cached-only",
          "--frozen",
          path.join(ROOT, "packages/cli/src/deno.ts"),
          "run",
          "doc.md",
        ],
        cwd: root,
      }).join();
      expect([outcome.code, outcome.stderr]).toEqual([0, outcome.stderr]);
      held(outcome.stdout);
    });

    it("YD2: the same source graph answers identically under Node and Bun", function* () {
      // The three runtimes' own source entrypoints, over one document, from a
      // directory holding only the document and its fixture. Each runtime
      // reaches the engine through its own module loader — Deno's, tsx's
      // transpile, and Bun's — so a byte module that only one of them can read
      // fails here rather than in whichever release ships first.
      const root = yield* useDocument();
      const answers: Record<string, string> = {};
      for (const [runtime, command, argv] of SOURCE_RUNTIMES) {
        const outcome = yield* exec(command, {
          arguments: [...argv, "run", "doc.md"],
          cwd: root,
        }).join();
        expect([runtime, outcome.code, outcome.stderr]).toEqual([runtime, 0, outcome.stderr]);
        held(outcome.stdout);
        answers[runtime] = outcome.stdout;
      }

      // Equal values, not merely three successes: the selection, both
      // renderings and the engine's own formatting are the same text.
      expect(answers.node).toBe(answers.deno);
      expect(answers.bun).toBe(answers.deno);
    });

    it("YD2: a real compiled binary runs it from an unrelated directory", function* () {
      const root = yield* useDocument();
      const built = yield* useTempDirectory("xmd-yq-binary-");
      const output = path.join(built, "xmd");
      // One compile, reused below. Through the shared command, so what is
      // embedded is what a release embeds.
      yield* compile({ output: path.relative(ROOT, output) });

      const outcome = yield* exec(output, { arguments: ["run", "doc.md"], cwd: root }).join();
      // The document's cwd holds the fixture and nothing of the checkout: no
      // `node_modules`, no `packages/`, no installed `yq.rs`. A binary that
      // reached for any of those fails here.
      expect([outcome.code, outcome.stderr]).toEqual([0, outcome.stderr]);
      held(outcome.stdout);
    });

    it("YD2: the emitted npm package carries the byte module and the exact pin", function* () {
      const workspace = yield* useNpmWorkspace();
      const build = yield* exec(Deno.execPath(), {
        arguments: [
          "run",
          "-A",
          "--node-modules-dir=manual",
          "--cached-only",
          "--frozen",
          "scripts/build-npm.ts",
          "packages/core",
        ],
        cwd: workspace,
        env: {
          ...Deno.env.toObject(),
          // The same allowance the repository's own npm build and
          // `publish-one.yml` make for the pinned prerelease peer range.
          NPM_CONFIG_LEGACY_PEER_DEPS: "true",
        },
      }).join();
      expect([build.code, build.stderr]).toEqual([0, build.stderr]);

      const emitted = path.join(workspace, "packages/core/npm");
      // The dependency stays external and exact, and the loader subpath is what
      // the emitted module imports — a mapping to the instantiating entry would
      // compile WebAssembly on import in every installed copy.
      const manifest = JSON.parse(yield* readTextFile(path.join(emitted, "package.json")));
      expect(manifest.dependencies["yq.rs"]).toBe(PINNED_VERSION);
      const engine = yield* readTextFile(path.join(emitted, "esm/src/value-query.js"));
      expect(engine).toContain("yq.rs/loader");
      expect(engine).not.toContain("yq.rs/inline");

      // The byte module is emitted, and it is the pinned bytes.
      const encoded = yield* readTextFile(path.join(emitted, "esm/src/yq-wasm.js"));
      const lines = [...encoded.matchAll(/"([A-Za-z0-9+/=]{16,})"/g)].map((match) => match[1]);
      const binary = atob(lines.join(""));
      const bytes = new Uint8Array(binary.length);
      for (let at = 0; at < binary.length; at++) {
        bytes[at] = binary.charCodeAt(at);
      }
      expect(bytes.byteLength).toBe(PINNED_BYTES);
      expect(digest(bytes)).toBe(PINNED_SHA256);

      // And the attribution travels beside it, byte-identical to the source.
      for (const asset of ["yq-wasm.provenance.json", "yq-vendor-notices/LICENSE"]) {
        const shipped = new Uint8Array(
          yield* until(readFile(path.join(emitted, "esm/src", asset))),
        );
        const source = new Uint8Array(
          yield* until(readFile(path.join(ROOT, "packages/core/src", asset))),
        );
        expect(digest(shipped)).toBe(digest(source));
      }
    });

    it("YD3: the packed CLI closure runs it under Node and under Bun", function* () {
      const workspace = yield* useNpmWorkspace();
      const { version } = JSON.parse(
        yield* readTextFile(path.join(workspace, "packages/cli/deno.json")),
      );

      // Every member of the closure, built at one version. The whole closure
      // rather than the CLI alone: these packages are released in lockstep and
      // depend on each other by range, so installing one candidate package
      // beside published siblings resolves a *mixture* — which proves nothing
      // about the artifact a release produces.
      // The tarballs are packed straight into scratch this case owns rather
      // than left in the build tree: a later member's build rewrites that tree
      // underneath them, and an installer reading a file being rewritten reads
      // a corrupt one.
      const scratch = yield* useTempDirectory("xmd-yq-installed-");
      const tarballs = path.join(scratch, "tarballs");
      yield* until(mkdir(tarballs, { recursive: true }));

      const packed: string[] = [];
      for (const member of CLOSURE) {
        const built = yield* exec(Deno.execPath(), {
          arguments: [
            "run",
            "-A",
            "--node-modules-dir=manual",
            "--cached-only",
            "--frozen",
            "scripts/build-npm.ts",
            member,
            String(version),
          ],
          cwd: workspace,
          env: { ...Deno.env.toObject(), NPM_CONFIG_LEGACY_PEER_DEPS: "true" },
        }).join();
        expect([member, built.code, built.stderr]).toEqual([member, 0, built.stderr]);

        const emitted = path.join(workspace, member, "npm");
        const tarball = yield* exec("npm", {
          arguments: ["pack", "--silent", "--pack-destination", tarballs],
          cwd: emitted,
        }).join();
        expect([member, tarball.code, tarball.stderr]).toEqual([member, 0, tarball.stderr]);
        const named = tarball.stdout.trim().split("\n").at(-1) ?? "";
        expect([member, named]).toEqual([member, named.length > 0 ? named : "a tarball name"]);
        packed.push(path.join(tarballs, named));
      }

      // Installed from those tarballs alone. The installer never reaches the
      // checkout: what it is given is ten files in a directory this case owns.
      yield* writeTextFile(
        path.join(scratch, "package.json"),
        JSON.stringify({ name: "xmd-yq-consumer", private: true }),
      );
      const installed = yield* exec("npm", {
        arguments: ["install", "--no-audit", "--no-fund", ...packed],
        cwd: scratch,
      }).join();
      expect([installed.code, installed.stderr]).toEqual([0, installed.stderr]);

      // The installed core really is the candidate: it carries the byte module,
      // and the bytes are the pin.
      const encoded = yield* readTextFile(
        path.join(scratch, "node_modules/@executablemd/core/esm/src/yq-wasm.js"),
      );
      const lines = [...encoded.matchAll(/"([A-Za-z0-9+/=]{16,})"/g)].map((match) => match[1]);
      const binary = atob(lines.join(""));
      const bytes = new Uint8Array(binary.length);
      for (let at = 0; at < binary.length; at++) {
        bytes[at] = binary.charCodeAt(at);
      }
      expect([bytes.byteLength, digest(bytes)]).toEqual([PINNED_BYTES, PINNED_SHA256]);

      // Run from a directory holding the document and its fixture and nothing
      // else, by both runtimes, through the installed closure.
      const root = yield* useDocument();
      const entry = path.join(scratch, "node_modules/@executablemd/cli/esm/src/node.js");
      const outputs: string[] = [];
      for (const runtime of ["node", "bun"]) {
        const outcome = yield* exec(runtime, {
          arguments: [entry, "run", "doc.md"],
          cwd: root,
        }).join();
        expect([runtime, outcome.code, outcome.stderr]).toEqual([runtime, 0, outcome.stderr]);
        held(outcome.stdout);
        outputs.push(outcome.stdout);
      }
      // The same document, the same values: the two runtimes do not merely
      // each succeed, they agree.
      expect(outputs[0]).toBe(outputs[1]);
    });
  },
);
