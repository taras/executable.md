/**
 * The `xmd test` root is not a run profile, and its children are.
 *
 * XMD bundles one Plugin and activates it for the commands that execute or
 * describe a document. `xmd test` is not one of them: the root is a harness
 * that decides what its children run, and a harness that quietly gained the
 * repository vocabulary would be claiming names its children are entitled to
 * shadow.
 *
 * So the same element resolves in two places and not in a third, and that
 * asymmetry is the whole subject here: `<Dir>` inside a nested
 * `<Execution host="run">` child is Git's component, doing Git's work, while
 * `<Dir>` written at the test root resolves to nothing at all.
 *
 * Driven through the real binary rather than an in-process assembly, because
 * what is under test is which profile each *command* runs with — and a command
 * is the one thing an in-process harness has to invent.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { runCli } from "@executablemd/test-support/launch";
import { useTempDirectory } from "@executablemd/test-support/temp";
import { writeTextFile } from "@effectionx/fs";
import { join } from "node:path";
import type { Operation } from "effection";

/** One document, run by one command, from a directory naming no repository. */
function* xmd(
  args: readonly string[],
  source: string,
  name = "subject.md",
): Operation<{ code: number | undefined; output: string }> {
  const directory = yield* useTempDirectory("xmd-test-profile");
  const home = yield* useTempDirectory("xmd-test-profile-home");
  const document = join(directory, name);
  yield* writeTextFile(document, source);
  const run = yield* runCli([...args, document], {
    cwd: directory,
    env: { HOME: home },
    timeout: 180_000,
  }).join();
  return { code: run.code, output: `${run.stdout}\n${run.stderr}` };
}

describe("the profile each command runs with", () => {
  it("resolves Git's vocabulary for an ordinary run", function* () {
    // The positive control for both cases below: the element, the spelling and
    // the directory are the same everywhere, so what differs is only which
    // profile the command carries.
    const { code, output } = yield* xmd(["run"], '<Dir path="notes">a run resolves this</Dir>\n');
    expect(`${code}: ${output.includes("a run resolves this")}`).toBe("0: true");
  });

  it("resolves none of it at the test root", function* () {
    // Not a failure to *perform* the work — a failure to know the name at all.
    // The root profile carries no Plugin, so `<Dir>` is not a component here.
    const { code, output } = yield* xmd(
      ["test"],
      [
        "<Testing>",
        "",
        '<Test name="the root writes Git vocabulary">',
        "",
        '<Dir path="notes">the root must not resolve this</Dir>',
        "",
        "</Test>",
        "",
        "</Testing>",
        "",
      ].join("\n"),
      "root.md",
    );
    expect(code).not.toBe(0);
    // The intended failure, named. Any non-zero exit would otherwise satisfy
    // this — including one from a CLI fault that has nothing to do with which
    // profile the command carries.
    expect(output).toContain("Cannot resolve component: Dir");
    expect(output).not.toContain("the root must not resolve this");
  });

  it("resolves it inside a nested run child", function* () {
    // The same element, one scope down, under a child that assembles the run
    // profile for itself. The root still has none of it; the child has all of
    // it — which is what "a child does not inherit what its parent declined"
    // looks like from the outside.
    const { code, output } = yield* xmd(
      ["test"],
      [
        "<Testing>",
        "",
        '<Test name="a run child resolves Git vocabulary">',
        "",
        '<Execution host="run" source={"<Dir path=\\"notes\\">the child resolves this</Dir>"} as="child">',
        '<CollectOutput as="output" />',
        "<AssertEquals actual={child.result.ok} expected={true} />",
        '<AssertStringIncludes actual={output} expected="the child resolves this" />',
        "</Execution>",
        "",
        "</Test>",
        "",
        "</Testing>",
        "",
      ].join("\n"),
      "nested.md",
    );
    // The proof is inside the document. `<CollectOutput>` binds the child's
    // output rather than printing it, so what discriminates here is the pair of
    // assertions the child ran: that it succeeded at all, and that what it
    // rendered is what `<Dir>` renders. A child that resolved no component
    // fails the first; one that resolved a different one fails the second.
    expect(code).toBe(0);
    // And it resolved the component rather than reporting it missing, which is
    // exactly what the root case above sees.
    expect(output).not.toContain("Cannot resolve component: Dir");
  });
});
