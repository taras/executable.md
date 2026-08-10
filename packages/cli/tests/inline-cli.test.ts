/**
 * Tier IE — `xmd run -e` / `xmd -e`, the inline root document (issue #76).
 *
 * Shells out with captured stdio, so exit status and both streams are observed
 * the way a caller sees them. Two things are measured that no core test can
 * reach: that the document's own text survives argv untouched — a document may
 * be `42`, or `--props`, or `-h` — and that a supplied root changes neither
 * where relative paths point nor what is left on disk afterwards.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { runCli } from "@executablemd/test-support/launch";
import { ensure, until } from "effection";
import type { Operation } from "effection";
import { readTextFile, rm, writeTextFile } from "@effectionx/fs";
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
      const { code, stderr } = yield* runCli(["-e", "-"]).join();
      expect(code).toBe(1);
      expect(stderr).toContain("does not read from stdin");
    });

    it("IE6: the alias has no inline value form", function* () {
      const { code, stderr } = yield* runCli(["-e=# Hello"]).join();
      expect(code).toBe(1);
      expect(stderr).toContain("takes a separate value");
    });

    it("IE7: no source at all fails, in both command forms", function* () {
      const bare = yield* runCli([]).join();
      expect(bare.code).toBe(1);
      expect(bare.stderr).toContain("requires a document path or an inline document");

      const explicit = yield* runCli(["run"]).join();
      expect(explicit.code).toBe(1);
      expect(explicit.stderr).toContain("requires a document path or an inline document");
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

    it("IE11: an empty document runs and produces nothing", function* () {
      const { code, stdout } = yield* runCli(["-e", "", "--raw"]).join();
      expect(code).toBe(0);
      expect(stdout.trim()).toBe("");
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

    /**
     * The identity reaches a diagnostic the same way a filename does. Both halves
     * are asserted, because the compiled smoke greps for the inline form and its
     * premise is the file-backed one.
     */
    it("IE15: positioned diagnostics name the root, file-backed or inline", function* () {
      const stray = "<Else>orphan</Else>\n";
      const root = yield* useWorkspace({ "Doc.md": stray });

      const file = yield* runCli(["run", "Doc.md", "--raw"], { cwd: root }).expect();
      expect(file.stdout).toContain("(Doc.md:1:1)");

      const inline = yield* runCli(["-e", stray, "--raw"], { cwd: root }).expect();
      expect(inline.stdout).toContain("(<eval>:1:1)");
    });

    it("IE16: a relative path resolves against the invocation directory", function* () {
      const withNotes = yield* useWorkspace({ "notes.md": "notes from the working directory\n" });
      const without = yield* useWorkspace({});
      const document = '<File path="notes.md" />\n';

      const found = yield* runCli(["-e", document, "--raw"], { cwd: withNotes }).expect();
      expect(found.stdout).toContain("notes from the working directory");

      // The same command, one directory over: nothing about `<eval>` supplies a
      // base directory, so the file is simply not there.
      const missing = yield* runCli(["-e", document, "--raw"], { cwd: without }).expect();
      expect(missing.stdout).not.toContain("notes from the working directory");
      expect(missing.stdout).toContain("notes.md");
    });

    it("IE17: repository components resolve from the invocation directory", function* () {
      const root = yield* useWorkspace({});
      yield* writeTextFile(join(root, "Greeting.md"), "Hello from a component\n");

      const implicit = yield* runCli(["-e", "<Greeting />\n", "--raw"], { cwd: root }).expect();
      expect(implicit.stdout).toContain("Hello from a component");

      const explicit = yield* runCli(["-e", "<Greeting />\n", "--component-dir", ".", "--raw"], {
        cwd: root,
      }).expect();
      expect(explicit.stdout).toContain("Hello from a component");
    });

    it("IE18: running an inline document leaves the directory as it was", function* () {
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
        "5",
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

    it("IE22: xmd targets takes no inline document either", function* () {
      const { code, stderr } = yield* runCli(["targets", "-e", "# Hello"]).join();
      expect(code).toBe(1);
      expect(stderr).toContain("exclusive to xmd run");
    });

    it("IE23: an inline document addresses no target, so a `#` in it is text", function* () {
      // Document references are file paths; the inline text is never split at
      // a `#`, and a heading it happens to contain stays a heading.
      const { code, stdout } = yield* runCli([
        "-e",
        "# Title\n\n## Alpha\n\nALPHA_MARKER\n\n## Beta\n\nBETA_MARKER\n",
        "--raw",
      ]).join();

      expect(code).toBe(0);
      expect(stdout).toContain("ALPHA_MARKER");
      expect(stdout).toContain("BETA_MARKER");
    });
  },
);
