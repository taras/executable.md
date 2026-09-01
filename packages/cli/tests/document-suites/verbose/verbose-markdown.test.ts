/**
 * Tier VB — the checked-in Markdown suite for `<Verbose>`, launched once per
 * runtime corpus.
 *
 * The row evidence lives in `Verbose.test.md`; this wrapper supplies a script
 * for invoking this repository's runtime-specific `xmd` entrypoint and asserts
 * only that the Markdown suite produced passing rows.
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

const XMD = "XMD_VERBOSE_BIN";

function quote(argument: string): string {
  return `'${argument.replaceAll("'", "'\\''")}'`;
}

function* useXmdScript(): Operation<string> {
  const dir = join(tmpdir(), `xmd-vb-${randomUUID()}`);
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
  "Tier VB — checked-in Markdown suite",
  { sanitizeOps: false, sanitizeResources: false },
  () => {
    it("runs Verbose.test.md once under the production run command", function* () {
      const run = yield* scoped(function* () {
        yield* useXmdScript();
        return yield* runMarkdownTier("packages/cli/tests/document-suites/verbose/Verbose.test.md");
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
