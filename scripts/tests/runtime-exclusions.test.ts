/**
 * These cover discovery, exclusion structure, each runtime's literal one-file
 * command and launcher exit status. The applicable corpus is derived from
 * discovery and the manifest; whether an exclusion remains necessary requires
 * a portability check of that test.
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { exists } from "@effectionx/fs";
import { shellQuote } from "@executablemd/test-support/launch";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { applicableTestFiles, listTestFiles, relativeWithin } from "../lib/test-files.ts";
import { exclusions, parseRuntime, RUNTIMES } from "../runtime-test-exclusions.ts";
import type { Runtime } from "../runtime-test-exclusions.ts";
import { exitCode, MARKDOWN_DEADLINES, oneFileCommand } from "../lib/runtime-tests.ts";

const ROOT = new URL("../../", import.meta.url);

/** The runtimes that record exclusions; Deno records none by design. */
const EXCLUDING: Runtime[] = ["node", "bun"];

describe("test discovery", () => {
  it("returns sorted repository-relative paths", function* () {
    const files = yield* listTestFiles(ROOT);
    expect(files.length).toBeGreaterThan(0);
    expect(files).toEqual([...files].sort());
    for (const file of files) {
      expect(file.startsWith("/")).toBe(false);
      // A Windows drive letter is absolute too, and would otherwise slip past.
      expect(file).not.toMatch(/^[A-Za-z]:/);
      if (file.endsWith(".test.ts")) {
        expect(file).toContain("/tests/");
      }
      expect(file.endsWith(".test.ts") || file.endsWith(".test.md")).toBe(true);
    }
  });

  it("returns the same list on repeated calls", function* () {
    expect(yield* listTestFiles(ROOT)).toEqual(yield* listTestFiles(ROOT));
  });

  it("finds this file", function* () {
    expect(yield* listTestFiles(ROOT)).toContain("scripts/tests/runtime-exclusions.test.ts");
  });

  it("leaves the deliberately malformed fixtures out", function* () {
    const files = yield* listTestFiles(ROOT);
    expect(files.some((file) => file.includes("/fixtures/"))).toBe(false);
  });
});

describe("path normalization", () => {
  it("relativizes a POSIX path", function* () {
    expect(
      relativeWithin("/repo/packages/core/tests/", "/repo/packages/core/tests/a.test.ts"),
    ).toBe("a.test.ts");
  });

  it("relativizes a Windows path against the base @effectionx/fs reports", function* () {
    // toPath() yields C:/repo/... while walk() yields C:\repo\...; comparing a
    // URL pathname instead would leave the result absolute.
    expect(
      relativeWithin("C:/repo/packages/core/tests", "C:\\repo\\packages\\core\\tests\\a.test.ts"),
    ).toBe("a.test.ts");
  });

  it("keeps nested directories", function* () {
    expect(relativeWithin("/repo/tests/", "/repo/tests/deep/b.test.ts")).toBe("deep/b.test.ts");
  });

  it("refuses an entry outside the walked directory", function* () {
    expect(() => relativeWithin("/repo/tests/", "/elsewhere/c.test.ts")).toThrow();
    // A sibling sharing the prefix is still outside it.
    expect(() => relativeWithin("/repo/tests/", "/repo/tests-extra/d.test.ts")).toThrow();
  });
});

