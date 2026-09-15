/**
 * Tier PC — `--plugin` as an operator writes it.
 *
 * Shelled out, because what these rows are about is the whole invocation: which
 * modules were loaded, in which order they composed, what a refusal costs, and
 * what a command line that selected nothing still does. A Plugin composes
 * around a document, so the evidence is the document's own output.
 *
 * The fixtures live in this checkout and are named by path, which is the only
 * way a module is ever selected: nothing here scans a directory, a manifest or
 * the document, and `inert.mjs` sits beside the selected ones announcing itself
 * so that discovering it would be visible.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { runCli } from "@executablemd/test-support/launch";
import { ensure, scoped } from "effection";
import type { Operation } from "effection";
import { ensureDir, exists, rm, writeTextFile } from "@effectionx/fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURES = fileURLToPath(new URL("./fixtures/plugins/", import.meta.url));
const REPOSITORY = fileURLToPath(new URL("../../../", import.meta.url));

/** One fixture Plugin, named the way an operator names one: by path. */
function fixture(name: string): string {
  return join(FIXTURES, name);
}

/** A scratch workspace holding the files a row runs against. */
function* useWorkspace<T>(
  files: Record<string, string>,
  body: (dir: string) => Operation<T>,
): Operation<T> {
  const dir = join(tmpdir(), `xmd-pc-${randomUUID()}`);
  return yield* scoped(function* () {
    yield* ensure(() => rm(dir, { recursive: true, force: true }));
    // Created whether or not there are files: a row whose subject is a command
    // that reads no document still runs in this directory.
    yield* ensureDir(dir);
    for (const [name, content] of Object.entries(files)) {
      const path = join(dir, name);
      yield* ensureDir(dirname(path));
      yield* writeTextFile(path, content);
    }
    return yield* body(dir);
  });
}

const DOCUMENT = "document body\n";

describe("PC1 — selected Plugins compose around the document, in the order written", () => {
  it("nests two wrappers with the first one written outermost", function* () {
    yield* useWorkspace({ "doc.md": DOCUMENT }, function* (dir) {
      const run = yield* runCli(
        [
          "run",
          "--plugin",
          fixture("wrapper-one.mjs"),
          `--plugin=${fixture("wrapper-two.mjs")}`,
          "doc.md",
        ],
        { cwd: dir },
      ).expect();
      const order = ["one open", "two open", "document body", "two close", "one close"];
      const at = order.map((token) => run.stdout.indexOf(token));
      expect(at.every((index) => index >= 0)).toBe(true);
      expect([...at].sort((a, b) => a - b)).toEqual(at);
    });
  });

  it("reverses the composition when the selection is reversed", function* () {
    yield* useWorkspace({ "doc.md": DOCUMENT }, function* (dir) {
      const run = yield* runCli(
        [
          "run",
          `--plugin=${fixture("wrapper-two.mjs")}`,
          "--plugin",
          fixture("wrapper-one.mjs"),
          "doc.md",
        ],
        { cwd: dir },
      ).expect();
      expect(run.stdout.indexOf("two open")).toBeLessThan(run.stdout.indexOf("one open"));
    });
  });

  it("projects the document once for each placeholder a wrapper writes", function* () {
    yield* useWorkspace({ "doc.md": DOCUMENT }, function* (dir) {
      const run = yield* runCli(["run", `--plugin=${fixture("twice.mjs")}`, "doc.md"], {
        cwd: dir,
      }).expect();
      expect(run.stdout.split("document body").length - 1).toBe(2);
    });
  });

  it("shows every Plugin the complete list, bundled Plugins first", function* () {
    yield* useWorkspace({ "doc.md": DOCUMENT }, function* (dir) {
      const run = yield* runCli(
        [
          "run",
          `--plugin=${fixture("active.mjs")}`,
          `--plugin=${fixture("wrapper-one.mjs")}`,
          "doc.md",
        ],
        { cwd: dir },
      ).expect();
      expect(run.stdout).toContain("active: @executablemd/code-review-agent, active, wrapper-one");
    });
  });

  it("composes the root's metadata without touching anything else", function* () {
    yield* useWorkspace(
      { "doc.md": ["---", "badge: authored", "---", "", "badge is {meta.badge}", ""].join("\n") },
      function* (dir) {
        const plain = yield* runCli(["run", "doc.md"], { cwd: dir }).expect();
        expect(plain.stdout).toContain("badge is authored");
        const composed = yield* runCli(["run", `--plugin=${fixture("metadata.mjs")}`, "doc.md"], {
          cwd: dir,
        }).expect();
        expect(composed.stdout).toContain("badge is composed");
      },
    );
  });
});

