/**
 * Tier IE — `xmd run -e` / `xmd -e`, the inline root document (issue #76).
 *
 * Shells out with captured stdio, so exit status and both streams are observed
 * the way a caller sees them. What is measured here is what no core test can
 * reach: that the document's own text survives argv untouched — a document may
 * be `42`, or `--props`, or `-h` — and that inline execution adds no top-level
 * filesystem entry of any kind. Where relative paths point is document
 * behavior, proven by the checked-in Markdown suite in document-suites/inline.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { runCli } from "@executablemd/test-support/launch";
import { ensure, until } from "effection";
import type { Operation } from "effection";
import { ensureDir, readTextFile, rm, writeTextFile } from "@effectionx/fs";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PROPS_DOC = [
  "---",
  "props:",
  "  name:",
  "    type: string",
  "    description: Person to greet",
  "required: [name]",
  "---",
  "",
  "Hello {props.name}",
].join("\n");

// The expression form rather than an `eval` block, matching value-root.test.ts:
// an eval block needs the host's compiler, which is not the subject here.
const VALUE_DOC = [
  "---",
  "returns:",
  "  ok: { type: boolean }",
  "---",
  "",
  "rendered body",
  "",
  "<Return value={{ ok: true }} />",
].join("\n");

/** A directory holding the given files, removed when the test ends. */
function* useWorkspace(files: Record<string, string>): Operation<string> {
  const root = yield* until(mkdtemp(join(tmpdir(), "xmd-inline-cli-")));
  yield* ensure(() => rm(root, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    yield* writeTextFile(join(root, name), content);
  }
  return root;
}

function* entries(root: string): Operation<Set<string>> {
  return new Set(yield* until(readdir(root)));
}

describe(
  "Tier IE — inline root documents",
  { sanitizeOps: false, sanitizeResources: false },
  () => {
    it("IE1: both command forms run the same document", function* () {
      const explicit = yield* runCli(["run", "-e", "# Hello", "--raw"]).expect();
      const implicit = yield* runCli(["-e", "# Hello", "--raw"]).expect();

      expect(explicit.stdout).toContain("# Hello");
      expect(implicit.stdout).toBe(explicit.stdout);
    });

    it("IE2: a path and --eval together name two root documents", function* () {
      const { code, stderr } = yield* runCli(["run", "README.md", "-e", "# Hello"]).join();
      expect(code).toBe(1);
      expect(stderr).toContain("both supply a root document");
    });

    it("IE3: --eval given twice fails", function* () {
      const { code, stderr } = yield* runCli(["-e", "# one", "-e", "# two"]).join();
      expect(code).toBe(1);
      expect(stderr).toContain("more than once");
    });

    it("IE4: --eval with no value fails", function* () {
      const { code, stderr } = yield* runCli(["-e"]).join();
      expect(code).toBe(1);
      expect(stderr).toContain("requires a markdown document");
    });

    it("IE5: `-e -` does not read stdin", function* () {
      // Standard input really is supplied, and really would run if anything
      // read it: `-e -` refusing on an empty pipe proves only that it refuses.
      const { code, stdout, stderr } = yield* runCli(["-e", "-"], {
        stdin: "STDIN_SHOULD_NOT_RUN\n",
      }).join();
      expect(code).toBe(1);
      expect(stderr).toContain("does not read from stdin");
      expect(stdout).not.toContain("STDIN_SHOULD_NOT_RUN");
    });

    it("IE6: the alias has no inline value form", function* () {
      const { code, stderr } = yield* runCli(["-e=# Hello"]).join();
      expect(code).toBe(1);
      expect(stderr).toContain("takes a separate value");
    });

    it("IE7: no source at all fails, in both command forms", function* () {
      const bare = yield* runCli([]).join();
      expect(bare.code).toBe(1);
      expect(bare.stderr).toContain("xmd run requires a root document");

      const explicit = yield* runCli(["run"]).join();
      expect(explicit.code).toBe(1);
      expect(explicit.stderr).toContain("xmd run requires a root document");
    });

    /**
     * A document is whatever the shell handed over. Reaching for the parsed
     * configuration coerces `42` through `Number()` and then drops it; letting
     * the other argv scanners see the text turns `-h` into a help request and
     * `--props` into an unrecognized property.
     */
    it("IE8: a numeric document is text, not a number", function* () {
      const { stdout } = yield* runCli(["-e", "42", "--raw"]).expect();
      expect(stdout).toContain("42");
    });

    it("IE9: a document that reads like an option is still a document", function* () {
      const props = yield* runCli(["-e", "--props", "--raw"]).expect();
      expect(props.stdout).toContain("--props");
      expect(props.stderr).not.toContain("unrecognized option");

      const help = yield* runCli(["-e", "-h", "--raw"]).expect();
      expect(help.stdout).toContain("-h");
      expect(help.stdout).not.toContain("Usage: xmd");
    });

    it("IE10: the token after --eval is taken verbatim", function* () {
      // The accepted cost of a verbatim value: `--verbose` here is the document,
      // and so does not switch the flag on.
      const flag = yield* runCli(["-e", "--verbose", "--raw"]).expect();
      expect(flag.stdout).toContain("--verbose");
      expect(flag.stderr).not.toContain("[yield]");

      const bullet = yield* runCli(["-e", "- item", "--raw"]).expect();
      expect(bullet.stdout).toContain("- item");
    });

    // IE11, IE15, IE16 and IE23 live in
    // packages/cli/tests/document-suites/inline/Inline.test.md: the claims are
    // document behavior, so their evidence is the checked-in Markdown suite
    // the tier launcher runs.

    it("IE11a: --eval accepts an explicitly empty value", function* () {
      // eval-source.ts takes the following argv token verbatim, and only
      // undefined means the option ran out of argv — so an explicit "" is a
      // value, never a missing one. Deterministic argv coverage pending #581's
      // in-process command surface; what the empty document renders is IE11's
      // evidence, not this row's.
      const { code, stderr } = yield* runCli(["-e", "", "--raw"]).join();
      expect(code).toBe(0);
      expect(stderr).not.toContain("requires a markdown document");
    });

    it("IE12: inline frontmatter declares properties", function* () {
      const individual = yield* runCli(["-e", PROPS_DOC, "--props-name", "Ada", "--raw"]).expect();
      expect(individual.stdout).toContain("Hello Ada");

      const aggregate = yield* runCli([
        "-e",
        PROPS_DOC,
        "--props",
        '{"name":"Grace"}',
        "--raw",
      ]).expect();
      expect(aggregate.stdout).toContain("Hello Grace");

      const environment = yield* runCli(["-e", PROPS_DOC, "--raw"], {
        env: { XMD_PROPS_NAME: "Alan" },
      }).expect();
      expect(environment.stdout).toContain("Hello Alan");
    });

    it("IE13: help describes the inline source and the document's properties", function* () {
      const { stdout } = yield* runCli(["-e", PROPS_DOC, "--help"]).expect();
      expect(stdout).toContain("Properties declared by <eval>");
      expect(stdout).toContain("--props-name <string>");
      expect(stdout).toContain("Exactly one root document is required");
    });

    it("IE14: an inline value root prints only its JSON result", function* () {
      const { stdout } = yield* runCli(["-e", VALUE_DOC]).expect();
      expect(stdout.trim()).toBe('{"ok":true}');
      expect(stdout).not.toContain("rendered body");

      const verbose = yield* runCli(["-e", VALUE_DOC, "--verbose"]).expect();
      expect(verbose.stdout.trim()).toBe('{"ok":true}');
      expect(verbose.stderr).toContain("rendered body");
    });

    it("IE17: repository components resolve from the invocation directory", function* () {
      const root = yield* useWorkspace({});
      yield* writeTextFile(join(root, "Greeting.md"), "Hello from a component\n");

      const implicit = yield* runCli(["-e", "<Greeting />\n", "--raw"], { cwd: root }).expect();
      expect(implicit.stdout).toContain("Hello from a component");

      const explicit = yield* runCli(["-e", "<Greeting />\n", "--include", ".", "--raw"], {
        cwd: root,
      }).expect();
      expect(explicit.stdout).toContain("Hello from a component");
    });

    it("IE25: repeated includes are searched in caller order, replacing the defaults", function* () {
      const root = yield* useWorkspace({ "Greeting.md": "from the default path\n" });
      for (const dir of ["first", "second"]) {
        yield* ensureDir(join(root, dir));
        yield* writeTextFile(join(root, dir, "Greeting.md"), `from the ${dir} include\n`);
      }

      const { stdout } = yield* runCli(
        ["-e", "<Greeting />\n", "--include", "first", "--include", "second", "--raw"],
        { cwd: root },
      ).expect();

      // Argv order is the search order…
      expect(stdout).toContain("from the first include");
      expect(stdout).not.toContain("from the second include");
      // …and an explicit value replaces the defaults rather than extending
      // them, so the candidate sitting on the default path never competes.
      expect(stdout).not.toContain("from the default path");
    });

    it("IE18: running an inline document leaves the directory as it was", function* () {
      // The distinct fault this retained row catches: inline execution must
      // not add any top-level filesystem entry — a file, a directory, or a
      // symlink. readdir() observes every entry kind; the Markdown suite's
      // <Glob> observes only regular files, so this row stays a focused
      // subprocess test pending #581's deterministic in-process CLI surface.
      const root = yield* useWorkspace({ "Greeting.md": "Hello from a component\n" });
      const before = yield* entries(root);

      yield* runCli(["-e", "<Greeting />\n", "--raw"], { cwd: root }).expect();

      expect(yield* entries(root)).toEqual(before);
    });

    it("IE19: --journal records the supplied identity and text", function* () {
      const root = yield* useWorkspace({});
      const trace = join(root, "trace.jsonl");

      yield* runCli(["-e", "# Hello\n", "--raw", "--journal", trace], { cwd: root }).expect();

      const written = yield* readTextFile(trace);
      expect(written).toContain('"name":"__root__"');
      expect(written).toContain("<eval>");
      expect(written).toContain("# Hello");
    });

    it("IE20: ordinary run flags apply to an inline document", function* () {
      const { code, stderr } = yield* runCli([
        "-e",
        "# Hello",
        "--raw",
        "--verbose",
        "--timeout",
        "5min",
        "--approve-reads",
      ]).join();

      expect(code).toBe(0);
      expect(stderr).toContain("[yield] import_component:__root__");
    });

    it("IE21: inline documents are exclusive to xmd run", function* () {
      const { code, stderr } = yield* runCli(["test", "-e", "# Hello"]).join();
      expect(code).toBe(1);
      expect(stderr).toContain("exclusive to xmd run");
    });

    /**
     * An inline root is not a selectable document reference — there is no path
     * to write a `#` after — so its help describes what it declares and offers
     * no section to select, however many headings the text holds.
     */
    it("IE22: inline help describes properties and offers no target section", function* () {
      const document = [PROPS_DOC, "", "## Section", "", "What this section does."].join("\n");
      const { code, stdout } = yield* runCli(["-e", document, "--help"]).expect();
      expect(code).toBe(0);
      expect(stdout).toContain("Properties declared by <eval>");
      expect(stdout).toContain("--props-name <string>");
      expect(stdout).not.toContain("Targets in");
      expect(stdout).not.toContain("What this section does.");
    });

    /**
     * The stdin sentinel is one exact spelling of one exact argument on one
     * exact command. These three rows supply real standard input to the
     * spellings that are not it, and prove none of them executes what was
     * piped in.
     *
     * What each of them does instead is unchanged: configliere refuses any
     * positional beginning with `-`, so `-` and `-#Section` reach no document
     * argument at all and the run refuses for want of a root. Only `xmd run -`
     * gives that token a meaning.
     */
    it("IE29: the shorthand form does not read stdin", function* () {
      const root = yield* useWorkspace({ "-": "FILE_NAMED_DASH\n" });
      const { code, stdout } = yield* runCli(["-", "--raw"], {
        cwd: root,
        stdin: "STDIN_SHOULD_NOT_RUN\n",
      }).join();

      expect(code).toBe(1);
      expect(stdout).not.toContain("STDIN_SHOULD_NOT_RUN");
    });

    it("IE30: a reference is not the sentinel argument", function* () {
      const root = yield* useWorkspace({ "-": "# Dash\n\n## Section\n\nSECTION_BODY\n" });
      const { code, stdout } = yield* runCli(["run", "-#Section", "--raw"], {
        cwd: root,
        stdin: "STDIN_SHOULD_NOT_RUN\n",
      }).join();

      expect(code).toBe(1);
      expect(stdout).not.toContain("STDIN_SHOULD_NOT_RUN");
    });

    it("IE31: another command's `-` keeps that command's meaning", function* () {
      const root = yield* useWorkspace({});
      const { stdout, stderr } = yield* runCli(["test", "-"], {
        cwd: root,
        stdin: "STDIN_SHOULD_NOT_RUN\n",
      }).join();

      expect(stdout).not.toContain("STDIN_SHOULD_NOT_RUN");
      expect(stderr).not.toContain("STDIN_SHOULD_NOT_RUN");
      // The test command searched for documents, which is what it does with an
      // argument it could not read as a path.
      expect(`${stdout}${stderr}`).toContain("**/*.test.md");
    });

    /**
     * The root's settlement, observed where a caller observes it. An uncaught
     * failure in a document that selects no output ends the run: what it
     * printed first is on stdout, the diagnostic is on stderr once, the work
     * after it never began, and the status says so.
     */
    it("IE24: an uncaught failure exits 1 with the prefix kept and one diagnostic", function* () {
      const document = [
        "PREFIX-PROSE",
        "",
        "```js eval",
        'throw new Error("stage classifier failed");',
        "```",
        "",
        "LATER-PROSE",
      ].join("\n");

      const { code, stdout, stderr } = yield* runCli(["-e", document, "--raw"]).join();

      expect(code).toBe(1);
      expect(stdout).toContain("PREFIX-PROSE");
      expect(stdout).not.toContain("LATER-PROSE");
      expect(stderr).toContain("stage classifier failed");
      expect(stderr.split("stage classifier failed")).toHaveLength(2);
    });
  },
);