describe("runtime exclusions", () => {
  it("keys every supported runtime, and Deno excludes only the binary's suites", function* () {
    expect(Object.keys(exclusions).sort()).toEqual([...RUNTIMES].sort());

    // Deno's list is not empty and not portability-shaped. The shards run
    // source; these suites' subject is the compiled `dist/xmd`, which only the
    // `smoke` job builds. Anything else appearing here means a Deno test was
    // dropped for a reason this manifest has not stated.
    expect(exclusions.deno.map((entry) => entry.path)).toEqual([
      "scripts/tests/component-form-dispatch.test.ts",
      "scripts/tests/plan-component-compiled.test.ts",
      "scripts/tests/plugin-compiled.test.ts",
      "scripts/tests/repl-issues-compiled.test.ts",
      "scripts/tests/repl-push-compiled.test.ts",
      "scripts/tests/repl-repositories-compiled.test.ts",
      "scripts/tests/test-diagnostics-compiled.test.ts",
    ]);
  });

  it("lists each path once per runtime", function* () {
    for (const runtime of RUNTIMES) {
      const paths = exclusions[runtime].map((entry) => entry.path);
      expect(paths).toEqual([...new Set(paths)]);
    }
  });

  it("excludes only files that exist and that discovery finds", function* () {
    const discovered = new Set(yield* listTestFiles(ROOT));
    for (const runtime of RUNTIMES) {
      for (const entry of exclusions[runtime]) {
        expect(yield* exists(new URL(entry.path, ROOT))).toBe(true);
        expect(discovered.has(entry.path)).toBe(true);
      }
    }
  });

  it("gives every exclusion a reason and an issue", function* () {
    for (const runtime of EXCLUDING) {
      expect(exclusions[runtime].length).toBeGreaterThan(0);
      for (const entry of exclusions[runtime]) {
        expect(entry.reason.trim().length).toBeGreaterThan(0);
        expect(entry.issue).toMatch(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/\d+$/);
      }
    }
  });

  it("names nothing that is not a supported runtime", function* () {
    for (const runtime of Object.keys(exclusions)) {
      expect(parseRuntime(runtime)).toEqual(runtime);
    }
    expect(parseRuntime("node22")).toBeUndefined();
    expect(parseRuntime("")).toBeUndefined();
  });
});

describe("the applicable corpus", () => {
  it("is discovery minus exactly that runtime's manifest, still sorted", function* () {
    const discovered = yield* listTestFiles(ROOT);

    for (const runtime of RUNTIMES) {
      const excluded = new Set(exclusions[runtime].map((entry) => entry.path));
      const applicable = yield* applicableTestFiles(runtime, ROOT);

      expect(applicable).toEqual(discovered.filter((file) => !excluded.has(file)));
      expect(applicable).toEqual([...applicable].sort());
      expect(applicable.filter((file) => excluded.has(file))).toEqual([]);
    }
  });

  it("gives Deno the whole discovered corpus but its own manifest", function* () {
    const excluded = new Set(exclusions.deno.map((entry) => entry.path));
    expect(yield* applicableTestFiles("deno", ROOT)).toEqual(
      (yield* listTestFiles(ROOT)).filter((file) => !excluded.has(file)),
    );
  });

  /**
   * Every runtime derives from one discovered set, so a file can only be missing
   * from a runtime by being named in that runtime's manifest.
   */
  it("runs each adversarial TypeScript-only test under every runtime", function* () {
    const wrappers = ["adversarial-production-role", "adversarial-session-continuity"].map(
      (name) => `packages/cli/tests/${name}.test.ts`,
    );
    expect(
      (yield* listTestFiles(ROOT)).filter((file) =>
        file.startsWith("packages/cli/tests/adversarial-"),
      ),
    ).toEqual(wrappers);
    for (const runtime of RUNTIMES) {
      const applicable = yield* applicableTestFiles(runtime, ROOT);
      expect(wrappers.filter((file) => !applicable.includes(file))).toEqual([]);
    }
  });

  it("runs each adversarial Markdown suite under every runtime", function* () {
    const suites = [
      "ArtifactReturn",
      "ArtifactReturnRecovery",
      "DecisionResolution",
      "Delivery",
      "Friction",
      "Implementation",
      "LaunchPolicy",
      "Preparation",
      "ProductionRole",
      "Submission",
      "Workflow",
    ].map((name) => `examples/adversarial-implementation/tests/${name}.test.md`);
    expect(
      (yield* listTestFiles(ROOT)).filter(
        (file) => file.startsWith("examples/") && file.endsWith(".md"),
      ),
    ).toEqual(suites);
    for (const runtime of RUNTIMES) {
      const applicable = yield* applicableTestFiles(runtime, ROOT);
      expect(suites.filter((file) => !applicable.includes(file))).toEqual([]);
    }
  });

  it("drops a file from a runtime only through the manifest", function* () {
    const discovered = yield* listTestFiles(ROOT);

    for (const runtime of RUNTIMES) {
      const applicable = new Set(yield* applicableTestFiles(runtime, ROOT));
      const dropped = discovered.filter((file) => !applicable.has(file));

      expect(dropped).toEqual(exclusions[runtime].map((entry) => entry.path).sort());
    }
  });
});