describe("PC2 — a Plugin declares components, and a checkout cannot answer for them", () => {
  it("resolves a declared component, and leaves the checkout's own components alone", function* () {
    yield* useWorkspace(
      {
        "doc.md": "<Greeting />\n\n<Shadowed />\n\n<Local />\n",
        // A repository component of the same name as one the Plugin declares,
        // and one of a name nothing declares.
        "components/Shadowed.md": "the checkout's own component\n",
        "components/Local.md": "an unrelated checkout component\n",
      },
      function* (dir) {
        const run = yield* runCli(["run", `--plugin=${fixture("declaring.mjs")}`, "doc.md"], {
          cwd: dir,
        }).expect();
        expect(run.stdout).toContain("hello from the selected Plugin");
        expect(run.stdout).toContain("the selected declaration, not the checkout's");
        expect(run.stdout).not.toContain("the checkout's own component");
        // Declaring two names claims exactly those two: everything else in the
        // checkout resolves as it always did.
        expect(run.stdout).toContain("an unrelated checkout component");
      },
    );
  });

  it("refuses two Plugins declaring one component name, before the document runs", function* () {
    yield* useWorkspace({ "doc.md": "<Greeting />\n" }, function* (dir) {
      const run = yield* runCli(
        [
          "run",
          `--plugin=${fixture("declaring.mjs")}`,
          `--plugin=${fixture("declaring-again.mjs")}`,
          "doc.md",
        ],
        { cwd: dir },
      ).join();
      expect(run.code).not.toBe(0);
      expect(`${run.stderr}${run.stdout}`).toContain("Greeting");
      expect(run.stdout).not.toContain("hello from the selected Plugin");
    });
  });
});

describe("PC3 — a selection that cannot be honored costs nothing", () => {
  /** Run one refusal against a document whose body would write a file. */
  function* refused(
    args: readonly string[],
  ): Operation<{ status: number | undefined; report: string }> {
    return yield* useWorkspace(
      {
        "doc.md": ["```sh", `echo ran > ran.txt`, "```", ""].join("\n"),
      },
      function* (dir) {
        // The document first, so a selection written with no value cannot take
        // the document reference as the module it was asked for.
        const run = yield* runCli(["run", "doc.md", ...args], { cwd: dir }).join();
        // The root is never read, so nothing the document would have done
        // happened: the refusal is before the document, not during it.
        expect(yield* exists(join(dir, "ran.txt"))).toBe(false);
        return { status: run.code, report: `${run.stderr}${run.stdout}` };
      },
    );
  }

  it("refuses a module that exports no Plugin", function* () {
    const outcome = yield* refused([`--plugin=${fixture("no-default.mjs")}`]);
    expect(outcome.status).not.toBe(0);
    expect(outcome.report).toContain("no-default.mjs");
    expect(outcome.report).toContain("is a Plugin value; this module exports none");
  });

  it("refuses a default export carrying no name", function* () {
    const outcome = yield* refused([`--plugin=${fixture("unnamed.mjs")}`]);
    expect(outcome.status).not.toBe(0);
    expect(outcome.report).toContain("carries a non-empty string `name`");
  });

  it("refuses a default export whose install is not callable", function* () {
    const outcome = yield* refused([`--plugin=${fixture("bad-install.mjs")}`]);
    expect(outcome.status).not.toBe(0);
    expect(outcome.report).toContain("carries a callable `install`");
  });

  it("refuses a module that is not there", function* () {
    const outcome = yield* refused([`--plugin=${fixture("absent.mjs")}`]);
    expect(outcome.status).not.toBe(0);
    expect(outcome.report).toContain("could not be loaded");
  });

  it("refuses two selections claiming one Plugin name", function* () {
    const outcome = yield* refused([
      `--plugin=${fixture("wrapper-one.mjs")}`,
      `--plugin=${fixture("same-name.mjs")}`,
    ]);
    expect(outcome.status).not.toBe(0);
    expect(outcome.report).toContain("two selected Plugins are named wrapper-one");
  });

  it("refuses a remote specifier without fetching anything", function* () {
    const outcome = yield* refused(["--plugin=https://example.invalid/plugin.mjs"]);
    expect(outcome.status).not.toBe(0);
    expect(outcome.report).toContain("xmd loads no code over the network");
  });

  it("refuses a selection with no value", function* () {
    const outcome = yield* refused(["--plugin"]);
    expect(outcome.status).not.toBe(0);
    expect(outcome.report).toContain("names a module to load");
  });
});

