import { replMountsJourney } from "../../packages/cli/tests/support/repl-mounts-journey.ts";
/**
 * The same journey, against the compiled binary (#181 E1).
 *
 * A compiled `xmd` has no checkout to read from and no module graph to lose a
 * module out of — it has whatever `deno compile` embedded. The entry host is
 * assembled by `compiled.ts`, which is a different entrypoint from the one the
 * source row runs, so a binary that was built without it would start a REPL,
 * perform the file work and retain none of it: the defect would appear at a
 * person's first reopened location rather than here.
 *
 * It runs the *same* journey as the source row, from one shared module, so the
 * two cannot drift into asserting different things.
 *
 * It runs against `dist/xmd`, so `deno task build` has to have happened. A
 * missing binary is reported as the setup it is rather than as a failure of the
 * behavior.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { useTempDirectory } from "@executablemd/test-support/temp";
import { chmod, realpath, symlink, unlink } from "node:fs/promises";
import { runShell, shellQuote } from "@executablemd/test-support/launch";
import { ensureDir, exists, writeTextFile } from "@effectionx/fs";
import { scoped, until, type Operation } from "effection";
import {
  allocate,
  focusPtyDraft,
  settledEntry,
  showing,
  showingAcross,
} from "../../packages/cli/tests/support/pty.ts";
import { fileURLToPath as fromFileUrl } from "node:url";
import { join } from "node:path";
import {
  click,
  ended,
  printedLocation,
  replFilesJourney,
  replGitJourney,
  replRepositoryJourney,
} from "../../packages/cli/tests/support/repl-files-journey.ts";

const ROOT = fromFileUrl(new URL("../..", import.meta.url));
const BINARY = join(ROOT, "dist", "xmd");

/** How this suite invokes the compiled `xmd`. */
function compiled(args: readonly string[]): string {
  return [shellQuote(BINARY), ...args].join(" ");
}

/** Refuse the row rather than skip it: a missing binary is missing evidence. */
function* requireBinary(): Operation<void> {
  if (!(yield* exists(BINARY))) {
    throw new Error(
      `this row drives the compiled binary and ${BINARY} is not there. Run \`deno task build\` ` +
        "first; a skipped row is missing evidence rather than a passing behavior.",
    );
  }
}

describe("the compiled binary's REPL entry files", () => {
  it("E1: carries the entry host, so a completed prefix answers again", function* (): Operation<void> {
    yield* requireBinary();
    yield* replFilesJourney(compiled);
  });

  it("E1: carries the managed selectors, so a Repository answers again", function* (): Operation<void> {
    yield* requireBinary();
    yield* replRepositoryJourney(compiled, "repository");
  });

  it("E1: carries the managed selectors, so a Worktree's path routes a Dir", function* (): Operation<void> {
    yield* requireBinary();
    yield* replRepositoryJourney(compiled, "worktree");
  });

  it("E1: carries the local Git handlers, so a committed id answers again", function* (): Operation<void> {
    yield* requireBinary();
    yield* replGitJourney(compiled, "ambient");
  });

  it("E1: carries them inside a selected Worktree too", function* (): Operation<void> {
    yield* requireBinary();
    yield* replGitJourney(compiled, "worktree");
  });
  it("the compiled binary carries workspace mount replay and live placement", function* () {
    yield* requireBinary();
    yield* replMountsJourney(compiled);
  });
});

