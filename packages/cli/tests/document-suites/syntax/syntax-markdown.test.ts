/**
 * Tier SM — the checked-in Markdown suite for `xmd syntax`, launched once per
 * runtime corpus (quest #543, issue #583).
 *
 * Suite infrastructure, not a second proof of any row: the row evidence is in
 * `Syntax.test.md`, and this file asserts only that the one execution succeeded
 * and that its results are non-empty and all passing.
 *
 * The one thing it does supply is a way for the document to invoke this
 * repository's `xmd`. Which interpreter and entrypoint that is differs by
 * runtime, and a document must not detect a runtime (Code Rule 12) — so the
 * launcher writes the command line into a small script and names it in the
 * environment the document's commands inherit.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { cliCommand } from "@executablemd/test-support/launch";
import { ensureDir, rm, writeTextFile } from "@effectionx/fs";
import { ensure, scoped, until } from "effection";
import type { Operation } from "effection";
import { chmod } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { runMarkdownTier } from "../../support/run-markdown-tier.ts";

/** The variable `Syntax.test.md` invokes this repository's `xmd` through. */
const XMD = "XMD_SYNTAX_BIN";

function quote(argument: string): string {
  return `'${argument.replaceAll("'", "'\\''")}'`;
}

/**
 * A script that runs this repository's `xmd` with whatever arguments it is
 * given.
 *
 * A script rather than a command string in the environment, because the
 * document would then have to re-split it: a path with a space in it is one
 * argument, and word splitting cannot know that.
 */
function* useXmdScript(): Operation<string> {
  const dir = join(tmpdir(), `xmd-sm-${randomUUID()}`);
  const script = join(dir, "xmd");
  yield* ensureDir(dir);
  yield* ensure(() => rm(dir, { recursive: true, force: true }));

  const { command, arguments: args } = cliCommand([]);
  yield* writeTextFile(script, `#!/bin/sh\nexec ${[command, ...args].map(quote).join(" ")} "$@"\n`);
  yield* until(chmod(script, 0o755));

  const previous = process.env[XMD];
  process.env[XMD] = script;
  yield* ensure(function* () {
    if (previous === undefined) {
      delete process.env[XMD];
      return;
    }
    process.env[XMD] = previous;
  });
  return script;
}

describe(
  "Tier SM — checked-in Markdown suite",
  { sanitizeOps: false, sanitizeResources: false },
  () => {
    it("runs Syntax.test.md once under the production run host", function* () {
      const run = yield* scoped(function* () {
        yield* useXmdScript();
        return yield* runMarkdownTier("packages/cli/tests/document-suites/syntax/Syntax.test.md");
      });
      if (!run.completion.ok) {
        throw run.completion.error;
      }
      expect(run.results.length).toBeGreaterThan(0);
      for (const result of run.results) {
        expect(result.status).toBe("pass");
      }
    });
  },
);
