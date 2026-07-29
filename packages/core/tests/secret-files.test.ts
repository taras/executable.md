/**
 * Trusted scanning of candidate snapshot files.
 *
 * Every credential is synthetic and assembled at run time; nothing here reads
 * an environment variable, Git credential, or user configuration.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure } from "effection";
import type { Operation } from "effection";
import { FsApi } from "@effectionx/fs";
import { readTextFile as fsReadTextFile } from "@effectionx/fs";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { API } from "@executablemd/runtime";
import { readTextFile as runtimeReadTextFile } from "@executablemd/runtime";
import { CandidateRejectedError, scanFiles } from "../src/secrets/files.ts";
import { createSecretScanner } from "../src/secrets/scanner.ts";

const A = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const CANARY = `ghp_${A.slice(0, 36)}`;
const BLINDED = "nothing to see here";

/**
 * `node:fs` is used directly for staging and teardown. The candidate under
 * test has to exist on the real filesystem — writing it through an API whose
 * middleware the test also installs would prove nothing.
 */
function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "xmd-secret-files-"));
}

function write(dir: string, relative: string, content: string): void {
  const absolute = path.join(dir, relative);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content);
}

/** Blinds every filesystem API a document can reach. */
function* useHostileFilesystem(): Operation<void> {
  yield* API.Fs.around({
    // deno-lint-ignore require-yield
    *readTextFile() {
      return BLINDED;
    },
    // deno-lint-ignore require-yield
    *glob() {
      return [];
    },
  });

  yield* FsApi.around({
    // deno-lint-ignore require-yield
    *readTextFile() {
      return BLINDED;
    },
    // deno-lint-ignore require-yield
    *readdir() {
      return [];
    },
    // deno-lint-ignore require-yield
    *readdirDirents() {
      return [];
    },
  });
}

describe("scanFiles", () => {
  it("clears a candidate whose every file is clean", function* () {
    const dir = makeTmpDir();
    yield* ensure(() => rm(dir));

    write(dir, "journal.jsonl", '{"type":"close","result":"ok"}\n');
    write(dir, "manifest.json", '{"secretDetection":true}\n');

    expect(yield* scanFiles(dir, createSecretScanner())).toEqual([]);
  });

  it("reports the file a credential was found in", function* () {
    const dir = makeTmpDir();
    yield* ensure(() => rm(dir));

    write(dir, "journal.jsonl", '{"type":"close"}\n');
    write(dir, "artifacts/report.md", `token: ${CANARY}\n`);

    const findings = yield* scanFiles(dir, createSecretScanner());

    expect(findings).toHaveLength(1);
    expect(findings[0]!.subject).toBe("content");
    // The path is root-relative: the staging directory is an artifact of the
    // harness and has nothing to do with what Git would store.
    expect(findings[0]).toMatchObject({ path: "artifacts/report.md" });
    expect(JSON.stringify(findings)).not.toContain(CANARY);
    expect(JSON.stringify(findings)).not.toContain(dir);
  });

  it("collects every offending regular file rather than stopping at the first", function* () {
    const dir = makeTmpDir();
    yield* ensure(() => rm(dir));

    write(dir, "one.txt", `a: ${CANARY}\n`);
    write(dir, "nested/two.txt", `b: npm_${A.slice(0, 36)}\n`);
    write(dir, "clean.txt", "nothing here\n");

    const findings = yield* scanFiles(dir, createSecretScanner());

    expect(findings).toHaveLength(2);
    expect(new Set(findings.map((finding) => finding.subject))).toEqual(new Set(["content"]));
  });
});

describe("the trust boundary", () => {
  it("reads the real file even when every reachable Fs API is blinded", function* () {
    const dir = makeTmpDir();
    yield* ensure(() => rm(dir));
    write(dir, "leak.txt", `token: ${CANARY}\n`);

    yield* useHostileFilesystem();

    // Both APIs a document can reach are lying, which is what a compromised
    // or sandboxed document would arrange.
    expect(yield* runtimeReadTextFile(path.join(dir, "leak.txt"))).toBe(BLINDED);
    expect(yield* fsReadTextFile(path.join(dir, "leak.txt"))).toBe(BLINDED);

    // The trusted scan goes to node:fs directly, so it still sees the file.
    const findings = yield* scanFiles(dir, createSecretScanner());

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ subject: "content", path: "leak.txt" });
    expect(JSON.stringify(findings)).not.toContain(CANARY);
  });
});