describe("the one-file runner commands", () => {
  it("runs a single file alone under each runtime", function* () {
    expect(oneFileCommand("deno", "packages/core/tests/a.test.ts")).toEqual({
      command: "deno",
      arguments: ["test", "--allow-all", "--frozen", "packages/core/tests/a.test.ts"],
    });
    expect(oneFileCommand("node", "packages/core/tests/a.test.ts")).toEqual({
      command: "tsx",
      arguments: [
        "--tsconfig",
        "tsconfig.node.json",
        "--test",
        "--test-concurrency=1",
        "packages/core/tests/a.test.ts",
      ],
    });
    expect(oneFileCommand("bun", "packages/core/tests/a.test.ts")).toEqual({
      command: "bun",
      arguments: ["test", "--timeout=300000", "packages/core/tests/a.test.ts"],
    });
    expect(
      oneFileCommand("bun", "packages/cli/tests/adversarial-session-continuity.test.ts"),
    ).toEqual({
      command: "bun",
      arguments: [
        "test",
        "--timeout=300000",
        "packages/cli/tests/adversarial-session-continuity.test.ts",
      ],
    });
  });
});

describe("the one-file Markdown commands", () => {
  const SUITE = "examples/adversarial-implementation/tests/Implementation.test.md";
  const at = (path: string) => fileURLToPath(new URL(path, ROOT));
  const deno = [
    "run",
    "--quiet",
    "--allow-all",
    "--node-modules-dir=manual",
    "--cached-only",
    "--frozen",
    at("packages/cli/src/deno.ts"),
  ];
  const profile = [
    "test",
    SUITE,
    "--plugin",
    at("packages/cli/tests/fixtures/workflow-test-permissions.mjs"),
    "--include",
    at("examples/adversarial-implementation/tests/components"),
    "--include",
    at("examples/adversarial-implementation/components"),
  ];

  it("runs a suite under the same runtime's xmd test entrypoint", function* () {
    const vector = (runtime: Runtime) => {
      const { command, arguments: args } = oneFileCommand(runtime, SUITE, ROOT);
      return { command, arguments: args };
    };
    expect(vector("deno")).toEqual({ command: "deno", arguments: [...deno, ...profile] });
    expect(vector("node")).toEqual({
      command: "tsx",
      arguments: [
        "--tsconfig",
        at("tsconfig.node.json"),
        at("packages/cli/src/node.ts"),
        ...profile,
      ],
    });
    expect(vector("bun")).toEqual({
      command: "bun",
      arguments: [at("packages/cli/src/bun.ts"), ...profile],
    });
  });

  it("uses CLI defaults and the neutral Deno worker plugin for registered documents", function* () {
    const plan = "packages/cli/tests/document-suites/plan/Plan.test.md";
    const native = "packages/test-agent/src/NativeSessionLaunch.test.md";
    const inline = "packages/cli/tests/document-suites/inline/Inline.test.md";
    for (const runtime of RUNTIMES) {
      const base = oneFileCommand(runtime, SUITE, ROOT);
      const cli = base.arguments.slice(0, base.arguments.indexOf("test"));
      for (const worker of [plan, native]) {
        const launched = oneFileCommand(runtime, worker, ROOT);
        expect(launched.arguments).toEqual([
          ...cli,
          "test",
          worker,
          ...(runtime === "deno"
            ? ["--plugin", at("packages/cli/tests/fixtures/prepared-test-worker.mjs")]
            : []),
        ]);
        expect(
          Object.keys(launched.env ?? {}).some((name) => name.startsWith("XMD_EXAMPLE_")),
        ).toBe(false);
      }
      expect(oneFileCommand(runtime, inline, ROOT).arguments).toEqual([...cli, "test", inline]);
    }
  });

  it("gives every runtime's suite the prepared Deno fixture commands and nothing else of this environment", function* () {
    const fixture = (subcommand: string[]) =>
      ["deno", ...deno, ...subcommand].map(shellQuote).join(" ");
    const allowed = new Set([
      "PATH",
      "DENO_DIR",
      "DENO_INSTALL_ROOT",
      "XDG_CACHE_HOME",
      "TMPDIR",
      "XMD_TEST_ARTIFACTS",
      "XMD_EXAMPLE_COMMAND",
      "XMD_EXAMPLE_TEST_COMMAND",
    ]);
    for (const runtime of RUNTIMES) {
      const env = oneFileCommand(runtime, SUITE, ROOT).env ?? {};
      expect(env.XMD_EXAMPLE_COMMAND).toEqual(fixture(["run", "--allow-absolute"]));
      expect(env.XMD_EXAMPLE_TEST_COMMAND).toEqual(fixture(["test"]));
      expect(Object.keys(env).filter((name) => !allowed.has(name))).toEqual([]);
    }
  });

  it("gives the production-role suites their production components", function* () {
    for (const name of ["Preparation", "ProductionRole", "Submission"]) {
      const file = `examples/adversarial-implementation/tests/${name}.test.md`;
      expect(oneFileCommand("bun", file, ROOT).arguments.slice(-4)).toEqual([
        "--include",
        at("examples/adversarial-implementation/tests/production-components"),
        "--include",
        at("examples/adversarial-implementation/components"),
      ]);
    }
    expect(
      oneFileCommand(
        "node",
        "examples/adversarial-implementation/tests/Delivery.test.md",
        ROOT,
      ).arguments.slice(-4),
    ).toEqual(profile.slice(-4));
  });

  it("passes the retained artifact evidence location to the artifact-return suites alone", function* () {
    const previous = process.env.XMD_ARTIFACT_RETURN_EVIDENCE;
    process.env.XMD_ARTIFACT_RETURN_EVIDENCE = "/retained/evidence";
    try {
      for (const name of ["ArtifactReturn", "ArtifactReturnRecovery"]) {
        const file = `examples/adversarial-implementation/tests/${name}.test.md`;
        expect(oneFileCommand("deno", file, ROOT).env?.XMD_ARTIFACT_RETURN_EVIDENCE).toEqual(
          "/retained/evidence",
        );
      }
      expect(oneFileCommand("deno", SUITE, ROOT).env?.XMD_ARTIFACT_RETURN_EVIDENCE).toBeUndefined();
    } finally {
      if (previous === undefined) {
        delete process.env.XMD_ARTIFACT_RETURN_EVIDENCE;
      } else {
        process.env.XMD_ARTIFACT_RETURN_EVIDENCE = previous;
      }
    }
    expect(
      oneFileCommand(
        "deno",
        "examples/adversarial-implementation/tests/ArtifactReturn.test.md",
        ROOT,
      ).env?.XMD_ARTIFACT_RETURN_EVIDENCE,
    ).toEqual(previous);
  });

  it("keeps each suite's whole-launch deadline and gives Implementation's groups their own", function* () {
    expect(MARKDOWN_DEADLINES).toEqual({
      ArtifactReturn: 120_000,
      ArtifactReturnRecovery: 120_000,
      DecisionResolution: 300_000,
      Delivery: 300_000,
      Friction: 180_000,
      LaunchPolicy: 120_000,
      Preparation: 420_000,
      ProductionRole: 120_000,
      Submission: 120_000,
      Workflow: 120_000,
    });
  });

  it("leaves a TypeScript file's environment to the runner", function* () {
    for (const runtime of RUNTIMES) {
      expect(oneFileCommand(runtime, "packages/core/tests/a.test.ts").env).toBeUndefined();
    }
  });
});

describe("launcher exit status", () => {
  it("propagates the child's code", function* () {
    expect(exitCode({ code: 0 })).toBe(0);
    expect(exitCode({ code: 1 })).toBe(1);
    expect(exitCode({ code: 7 })).toBe(7);
  });

  it("reports failure when a signal left no code", function* () {
    expect(exitCode({ code: null })).toBe(1);
    expect(exitCode({})).toBe(1);
  });
});
