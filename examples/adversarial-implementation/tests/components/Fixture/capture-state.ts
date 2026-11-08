import process from "node:process";
import { createContext, ensure, until } from "effection";
import type { Operation } from "effection";
import { ensureDir, lstat, readdir, writeTextFile } from "@effectionx/fs";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";

export const sourcePath =
  "examples/adversarial-implementation/tests/components/Fixture/Fallback.md";
export const sourceHash = "79f4093788f45f0c4fb9ddc3023d17966ae0c662007ab240507bc812d6bf7c0f";
export const deliveryNames = new Set([
  "called.json",
  "requirements.json",
  "feedback.json",
  "status.json",
  "selection.json",
  "assignment.json",
  "transition.json",
  "execution.json",
  "outcome.json",
  "raw.txt",
  "receipt.json",
  "hold.json",
  "disposition.json",
  "closeout.json",
  "closeout.md",
]);
export const repositoryNames = [
  "first.out",
  "first.err",
  "second.out",
  "second.err",
  "status.out",
  "status.err",
  "closeout.out",
  "closeout.err",
  "reconcile.out",
  "reconcile.err",
  "review.out",
  "review.err",
  "interrupt.out",
  "interrupt.err",
  "interrupt-input.json",
  "remote.json",
  "input.json",
];
export interface Capture {
  scenario: string;
  caseId: string;
  fixture: { root: string; repository: string; delivery: string };
  write(record: Record<string, unknown>): Operation<void>;
  snapshot(reason: string): Operation<void>;
  overlap(value: unknown): Operation<void>;
  failure(): string | undefined;
}
export const captureCase = createContext<Capture>("@executablemd/fixture/fallback-capture");

export function tagged(value: unknown): unknown {
  if (value === undefined) {
    return { type: "undefined" };
  }
  return { type: "json", value };
}

export function* ownCapture(
  destination: string,
  scenario: string,
  fixture: Capture["fixture"],
): Operation<Capture> {
  const caseId = crypto.randomUUID();
  const directory = join(destination, "fallback-capture", "fallback", "cases", caseId);
  yield* ensureDir(directory);
  let sequence = 0;
  let captureFailure: string | undefined;
  const copied = new Set<string>();
  function* write(record: Record<string, unknown>): Operation<void> {
    const index = ++sequence;
    const recordId = crypto.randomUUID();
    const path = join(directory, `${String(index).padStart(6, "0")}-${recordId}.json`);
    try {
      yield* writeTextFile(
        path,
        JSON.stringify(
          {
            ...record,
            recordId,
            scenario,
            fixture,
            timestamp: new Date().toISOString(),
            producer: { caseId, sequence: index, pid: process.pid },
          },
          (_key, value) => (value === undefined ? { type: "undefined" } : value),
          2,
        ),
      );
    } catch (error) {
      captureFailure = String(error);
      // A capture error cannot replace the failure being observed.
      try {
        yield* writeTextFile(
          join(directory, "capture-error.json"),
          JSON.stringify({ path, error: captureFailure, incomplete: true }),
        );
      } catch {
        console.error("Fallback capture write failed", path, captureFailure);
      }
    }
  }
  function* copy(path: string): Operation<unknown> {
    try {
      const info = yield* lstat(path);
      if (!info.isFile()) {
        return { path, state: "skipped", reason: "not a regular file" };
      }
      const bytes = yield* until(readFile(path));
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      if (!copied.has(sha256)) {
        yield* ensureDir(join(directory, "objects"));
        yield* until(writeFile(join(directory, "objects", sha256), bytes));
        copied.add(sha256);
      }
      return { path, state: "present", sha256, bytes: bytes.length };
    } catch (error) {
      const missing =
        typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
      return { path, state: missing ? "absent" : "incomplete", reason: String(error) };
    }
  }
  function* tree(directory: string, sessions = false): Operation<unknown[]> {
    try {
      const info = yield* lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink()) {
        return [{ path: directory, state: "skipped", reason: "not a regular directory" }];
      }
      const result: unknown[] = [];
      const names = (yield* readdir(directory)).sort();
      for (const name of names) {
        const path = join(directory, name);
        const info = yield* lstat(path);
        if (info.isSymbolicLink()) {
          result.push({ path, state: "skipped", reason: "symbolic link" });
        } else if (
          info.isDirectory() &&
          (name === "sessions" || /^review-[a-f0-9]{40}$/.test(name) || name === "replacement")
        ) {
          result.push(...(yield* tree(path, name === "sessions")));
        } else if (deliveryNames.has(name) || (sessions && name.endsWith(".json"))) {
          result.push(yield* copy(path));
        }
      }
      for (const name of deliveryNames) {
        if (!names.includes(name)) {
          result.push({ path: join(directory, name), state: "absent" });
        }
      }
      return result;
    } catch (error) {
      return [{ path: directory, state: "incomplete", reason: String(error) }];
    }
  }
  function* snapshot(reason: string): Operation<void> {
    try {
      const files = yield* tree(fixture.delivery);
      files.push(yield* copy(join(fixture.root, "elicitations.json")));
      for (const name of repositoryNames) {
        files.push(yield* copy(join(fixture.repository, name)));
      }
      yield* write({ schema: "fallback-snapshot.v1", reason, files, captureFailure });
    } catch (error) {
      yield* write({
        schema: "fallback-snapshot.v1",
        reason,
        state: "incomplete",
        error: String(error),
      });
    }
  }
  const capture: Capture = {
    scenario,
    caseId,
    fixture,
    write,
    snapshot,
    failure: () => captureFailure,
    *overlap(value) {
      try {
        yield* writeTextFile(join(directory, "overlap.json"), JSON.stringify(value));
        for (const name of repositoryNames.slice(0, 4)) {
          yield* write({
            schema: "fallback-overlap-file.v1",
            file: yield* copy(join(fixture.repository, name)),
          });
        }
      } catch (error) {
        yield* write({ schema: "fallback-overlap-error.v1", error: String(error) });
      }
    },
  };
  yield* ensure(function* () {
    yield* snapshot("case-cleanup-before-tempdir-deletion");
    yield* write({ schema: "fallback-case-close.v1", captureFailure });
  });
  yield* write({
    schema: "fallback-case-start.v1",
    source: { path: sourcePath, sha256: sourceHash },
  });
  return capture;
}
