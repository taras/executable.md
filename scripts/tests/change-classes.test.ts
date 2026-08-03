import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";

import { classify, runsEverything } from "../lib/change-classes.ts";
import type { ClassName } from "../lib/change-classes.ts";
import type { Change, ChangeKind } from "../lib/git-changes.ts";

const CORPUS = ["packages/core/tests/execute.test.ts", "scripts/tests/workspace.test.ts"];

function classOf(path: string, kind: ChangeKind = "modified"): ClassName {
  const change: Change = { path, kind };
  return classify([change], CORPUS).classified[0]!.className;
}

/** Every path the table recognises, and what it means. */
const CLASSES: Array<[ClassName, string[]]> = [
  [
    "workspace-config",
    [
      "deno.json",
      "deno.lock",
      "package.json",
      "pnpm-workspace.yaml",
      "packages/core/deno.json",
      "packages/core/package.json",
    ],
  ],
  [
    "runtime-dependencies",
    ["pnpm-lock.yaml", "bun.lock", "bunfig.toml", ".npmrc", "tsconfig.node.json"],
  ],
  [
    "selection-machinery",
    [
      "scripts/lib/test-files.ts",
      "scripts/lib/runtime-tests.ts",
      "scripts/lib/shard.ts",
      "scripts/lib/affected.ts",
      "scripts/runtime-test-exclusions.ts",
      "scripts/affected-tests.ts",
      "test-weights.json",
      ".oxlintrc.json",
      ".gitignore",
      "scripts/oxlint-rules/no-section-divider-comments.js",
    ],
  ],
  ["test-harness", ["packages/test-support/bdd.ts"]],
  [
    "runtime-documents",
    [
      "packages/core/tests/fixtures/streaming/simple.md",
      "packages/cli/tests/fixtures/discovery/colocated/Example.md",
      "scripts/tests/fixtures/doubled.ts",
      "packages/core/components/Sample.md",
      "packages/core/src/Break.test.md",
      "specs/testing-spec.md",
      "smoke-test/README.md",
      ".reviews/ReviewPR.md",
      ".github/workflows/ci.yml",
      "AGENTS.md",
    ],
  ],
  [
    "bundle-inputs",
    [
      "scripts/build-web-client.ts",
      "scripts/lib/web-client-module.ts",
      "packages/web/client/main.tsx",
    ],
  ],
  [
    "no-runtime-tests",
    [
      ".github/pull_request_template.md",
      ".vscode/settings.json",
      ".claude/settings.json",
      ".editorconfig",
      "LICENSE",
    ],
  ],
  ["test-file", ["packages/core/tests/execute.test.ts"]],
  ["typescript", ["packages/core/src/canonical.ts", "packages/web/src/assets.ts"]],
  ["unknown", ["Makefile", "docs/diagram.png"]],
];

describe("classify", () => {
  for (const [className, paths] of CLASSES) {
    for (const path of paths) {
      it(`reads ${path} as ${className}`, function* () {
        expect(classOf(path)).toEqual(className);
      });
    }
  }

  it("reads any deletion as a deletion, whatever the path", function* () {
    expect(classOf("packages/core/src/canonical.ts", "deleted")).toEqual("deletion");
    expect(classOf("LICENSE", "deleted")).toEqual("deletion");
  });

  it("runs everything for a deletion, because nothing depends on a missing node", function* () {
    expect(runsEverything("deletion")).toBe(true);
  });

  it("runs everything for a path it cannot classify", function* () {
    expect(runsEverything("unknown")).toBe(true);
  });

  it("runs nothing on its own for the bounded no-runtime-tests class", function* () {
    expect(runsEverything("no-runtime-tests")).toBe(false);
  });

  it("hands TypeScript to the graph rather than to a trigger", function* () {
    expect(runsEverything("typescript")).toBe(false);
    expect(runsEverything("test-file")).toBe(false);
  });

  it("separates the paths that need the graph from the ones that fire a trigger", function* () {
    const classification = classify(
      [
        { path: "packages/core/src/canonical.ts", kind: "modified" },
        { path: "packages/core/tests/execute.test.ts", kind: "modified" },
        { path: ".editorconfig", kind: "modified" },
      ],
      CORPUS,
    );
    expect(classification.full).toEqual([]);
    expect(classification.typescript).toEqual(["packages/core/src/canonical.ts"]);
    expect(classification.testFiles).toEqual(["packages/core/tests/execute.test.ts"]);
  });

  it("names the path that fired a full-corpus trigger", function* () {
    const classification = classify(
      [
        { path: "packages/core/src/canonical.ts", kind: "modified" },
        { path: "pnpm-lock.yaml", kind: "modified" },
      ],
      CORPUS,
    );
    expect(classification.full.map((entry) => entry.change.path)).toEqual(["pnpm-lock.yaml"]);
  });
});