describe("1440: installed development and explicit compiled launchers", () => {
  it("pastes each full reopen hint through the correct launcher and restores the selected entry", function* () {
    yield* requireBinary();
    const home = yield* until(realpath(yield* useTempDirectory("xmd-1440-")));
    const bin = join(home, "private bin");
    const project = join(home, "project", "nested");
    const leading = join(home, "leading PATH directory");
    yield* ensureDir(join(leading, "xmd"));
    yield* ensureDir(bin);
    yield* ensureDir(project);
    const launcher = join(bin, "xmd-dev");
    yield* until(symlink(join(ROOT, "scripts", "xmd-dev"), launcher));
    const prefix = `unset XMD_DEV_ROOT XMD_DEV_DENO; export PATH=${shellQuote(leading)}:${shellQuote(bin)}:"$PATH"; cd ${shellQuote(project)} &&`;
    const version = (yield* runShell(compiled(["--version"])).expect()).stdout.trim();
    const found = yield* runShell(`${prefix} command -v xmd-dev && xmd-dev --version`).expect();
    expect(found.stdout.trim().split("\n")).toEqual([launcher, version]);

    const override = join(home, "override checkout");
    const overrideDir = join(override, "packages", "cli", "src");
    yield* ensureDir(overrideDir);
    yield* writeTextFile(
      join(overrideDir, "deno.ts"),
      'console.log("override checkout witness");\n',
    );
    const overrideLaunch = yield* runShell(
      `${prefix} XMD_DEV_ROOT=${shellQuote(override)} xmd-dev --version`,
    ).expect();
    expect(overrideLaunch.stdout.trim()).toBe("override checkout witness");

    const decoy = join(bin, "xmd");
    yield* writeTextFile(
      decoy,
      `#!/bin/sh\nif [ "$1" = --version ]; then printf '%s\\n' ${shellQuote(version)}; else exit 73; fi\n`,
    );
    yield* until(chmod(decoy, 0o755));
    expect((yield* runShell(`${prefix} xmd --version`).expect()).stdout.trim()).toBe(version);
    expect((yield* runShell(`${prefix} xmd repl`).join()).code).toBe(73);

    const task = `deno task --cwd ${shellQuote(ROOT)} xmd`;
    expect((yield* runShell(`${prefix} ${task} --version`).expect()).stdout.trim()).toBe(version);
    const taskOutput = yield* runShell(
      `${prefix} ${task} run --eval ${shellQuote("<Output>Task argument witness</Output>")}`,
    ).expect();
    expect(taskOutput.stdout.trim()).toBe("Task argument witness");

    for (const command of ["xmd-dev", task, shellQuote(BINARY), "xmd"]) {
      if (command === "xmd") {
        yield* until(unlink(decoy));
        yield* until(symlink(BINARY, decoy));
      }
      yield* scoped(function* () {
        const pty = yield* allocate(`${prefix} ${command} repl --deny-all`, home);
        yield* showing(pty, "[exit]", 60_000);
        yield* focusPtyDraft(pty, 10_000);
        yield* pty.type("<Output>Retained launcher witness</Output>");
        yield* showing(pty, "Retained launcher witness", 10_000);
        yield* pty.type("\t\r");
        yield* settledEntry(pty, 1, "ok", 10_000);
        yield* click(pty, "[exit]");
        expect(yield* ended(pty)).toBe(0);
        const saved = printedLocation(yield* pty.finalOutput()).split("?")[0];
        expect(saved).toMatch(/\/entries\/entry-1$/);
        const location = saved + "?at=close:root&right=bindings";
        const selected = yield* allocate(`${prefix} ${command} repl ${shellQuote(location)}`, home);
        yield* showingAcross(selected, "Retained launcher witness", 30_000);
        yield* click(selected, "[exit]");
        expect(yield* ended(selected)).toBe(0);
        const printed = /^  (.+ repl 'xmd:\/\/repl\/[^']+')\r?$/m.exec(
          yield* selected.finalOutput(),
        )?.[1];
        if (printed === undefined) {
          throw new Error("The terminal printed no complete reopen command.");
        }
        if (command === "xmd") {
          expect(printed.startsWith("xmd repl ")).toBe(true);
        } else if (command === task) {
          expect(printed).toContain("XMD_REPL_DENO_PROFILE='repository-task'");
          expect(printed).toContain(" run --allow-all ");
          expect(printed).toContain(join(ROOT, "packages", "cli", "src", "deno.ts"));
        } else {
          expect(printed).toContain(command === "xmd-dev" ? shellQuote(launcher) : BINARY);
        }
        expect(printed.endsWith(shellQuote(location))).toBe(true);

        // A pasted development hint carries its original checkout even when
        // the receiving shell has selected another checkout.
        const pasted = yield* allocate(
          `${prefix} export XMD_DEV_ROOT=${shellQuote(override)}; ${printed}`,
          home,
        );
        yield* showingAcross(pasted, "Retained launcher witness", 30_000);
        yield* click(pasted, "[exit]");
        expect(yield* ended(pasted)).toBe(0);
        expect(yield* pasted.finalOutput()).toContain(printed);
      });
    }
  });
});
