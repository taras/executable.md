/**
 * Trusted scanning of candidate snapshot files.
 *
 * The scan reads through `@effectionx/fs` directly rather than the runtime
 * `Fs` Context Api, so a document cannot decide what the inspector sees. One
 * test proves that by installing hostile middleware and checking the scan
 * still reads the real bytes.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure } from "effection";
import { ensureDir, rm, writeTextFile } from "@effectionx/fs";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { API } from "@executablemd/runtime";
import { readTextFile } from "@executablemd/runtime";
import type { Operation } from "effection";
import { scanFiles } from "../src/secrets/files.ts";
import { createSecretScanner } from "../src/secrets/scanner.ts";

const A = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const CANARY = `ghp_${A.slice(0, 36)}`;

/**
 * `@effectionx/fs` has no temp-directory operation, so the one call that has
 * to reach past it is this. Everything else in these tests uses the library.
 */
function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "xmd-secret-files-"));
}

/** Middleware that hides file contents from anything reading through Fs. */
function* useHostileFs(): Operation<void> {
  yield* API.Fs.around({
    // deno-lint-ignore require-yield
    *readTextFile() {
      return "nothing to see here";
    },
    // deno-lint-ignore require-yield
    *glob() {
      return [];
    },
  });
}

describe("scanFiles", () => {
  it("clears a candidate whose every file is clean", function* () {
    const dir = makeTmpDir();
    yield* ensure(() => rm(dir, { recursive: true, force: true }));

    yield* writeTextFile(path.join(dir, "journal.jsonl"), '{"type":"close","result":"ok"}\n');
    yield* writeTextFile(path.join(dir, "manifest.json"), '{"secretDetection":true}\n');

    expect(yield* scanFiles(dir, createSecretScanner())).toEqual([]);
  });

  it("reports the file a credential was found in", function* () {
    const dir = makeTmpDir();
    yield* ensure(() => rm(dir, { recursive: true, force: true }));

    yield* ensureDir(path.join(dir, "artifacts"));
    yield* writeTextFile(path.join(dir, "journal.jsonl"), '{"type":"close"}\n');
    yield* writeTextFile(path.join(dir, "artifacts", "report.md"), `token: ${CANARY}\n`);

    const findings = yield* scanFiles(dir, createSecretScanner());

    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0]!.path).toContain("report.md");
    expect(JSON.stringify(findings)).not.toContain(CANARY);
  });

  it("reports every offending file rather than stopping at the first", function* () {
    const dir = makeTmpDir();
    yield* ensure(() => rm(dir, { recursive: true, force: true }));

    yield* writeTextFile(path.join(dir, "one.txt"), `a: ${CANARY}\n`);
    yield* writeTextFile(path.join(dir, "two.txt"), `b: npm_${A.slice(0, 36)}\n`);

    const paths = new Set((yield* scanFiles(dir, createSecretScanner())).map((f) => f.path));

    expect(paths.size).toBe(2);
  });

  it("reads the real file even when hostile Fs middleware is installed", function* () {
    const dir = makeTmpDir();
    yield* ensure(() => rm(dir, { recursive: true, force: true }));
    yield* writeTextFile(path.join(dir, "leak.txt"), `token: ${CANARY}\n`);

    yield* useHostileFs();

    // The middleware is in scope and does blind anything going through the
    // Fs Api — including this read, which is what a document's own code would
    // get.
    expect(yield* readTextFile(path.join(dir, "leak.txt"))).toBe("nothing to see here");

    // The trusted scan bypasses that Api entirely, so it still finds the
    // credential a compromised or sandboxed document tried to conceal.
    const findings = yield* scanFiles(dir, createSecretScanner());

    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0]!.path).toContain("leak.txt");
    expect(JSON.stringify(findings)).not.toContain(CANARY);
  });
});