describe("PC4 — nothing is discovered, and nothing unselected runs", () => {
  it("loads no Plugin at all when none was selected", function* () {
    yield* useWorkspace({ "doc.md": DOCUMENT }, function* (dir) {
      const run = yield* runCli(["run", "doc.md"], { cwd: dir }).expect();
      expect(run.stdout).toContain("document body");
      expect(run.stdout).not.toContain("one open");
      // The fixture directory holds a module that announces itself the moment
      // anything loads it, and nothing did.
      expect(run.stderr).not.toContain("inert-fixture");
    });
  });

  it("leaves an unselected module beside a selected one inert", function* () {
    yield* useWorkspace({ "doc.md": DOCUMENT }, function* (dir) {
      const run = yield* runCli(["run", `--plugin=${fixture("wrapper-one.mjs")}`, "doc.md"], {
        cwd: dir,
      }).expect();
      expect(run.stdout).toContain("one open");
      expect(run.stderr).not.toContain("inert-fixture");
    });
  });

  it("loads nothing for help or the version", function* () {
    const help = yield* runCli(["--plugin", fixture("wrapper-one.mjs"), "--help"]).expect();
    expect(help.stdout).toContain("xmd");
    expect(help.stdout).not.toContain("one open");
    const version = yield* runCli(["--plugin", fixture("wrapper-one.mjs"), "--version"]).expect();
    expect(version.stdout).not.toContain("one open");
  });

  it("describes the option in its own help", function* () {
    const help = yield* runCli(["run", "--help"]).expect();
    expect(help.stdout).toContain("--plugin");
  });
});

describe("PC5 — a Plugin reads configuration, never document properties", () => {
  it("reads every Config value the command line settled", function* () {
    yield* useWorkspace({ "doc.md": DOCUMENT }, function* (dir) {
      const quiet = yield* runCli(["run", `--plugin=${fixture("configured.mjs")}`, "doc.md"], {
        cwd: dir,
      }).expect();
      // Nothing configured is nothing, not a number somebody guessed.
      expect(quiet.stdout).toContain("verbose: false");
      expect(quiet.stdout).toContain("timeout: undefined");
      expect(quiet.stdout).toContain("timeoutExec: undefined");
      expect(quiet.stdout).toContain("timeoutFetch: undefined");

      const configured = yield* runCli(
        [
          "run",
          `--plugin=${fixture("configured.mjs")}`,
          "--verbose",
          "--timeout",
          "30s",
          "--timeout-exec",
          "10s",
          "--timeout-fetch",
          "5s",
          "doc.md",
        ],
        { cwd: dir },
      ).expect();
      // Installed before the Plugin, so a Plugin reads the same typed answers
      // every other consumer reads rather than a second reading of argv.
      expect(configured.stdout).toContain("verbose: true");
      expect(configured.stdout).toContain("timeout: 30000");
      expect(configured.stdout).toContain("timeoutExec: 10000");
      expect(configured.stdout).toContain("timeoutFetch: 5000");
    });
  });

  it("leaves root properties spelled like CLI options out of the configuration", function* () {
    yield* useWorkspace(
      {
        "doc.md": [
          "---",
          "props:",
          "  verbose:",
          "    type: string",
          "  timeout:",
          "    type: string",
          "---",
          "",
          "props are {props.verbose} and {props.timeout}",
          "",
        ].join("\n"),
      },
      function* (dir) {
        const run = yield* runCli(
          [
            "run",
            `--plugin=${fixture("configured.mjs")}`,
            "doc.md",
            "--props-verbose",
            "yes",
            "--props-timeout",
            "99s",
          ],
          { cwd: dir },
        ).expect();
        expect(run.stdout).toContain("props are yes and 99s");
        // The document's properties are the document's. Nothing copied one into
        // the configuration a Plugin, a component or the engine reads.
        expect(run.stdout).toContain("verbose: false");
        expect(run.stdout).toContain("timeout: undefined");
      },
    );
  });
});

describe("PC6 — every surface of one command sees one vocabulary", () => {
  it("describes a selected Plugin's declarations in xmd syntax", function* () {
    yield* useWorkspace({}, function* (dir) {
      const run = yield* runCli(["syntax", `--plugin=${fixture("declaring.mjs")}`], {
        cwd: dir,
      }).expect();
      expect(run.stdout).toContain("Greeting");
      // And the bundled review graph is still described beside it.
      expect(run.stdout).toContain("Finding");
    });
  });

  it("describes none of it where no Plugin was selected", function* () {
    yield* useWorkspace({}, function* (dir) {
      const run = yield* runCli(["syntax"], { cwd: dir }).expect();
      expect(run.stdout).not.toContain("Greeting");
      expect(run.stdout).toContain("Finding");
    });
  });
});

/**
 * A package installed where the command runs, as an operator would have it.
 *
 * Written into the workspace's own `node_modules`, because that is what "from
 * the invocation's working directory" means: the CLI resolves a bare specifier
 * in the package environment the caller is standing in rather than in its own.
 */
function installedPackage(name: string, module: string): Record<string, string> {
  return {
    [`node_modules/${name}/package.json`]: `${JSON.stringify(
      { name, type: "module", main: "index.mjs", exports: "./index.mjs" },
      null,
      2,
    )}\n`,
    [`node_modules/${name}/index.mjs`]: module,
  };
}

