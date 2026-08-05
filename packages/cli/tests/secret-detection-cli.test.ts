/**
 * Tier SD — `--no-secret-detection`, the host's opt-out (#199).
 *
 * Shells out with captured stdio, so exit status and the two streams are
 * observed the way a caller sees them. What these measure that no core test
 * can reach: that the resolved option arrives at every document each command
 * form runs, that the warning belongs to the invocation rather than to a
 * document, and that turning detection off changes what persists rather than
 * merely quieting an error — the journal file is read for that.
 *
 * The credential is synthetic and assembled here, so no usable-looking literal
 * enters the repository. No test reads an environment variable, a Git
 * credential, or user configuration.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { runCli } from "@executablemd/test-support/launch";
import { ensure, until } from "effection";
import type { Operation } from "effection";
import { readTextFile, rm, writeTextFile } from "@effectionx/fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** A synthetic GitHub token, format-realistic and assembled at run time. */
const CANARY = ["ghp", "_", ALPHABET].join("");

const WARNING = "WARNING: secret detection is disabled; credentials may be persisted.";

/** A document whose own source carries the canary into the root import event. */
const TAINTED = `# Tainted\n\nThe token is ${CANARY} and must never persist.\n`;

/** The same, as a test document, so \`xmd test\` has something to discover. */
const TAINTED_TEST = `# Tainted\n\n<Test name="holds a token">\n<Assert expr={true} />\n</Test>\n\nThe token is ${CANARY}.\n`;

/** A directory target needs more than one document to prove "warns once". */
function* useWorkspace(): Operation<string> {
  const root = yield* until(mkdtemp(join(tmpdir(), "xmd-secret-cli-")));
  yield* ensure(() => rm(root, { recursive: true, force: true }));
  yield* writeTextFile(join(root, "tainted.md"), TAINTED);
  yield* writeTextFile(join(root, "a.test.md"), TAINTED_TEST);
  yield* writeTextFile(join(root, "b.test.md"), TAINTED_TEST);
  return root;
}

/** How many times `needle` occurs in `text`. */
function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