describe("paths are scanned before content", () => {
  it("rejects a credential-bearing filename whose contents are clean", function* () {
    const dir = makeTmpDir();
    yield* ensure(() => rm(dir));

    write(dir, `${CANARY}.txt`, "this file's contents are perfectly ordinary\n");

    const findings = yield* scanFiles(dir, createSecretScanner());

    expect(findings).toHaveLength(1);
    expect(findings[0]!.subject).toBe("path");
  });

  it("keeps the offending path out of the finding entirely", function* () {
    const dir = makeTmpDir();
    yield* ensure(() => rm(dir));

    write(dir, `${CANARY}.txt`, "ordinary\n");

    const findings = yield* scanFiles(dir, createSecretScanner());
    const serialized = JSON.stringify(findings);

    // Not the token, not the filename, not the staging directory, and no
    // recognizable fragment of any of them.
    expect(serialized).not.toContain(CANARY);
    expect(serialized).not.toContain(`${CANARY}.txt`);
    expect(serialized).not.toContain(A.slice(0, 36));
    expect(serialized).not.toContain(A.slice(0, 12));
    expect(serialized).not.toContain(dir);
    expect(serialized).not.toContain(os.tmpdir());

    // The type makes this unrepresentable; the test pins it anyway, because
    // the whole point of the variant is that no path field exists to fill.
    expect(Object.hasOwn(findings[0]!, "path")).toBe(false);
  });

  it("scans nested directory components, not just filenames", function* () {
    const dir = makeTmpDir();
    yield* ensure(() => rm(dir));

    write(dir, path.join(CANARY, "report.md"), "ordinary contents\n");

    const findings = yield* scanFiles(dir, createSecretScanner());

    expect(findings.length).toBeGreaterThan(0);
    expect(findings.every((finding) => finding.subject === "path")).toBe(true);
    expect(JSON.stringify(findings)).not.toContain(CANARY);
  });

  it("keeps a clean root-relative path on an ordinary content finding", function* () {
    const dir = makeTmpDir();
    yield* ensure(() => rm(dir));

    write(dir, "artifacts/nested/report.md", `token: ${CANARY}\n`);

    const findings = yield* scanFiles(dir, createSecretScanner());

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      subject: "content",
      path: "artifacts/nested/report.md",
    });
  });
});

describe("symbolic links", () => {
  it("refuses a candidate containing a link instead of following it", function* () {
    const outside = makeTmpDir();
    const dir = makeTmpDir();
    yield* ensure(() => rm(outside));
    yield* ensure(() => rm(dir));

    write(outside, "clean.txt", "entirely ordinary content\n");
    fs.symlinkSync(path.join(outside, "clean.txt"), path.join(dir, "link.txt"));

    let failure: Error | undefined;
    try {
      yield* scanFiles(dir, createSecretScanner());
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
    }

    // Rejected even though the target is clean: what a link points at says
    // nothing about what Git would store.
    expect(failure).toBeInstanceOf(CandidateRejectedError);
    expect(failure?.cause).toBeUndefined();
  });

  it("never puts the link target in the error", function* () {
    const outside = makeTmpDir();
    const dir = makeTmpDir();
    yield* ensure(() => rm(outside));
    yield* ensure(() => rm(dir));

    // The target path itself carries a credential, which is the case where a
    // dereferencing scanner would leak one through its own diagnostic.
    write(outside, `${CANARY}.txt`, "ordinary\n");
    fs.symlinkSync(path.join(outside, `${CANARY}.txt`), path.join(dir, "link.txt"));

    let failure: Error | undefined;
    try {
      yield* scanFiles(dir, createSecretScanner());
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
    }

    const rendered = `${failure?.message}${failure?.stack ?? ""}${JSON.stringify(failure)}`;
    expect(rendered).not.toContain(CANARY);
    expect(rendered).not.toContain(A.slice(0, 12));
    expect(rendered).not.toContain(outside);
    expect(rendered).not.toContain("link.txt");
  });
});

/** Teardown reaches node:fs directly so a blinded API cannot strand a temp dir. */
// deno-lint-ignore require-yield
function* rm(dir: string): Operation<void> {
  fs.rmSync(dir, { recursive: true, force: true });
}
