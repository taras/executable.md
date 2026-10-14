/**
 * The `xmd test` root is not a run profile, and its children are.
 *
 * XMD bundles one Plugin and activates it for the commands that execute or
 * describe a document. `xmd test` is not one of them: the root is a harness
 * that decides what its children run, and a harness that quietly gained the
 * repository vocabulary would be reserving names its children are entitled to
 * shadow.
 *
 * So the same element resolves in two places and not in a third, and that
 * asymmetry is the whole subject here: `<Repository />` is a component under an
 * ordinary run and inside a nested `<Execution host="run">` child, while
 * `<Repository />` written at the test root is not a component at all.
 *
 * `<Repository>` rather than `<Dir>`, which these rows used while Git declared
 * it: canonical core owns `<Dir>` now, so it resolves under every command, and
 * a row written in it would report an asymmetry that no longer exists. What is
 * wanted is any name the Plugin still declares.
 *
 * Each row reads one element written with no props, so the two outcomes are a
 * profile's and nothing else's: a command that has the declaration reads its
 * schema and names the props it is missing, and a command that does not have it
 * cannot resolve the name at all. Neither outcome reaches a provider, a
 * credential or a network, so what separates the rows is the vocabulary rather
 * than what some host went on to install.
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

/** What a command that does not know the name answers with. */
const UNKNOWN = "Cannot resolve component: Repository";

/** What a command that does know it answers with, having read its schema. */
const DECLARED = "Prop validation failed for <Repository />";

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
    const { output } = yield* xmd(["run"], "<Repository />\n");
    expect(output).toContain(DECLARED);
    expect(output).not.toContain(UNKNOWN);
  });

  it("resolves none of it at the test root", function* () {
    // Not a failure to *perform* the work — a failure to know the name at all.
    // The root profile carries no Plugin, so `<Repository />` is not a
    // component here.
    const { code, output } = yield* xmd(
      ["test"],
      [
        "<Testing>",
        "",
        '<Test name="the root writes Git vocabulary">',
        "",
        "<Repository />",
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
    expect(output).toContain(UNKNOWN);
    // And it never read the declaration, which is the other half: a root that
    // resolved the name and then refused the invocation would report the props
    // it was missing instead.
    expect(output).not.toContain(DECLARED);
  });

  it("resolves it inside a nested run child", function* () {
    // The same element, one scope down, under a child that assembles the run
    // profile for itself. The root still has none of it; the child has all of
    // it — which is what "a child does not inherit what its parent declined"
    // looks like from the outside.
    //
    // The child's failure is deliberately not bound: what it reported is the
    // evidence, and the row above shows what that text reads when a command
    // does not know the name.
    const { output } = yield* xmd(
      ["test"],
      [
        "<Testing>",
        "",
        '<Test name="a run child resolves Git vocabulary">',
        "",
        '<Execution host="run" source={"<Repository />"} />',
        "",
        "</Test>",
        "",
        "</Testing>",
        "",
      ].join("\n"),
      "nested.md",
    );
    expect(output).toContain(DECLARED);
    expect(output).not.toContain(UNKNOWN);
  });
});
