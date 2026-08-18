/**
 * The trusted host profile a Markdown test runs a nested execution under
 * (issue #454).
 *
 * `packages/testing/tests/execution-harness.test.ts` holds the harness: which
 * root a target names, when the declarations are installed, what is displayed
 * and what is collected, and who may run a child at all. What it cannot hold is
 * the thing this file is for — that a child gets *production* assembly, the
 * same one `xmd run` gets after its arguments are read — because the testing
 * package must not import the CLI.
 *
 * So this runs `xmd test` on a real project, and the child documents use what
 * only an entrypoint installs: a foreground command, a core default component,
 * and the run host's journal policy.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, resource } from "effection";
import type { Operation } from "effection";
import { ensureDir, readdir, rm, writeTextFile } from "@effectionx/fs";
import { mkdtemp } from "node:fs/promises";
import { until } from "effection";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runCli } from "@executablemd/test-support/launch";

function doc(...lines: string[]): string {
  return `${lines.join("\n")}\n`;
}

/** A project on disk, because a child resolves its root the way `xmd run` does. */
function useProject(files: Record<string, string>): Operation<string> {
  return resource<string>(function* (provide) {
    const root = yield* until(mkdtemp(join(tmpdir(), "xmd-nested-")));
    yield* ensure(function* () {
      yield* rm(root, { recursive: true, force: true });
    });
    for (const [name, contents] of Object.entries(files)) {
      const path = join(root, name);
      const parent = path.slice(0, path.lastIndexOf("/"));
      if (parent !== root) {
        yield* ensureDir(parent);
      }
      yield* writeTextFile(path, contents);
    }
    yield* provide(root);
  });
}

const CHILD = doc(
  "---",
  "props:",
  "  type: object",
  "  properties:",
  "    who: { type: string }",
  "  required: [who]",
  "  additionalProperties: false",
  "---",
  "",
  "hello {props.who}",
  "",
  "```sh exec",
  'echo "from a command"',
  "```",
);

const GUIDE = doc("# First", "", "first body", "", "# Second", "", "second body");

describe("nested execution under the production run host", () => {
  it("runs referenced documents, targets and inline source as real roots", function* () {
    const project = yield* useProject({
      "reports/quarterly-summary.md": CHILD,
      "guide.md": GUIDE,
      "README.md": doc(
        '<Test name="referenced root">',
        '<Execution host="run" target="./reports/quarterly-summary.md" props={{ who: "world" }} as="child">',
        '<CollectOutput as="output" />',
        "",
        '<AssertEquals actual={child.kind} expected="settled" />',
        "<AssertEquals actual={child.result.ok} expected={true} />",
        '<AssertStringIncludes actual={output} expected="hello world" />',
        "</Execution>",
        "</Test>",
        "",
        '<Test name="selected target">',
        '<Execution host="run" target="guide.md#Second" as="child">',
        '<CollectOutput as="output" />',
        "",
        '<AssertStringIncludes actual={output} expected="second body" />',
        '<AssertEquals actual={output.includes("first body")} expected={false} />',
        "</Execution>",
        "</Test>",
        "",
        '<Test name="inline source">',
        '<Execution host="run" source={"from inline source\\n"} as="child">',
        '<CollectOutput as="output" />',
        "",
        '<AssertStringIncludes actual={output} expected="from inline source" />',
        "</Execution>",
        "</Test>",
        "",
        '<Test name="diagnostic journal">',
        '<Execution host="run" target="guide.md" as="child">',
        "<DiagnosticJournal />",
        '<CollectJournal as="journal" />',
        "",
        "<AssertEquals actual={journal.length > 0} expected={true} />",
        "</Execution>",
        "</Test>",
      ),
    });
    const result = yield* runCli(["test", "README.md"], { cwd: project }).join();
    expect(result.code).toBe(0);
    // A foreground command reaches a reader only where the entrypoint installed
    // the process adapter, and a transient child retains none of its bytes — so
    // seeing them here is the child running production assembly and this
    // document displaying what it produced.
    expect(result.stdout + result.stderr).toContain("from a command");
  });

  it("creates no authored file for an inline child", function* () {
    const project = yield* useProject({
      "README.md": doc(
        '<Test name="inline leaves nothing">',
        '<Execution host="run" source={"inline only\\n"} as="child">',
        '<CollectOutput as="output" />',
        "",
        '<AssertStringIncludes actual={output} expected="inline only" />',
        "</Execution>",
        "</Test>",
      ),
    });
    const result = yield* runCli(["test", "README.md"], { cwd: project }).join();
    expect(result.code).toBe(0);
    // Inline source is text the child ran under the `<eval>` identity, not a
    // document written down and then read back.
    expect(yield* readdir(project)).toEqual(["README.md"]);
  });

  it("refuses <Execution> outside a canonical <Test>", function* () {
    const project = yield* useProject({
      "child.md": doc("child"),
      "README.md": doc('<Execution host="run" target="child.md" />'),
    });
    const result = yield* runCli(["run", "README.md", "--raw"], { cwd: project }).join();
    expect(result.stdout + result.stderr).toContain("canonical <Test>");
  });

  it("refuses <WorkflowRun> on a host with no workflow profile", function* () {
    const project = yield* useProject({
      "README.md": doc(
        '<Test name="workflow">',
        '<WorkflowRun id="demo">',
        "</WorkflowRun>",
        "</Test>",
      ),
    });
    const result = yield* runCli(["test", "README.md"], { cwd: project }).join();
    expect(result.stdout + result.stderr).toContain("no workflow profile");
    expect(result.code).not.toBe(0);
  });
});