/** A Plugin module that names itself something other than its package. */
function renamedPlugin(pluginName: string, marker: string): string {
  return [
    `console.error("${marker}: loaded");`,
    "",
    "export default {",
    `  name: "${pluginName}",`,
    "  *install(request) {",
    `    console.error(\`${marker}: installed for \${request.command}\`);`,
    "    return undefined;",
    "  },",
    "};",
    "",
  ].join("\n");
}

describe("PC7 — a package is selected by name, from where the command runs", () => {
  it("loads a bare package from the invocation directory, named by its own name", function* () {
    yield* useWorkspace(
      {
        "doc.md": DOCUMENT,
        ...installedPackage(
          "@fixture/selected-package",
          renamedPlugin("renamed-by-its-author", "selected-package"),
        ),
        // Installed beside it and named by nobody.
        ...installedPackage(
          "@fixture/unselected-package",
          renamedPlugin("unselected", "unselected-package"),
        ),
      },
      function* (dir) {
        const run = yield* runCli(
          [
            "run",
            "--plugin",
            "@fixture/selected-package",
            `--plugin=${fixture("active.mjs")}`,
            "doc.md",
          ],
          { cwd: dir },
        ).expect();
        expect(run.stderr).toContain("selected-package: loaded");
        expect(run.stderr).toContain("selected-package: installed for run");
        // A Plugin's name is its own. The package it came from is how an
        // operator found it, and nothing resolves one to the other.
        expect(run.stdout).toContain(
          "active: @executablemd/code-review-agent, renamed-by-its-author, active",
        );
        // And the package installed beside it did nothing at all: presence is
        // not selection, and nothing here scans `node_modules`.
        expect(run.stderr).not.toContain("unselected-package");
      },
    );
  });

  it("leaves an installed package inert until it is named", function* () {
    yield* useWorkspace(
      {
        "doc.md": DOCUMENT,
        ...installedPackage(
          "@fixture/unselected-package",
          renamedPlugin("unselected", "unselected-package"),
        ),
      },
      function* (dir) {
        const run = yield* runCli(["run", "doc.md"], { cwd: dir }).expect();
        expect(run.stdout).toContain("document body");
        expect(run.stderr).not.toContain("unselected-package");
      },
    );
  });

  it("loads a relative path inside the directory the command runs in", function* () {
    yield* useWorkspace(
      {
        "doc.md": DOCUMENT,
        "plugins/local.mjs": renamedPlugin("project-local", "project-local"),
      },
      function* (dir) {
        const run = yield* runCli(["run", "--plugin", "./plugins/local.mjs", "doc.md"], {
          cwd: dir,
        }).expect();
        expect(run.stderr).toContain("project-local: installed for run");
        expect(run.stdout).toContain("document body");
      },
    );
  });

  it("loads a relative path inside this repository, written from its root", function* () {
    // The repository is an ordinary directory to this boundary: an explicit
    // path inside the checkout is valid because an operator wrote it, and it is
    // still explicit — nothing discovered it.
    const run = yield* runCli(
      [
        "run",
        "--plugin",
        "./packages/cli/tests/fixtures/plugins/external.mjs",
        "--eval",
        "document body\n",
      ],
      { cwd: REPOSITORY },
    ).expect();
    expect(run.stderr).toContain("external-fixture: installed for run");
    expect(run.stdout).toContain("document body");
  });
});

describe("PC8 — an Api built under the bare public name intercepts nothing", () => {
  it("leaves the document unwrapped and the run unchanged", function* () {
    yield* useWorkspace({ "doc.md": DOCUMENT }, function* (dir) {
      const run = yield* runCli(["run", `--plugin=${fixture("impostor.mjs")}`, "doc.md"], {
        cwd: dir,
      }).expect();
      expect(run.stdout).toContain("document body");
      // The Api canonical core publishes is keyed by package and boundary, so a
      // same-named one addresses a different context: there is nothing for it
      // to be nearer than, and nothing for it to replace.
      expect(run.stdout).not.toContain("INTERCEPTED");
    });
  });

  it("still composes with a Plugin that reached the canonical key", function* () {
    yield* useWorkspace({ "doc.md": DOCUMENT }, function* (dir) {
      const run = yield* runCli(
        [
          "run",
          `--plugin=${fixture("impostor.mjs")}`,
          `--plugin=${fixture("wrapper-one.mjs")}`,
          "doc.md",
        ],
        { cwd: dir },
      ).expect();
      expect(run.stdout).toContain("one open");
      expect(run.stdout).toContain("document body");
      expect(run.stdout).not.toContain("INTERCEPTED");
    });
  });
});
