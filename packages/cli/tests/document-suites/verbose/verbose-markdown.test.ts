/**
 * Tier VB — the checked-in Markdown suite for `<Verbose>`, launched once per
 * runtime corpus.
 *
 * The row evidence lives in `Verbose.test.md`; this wrapper supplies a script
 * for invoking this repository's runtime-specific `xmd` entrypoint, the
 * absolute path of the checked-in fixture components beside it, and asserts
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
import { fileURLToPath } from "node:url";
import { runMarkdownTier } from "../../support/run-markdown-tier.ts";

const XMD = "XMD_VERBOSE_BIN";
const COMPONENTS = "XMD_VERBOSE_COMPONENTS";

/**
 * The lexical-override fixtures, by absolute path.
 *
 * The rows that use them run from a temporary directory, so a repository-
 * relative `--include` would name nothing. Taken from this module's own URL
 * rather than from the working directory, because the corpus launches each
 * runtime's test process its own way.
 */
const COMPONENTS_DIR = fileURLToPath(new URL("./components", import.meta.url));

/** Publish `name` for the child processes the Markdown rows launch. */
function* useEnv(name: string, value: string): Operation<void> {
  const previous = process.env[name];
  process.env[name] = value;
  yield* ensure(function* () {
    if (previous === undefined) {
      delete process.env[name];
      return;
    }
    process.env[name] = previous;
  });
}

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

  yield* useEnv(XMD, script);
  return script;
}

describe(
  "Tier VB — checked-in Markdown suite",
  { sanitizeOps: false, sanitizeResources: false },
  () => {
    it("runs Verbose.test.md once under the production run command", function* () {
      const run = yield* scoped(function* () {
        yield* useXmdScript();
        yield* useEnv(COMPONENTS, COMPONENTS_DIR);
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
