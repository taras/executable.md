import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { all, ensure, scoped, spawn, suspend, until } from "effection";
import type { Operation } from "effection";
import { readdir, readTextFile, rm, writeTextFile } from "@effectionx/fs";
import fs from "node:fs";
import { writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { FileWrites, replaceThroughStaging } from "../lib/staged-write.ts";
import type { WriteFile } from "../lib/staged-write.ts";

function* target(contents: string): Operation<URL> {
  // @effectionx/fs has no mkdtemp.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "staged-write-"));
  yield* ensure(() => rm(base, { recursive: true, force: true }));

  const file = new URL("package.json", pathToFileURL(`${base}/`));
  yield* writeTextFile(file, contents);
  return file;
}

function* directoryOf(file: URL): Operation<string[]> {
  return (yield* readdir(new URL(".", file))).sort();
}

interface Gate {
  promise: Promise<void>;
  open(): void;
}

/** A promise the test opens by hand, so a write can be started and left unsettled. */
function gate(): Gate {
  let open = (): void => {};
  const promise = new Promise<void>((resolve) => {
    open = () => resolve();
  });
  return { promise, open };
}

describe("replaceThroughStaging", () => {
  it("replaces the file and leaves no staging behind", function* () {
    const file = yield* target("before");

    yield* replaceThroughStaging(file, "after");

    expect(yield* readTextFile(file)).toEqual("after");
    expect(yield* directoryOf(file)).toEqual(["package.json"]);
  });

  /**
   * Preparation is not serialized by anything: two worktrees, or two terminals,
   * can normalize the same manifest at once. A fixed staging name would have
   * them writing and deleting one another's file, which reproduced as `ENOENT`
   * during rename.
   */
  it("survives many concurrent replacements of the same file", function* () {
    const file = yield* target("before");

    yield* all(
      Array.from({ length: 32 }, (_, index) => replaceThroughStaging(file, `after ${index}`)),
    );

    expect(yield* readTextFile(file)).toContain("after ");
    expect(yield* directoryOf(file)).toEqual(["package.json"]);
  });

  /**
   * Halting stops Effection observing the staging write; it does not stop the
   * write. Cleanup must wait for it before removing the staged file, or the
   * write lands after the removal and the file stays on disk forever.
   */
  it("removes its own staging when halted before the write settles", function* () {
    const file = yield* target("before");
    const order: string[] = [];
    const started = gate();
    const held = gate();

    const writes: WriteFile = (staged, contents) => {
      order.push("write:start");
      started.open();
      return held.promise
        .then(() => writeFile(staged, contents))
        .then(() => {
          order.push("write:settle");
        });
    };

    yield* FileWrites.with(writes, function* () {
      const task = yield* spawn(function* () {
        yield* scoped(function* () {
          yield* replaceThroughStaging(file, "after");
          yield* suspend();
        });
      });

      yield* until(started.promise);
      const halting = yield* spawn(() => task.halt());
      held.open();
      yield* halting;
    });

    expect(order).toEqual(["write:start", "write:settle"]);
    expect(yield* directoryOf(file)).toEqual(["package.json"]);
    expect(yield* readTextFile(file)).toEqual("before");
  });

  /**
   * The unique name and the waiting cleanup have to hold together: a cancelled
   * invocation must remove its own staging and nothing else, while a
   * concurrent one completes untouched.
   */
  it("leaves a concurrent replacement intact when one is cancelled", function* () {
    const file = yield* target("before");
    const held = gate();
    const cancelledStarted = gate();

    const writes: WriteFile = (staged, contents) => {
      if (contents === "cancelled") {
        cancelledStarted.open();
        return held.promise.then(() => writeFile(staged, contents));
      }
      return writeFile(staged, contents);
    };

    yield* FileWrites.with(writes, function* () {
      const cancelled = yield* spawn(function* () {
        yield* scoped(function* () {
          yield* replaceThroughStaging(file, "cancelled");
          yield* suspend();
        });
      });

      yield* until(cancelledStarted.promise);
      yield* replaceThroughStaging(file, "survivor");

      const halting = yield* spawn(() => cancelled.halt());
      held.open();
      yield* halting;
    });

    expect(yield* readTextFile(file)).toEqual("survivor");
    expect(yield* directoryOf(file)).toEqual(["package.json"]);
  });
});