describe(
  "Tier SD — the CLI secret-detection opt-out",
  {
    sanitizeOps: false,
    sanitizeResources: false,
  },
  () => {
    it("SD1: xmd run refuses a credential-shaped document by default", function* () {
      const root = yield* useWorkspace();

      const { code, stderr, stdout } = yield* runCli(["run", "tainted.md", "--raw"], {
        cwd: root,
      }).join();

      expect(code).not.toBe(0);
      expect(stderr).toContain("secret detection rejected content");
      expect(stdout).not.toContain(CANARY);
      expect(stderr).not.toContain(WARNING);
    });

    it("SD2: --no-secret-detection runs the same document", function* () {
      const root = yield* useWorkspace();

      const { stdout, stderr } = yield* runCli(
        ["run", "tainted.md", "--raw", "--no-secret-detection"],
        { cwd: root },
      ).expect();

      expect(stdout).toContain(CANARY);
      expect(stderr).toContain(WARNING);
    });

    it("SD3: the implicit run form honours the option in both directions", function* () {
      const root = yield* useWorkspace();

      const refused = yield* runCli(["tainted.md", "--raw"], { cwd: root }).join();
      expect(refused.code).not.toBe(0);

      const allowed = yield* runCli(["tainted.md", "--raw", "--no-secret-detection"], {
        cwd: root,
      }).expect();
      expect(allowed.stdout).toContain(CANARY);
      expect(allowed.stderr).toContain(WARNING);
    });

    it("SD4: the inline form honours the option in both directions", function* () {
      const root = yield* useWorkspace();

      const refused = yield* runCli(["-e", TAINTED, "--raw"], { cwd: root }).join();
      expect(refused.code).not.toBe(0);
      expect(refused.stderr).toContain("secret detection rejected content");

      const allowed = yield* runCli(["-e", TAINTED, "--raw", "--no-secret-detection"], {
        cwd: root,
      }).expect();
      expect(allowed.stdout).toContain(CANARY);
      expect(allowed.stderr).toContain(WARNING);
    });

    it("SD5: xmd test on one document is default-on and honours the opt-out", function* () {
      const root = yield* useWorkspace();

      const refused = yield* runCli(["test", "a.test.md", "--raw"], { cwd: root }).join();
      expect(refused.code).not.toBe(0);
      expect(refused.stderr).not.toContain(WARNING);

      const allowed = yield* runCli(["test", "a.test.md", "--raw", "--no-secret-detection"], {
        cwd: root,
      }).join();
      expect(allowed.stderr).toContain(WARNING);
      expect(allowed.stdout).toContain(CANARY);
    });

    it("SD6: xmd test on a directory is default-on and honours the opt-out", function* () {
      const root = yield* useWorkspace();

      const refused = yield* runCli(["test", ".", "--raw"], { cwd: root }).join();
      expect(refused.code).not.toBe(0);
      expect(refused.stderr).not.toContain(WARNING);

      const allowed = yield* runCli(["test", ".", "--raw", "--no-secret-detection"], {
        cwd: root,
      }).join();
      expect(allowed.stdout).toContain(CANARY);
    });

    it("SD7: a directory run warns exactly once, however many documents it holds", function* () {
      const root = yield* useWorkspace();

      const { stdout, stderr } = yield* runCli(["test", ".", "--raw", "--no-secret-detection"], {
        cwd: root,
      }).join();

      // Both documents ran — otherwise "once" would be trivially true.
      expect(stdout).toContain("a.test.md");
      expect(stdout).toContain("b.test.md");
      expect(occurrences(stderr, WARNING)).toBe(1);
    });

    it("SD8: the warning is stderr's alone and never carries the credential", function* () {
      const root = yield* useWorkspace();

      const { stdout, stderr } = yield* runCli(
        ["run", "tainted.md", "--raw", "--no-secret-detection"],
        { cwd: root },
      ).expect();

      expect(stderr).toContain(WARNING);
      expect(stdout).not.toContain(WARNING);
      expect(stderr).not.toContain(CANARY);
    });

    it("SD9: help lists the option a caller writes, on both commands", function* () {
      const run = yield* runCli(["run", "--help"]).expect();
      const test = yield* runCli(["test", "--help"]).expect();

      expect(run.stdout).toContain("--no-secret-detection");
      expect(test.stdout).toContain("--no-secret-detection");
    });

    it("SD10: with detection on, the offending event never reaches the journal", function* () {
      const root = yield* useWorkspace();
      const journal = join(root, "on.jsonl");

      const { code } = yield* runCli(["run", "tainted.md", "--raw", "--journal", journal], {
        cwd: root,
      }).join();

      expect(code).not.toBe(0);
      // The file exists — the run journaled its own failure — and the event the
      // gate refused is absent from it.
      expect(yield* readTextFile(journal)).not.toContain(CANARY);
    });

    it("SD11: with detection off, the same event reaches the journal", function* () {
      const root = yield* useWorkspace();
      const journal = join(root, "off.jsonl");

      yield* runCli(["run", "tainted.md", "--raw", "--no-secret-detection", "--journal", journal], {
        cwd: root,
      }).expect();

      // The pair with SD10 is the point: the option changed what persisted, not
      // merely whether an error was printed.
      expect(yield* readTextFile(journal)).toContain(CANARY);
    });

    it("SD12: the value form is refused rather than silently read as enabled", function* () {
      const root = yield* useWorkspace();

      for (const flag of ["--secret-detection=false", "--no-secret-detection=true"]) {
        const { code, stderr } = yield* runCli(["run", "tainted.md", "--raw", flag], {
          cwd: root,
        }).join();

        expect(code).not.toBe(0);
        expect(stderr).toContain("does not take a value");
        expect(stderr).toContain("--no-secret-detection");
        expect(stderr).not.toContain(WARNING);
      }
    });
  },
);
