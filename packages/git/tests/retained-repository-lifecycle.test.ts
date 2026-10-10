/**
 * R9 — what one entry holds while it works, and what it lets go of.
 *
 * Two mutations over one shared Git directory would each predict a transition
 * from a state the other was about to leave, so the lane serializes them. A
 * managed slot another process is working in is refused rather than waited for.
 * And everything an entry took has to be released when the entry ends, however
 * it ends — a lane a cancelled holder kept shut would deadlock the next
 * operation, and a lease it kept would lock out the next entry.
 *
 * The lane is exercised directly as well as through a document. Driving it
 * directly is the only way to put two holders in flight at once: one document
 * expands its elements one at a time, which is exactly the thing the lane makes
 * safe, so a document alone cannot show that it is doing anything.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { all, ensure, resource, scoped, sleep, spawn, until } from "effection";
import type { Operation } from "effection";
import { ensureDir, rm, writeTextFile } from "@effectionx/fs";
import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { API, hostFilesHandler } from "@executablemd/runtime";
import type { FilesHandler } from "@executablemd/runtime";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { DurableEvent } from "@executablemd/durable-streams";
import { collect } from "@executablemd/core";
import { executeInstalled } from "@executablemd/core/host";
import { denoRepositoryHost } from "../src/deno/composition/host.ts";
import { gitSession } from "../src/deno/composition/git.ts";
import { useLeases } from "../src/deno/run-composition/leases.ts";
import { ManagedCheckoutError } from "../src/deno/run-composition/errors.ts";
import { retainedLanes } from "../src/deno/retained-repository/local.ts";
import { useRetainedRepositoryEntry } from "../src/deno/retained-repository/provider.ts";
import {
  RETAINED_REPOSITORY_INTENT,
  parseRetainedRepositoryIntent,
} from "../src/retained-repository/records.ts";

interface Fixture {
  readonly root: string;
  readonly checkout: string;
}

function useFixture(): Operation<Fixture> {
  return resource(function* (provide) {
    const root = yield* until(realpath(yield* until(mkdtemp(join(tmpdir(), "retained-life-")))));
    yield* ensure(() => rm(root, { recursive: true, force: true }));
    const checkout = join(root, "checkout");
    yield* ensureDir(join(root, "managed"));
    const git = gitSession(denoRepositoryHost(), root);
    yield* git.run(["init", "-b", "main", checkout], root);
    yield* git.run(["config", "user.name", "Retained"], checkout);
    yield* git.run(["config", "user.email", "retained@example.com"], checkout);
    yield* until(writeFile(join(checkout, "seed.md"), "seed\n"));
    yield* git.run(["add", "seed.md"], checkout);
    yield* git.run(["commit", "-m", "seed"], checkout);
    yield* provide({ root, checkout });
  });
}

function* useEntryFiles(fixture: Fixture, leaf: FilesHandler): Operation<void> {
  yield* API.Env.around(
    {
      // deno-lint-ignore require-yield
      *cwd() {
        return fixture.checkout;
      },
    },
    { at: "min" },
  );
  yield* API.Files.around({
    checkFilePath: ([input]) => leaf.checkFilePath(input),
    readTextFile: ([input]) => leaf.readTextFile(input),
    globFiles: ([input]) => leaf.globFiles(input),
    temporaryDirectory: () => leaf.temporaryDirectory(),
    *ensureDirectory([input], next) {
      return yield* next(input);
    },
    *writeTextFile([input], next) {
      return yield* next(input);
    },
    *deleteFile([input], next) {
      return yield* next(input);
    },
  });
}

function run(
  fixture: Fixture,
  source: string,
  stream: InMemoryStream,
  entryKey = "0001",
): Operation<readonly DurableEvent[]> {
  return scoped(function* () {
    const path = join(fixture.root, "entry.md");
    yield* writeTextFile(path, source);
    const leaf = hostFilesHandler();
    yield* useEntryFiles(fixture, leaf);
    const entry = yield* useRetainedRepositoryEntry({
      executionId: "execution-1",
      entryKey,
      source: "entry.md",
      cwd: fixture.checkout,
      managedRoot: join(fixture.root, "managed"),
      host: denoRepositoryHost(),
      files: leaf,
    });
    yield* collect(
      yield* executeInstalled({ path, stream, includes: [fixture.root] }, [entry.installation]),
    );
    return yield* stream.readAll();
  });
}

describe("retained repository: what an entry holds and releases", () => {
  it("R9: one shared Git directory is serialized and another runs beside it", function* () {
    const lanes = retainedLanes();
    const order: string[] = [];

    function visit(lane: string, name: string, pause: number): Operation<void> {
      return scoped(function* () {
        yield* lanes.enter(lane);
        order.push(`${name}:in`);
        yield* sleep(pause);
        order.push(`${name}:out`);
      });
    }

    yield* scoped(function* () {
      const first = yield* spawn(() => visit("/a/.git", "a1", 40));
      yield* sleep(5);
      const second = yield* spawn(() => visit("/a/.git", "a2", 5));
      const other = yield* spawn(() => visit("/b/.git", "b1", 5));
      yield* all([first, second, other]);
    });

    // The two in one lane never overlap: the second begins after the first ends.
    expect(order.indexOf("a1:out")).toBeLessThan(order.indexOf("a2:in"));
    // The other shared directory did not wait for either of them.
    expect(order.indexOf("b1:out")).toBeLessThan(order.indexOf("a1:out"));
  });

  it("R9: a cancelled holder releases its lane", function* () {
    const lanes = retainedLanes();
    const seen: string[] = [];
    yield* scoped(function* () {
      const held = yield* spawn(() =>
        scoped(function* () {
          yield* lanes.enter("/a/.git");
          seen.push("held");
          yield* sleep(10_000);
        }),
      );
      yield* sleep(5);
      yield* held.halt();
      // The lane is free, so this one takes it rather than waiting forever.
      yield* scoped(function* () {
        yield* lanes.enter("/a/.git");
        seen.push("after");
      });
    });
    expect(seen).toEqual(["held", "after"]);
  });

  it("R9: one entry's mutations advance one lane in order", function* () {
    const fixture = yield* useFixture();
    const events = yield* run(
      fixture,
      '<File path="one.md">one\n</File>\n\n<File path="two.md">two\n</File>\n\n' +
        '<Git.Add paths="one.md" />\n',
      new InMemoryStream(),
    );

    const intents = recordsOf(events).map((record) => parseRetainedRepositoryIntent(record));
    const lane = intents[0]?.lane.common;
    expect(intents.every((record) => record?.lane.common === lane)).toBe(true);
    // Strictly increasing, which is what admission holds a history to.
    expect(intents.map((record) => record?.lane.position)).toEqual([0, 1, 2, 3]);
  });

  it("R9: a managed slot another holder has is refused, not waited for", function* () {
    const fixture = yield* useFixture();
    const root = join(fixture.root, "managed");
    const slot = join(root, "repositories", "held");
    let refusal: string | undefined;
    yield* scoped(function* () {
      const first = yield* useLeases(root);
      yield* first.hold("repository", slot, "the first holder");
      // A second holder in its own scope, which the first still has.
      yield* scoped(function* () {
        const second = yield* useLeases(root);
        try {
          yield* second.hold("repository", slot, "the second holder");
        } catch (error) {
          refusal = error instanceof ManagedCheckoutError ? error.reason : String(error);
        }
      });
    });
    expect(refusal).toBe("in-use");
  });

  it("R9: an entry releases its leases when it ends, so the next entry may hold them", function* () {
    const fixture = yield* useFixture();
    const root = join(fixture.root, "managed");
    const slot = join(root, "repositories", "released");

    yield* scoped(function* () {
      const leases = yield* useLeases(root);
      yield* leases.hold("repository", slot, "the first entry");
    });

    // The first entry has ended. Its lease went with it.
    let refusal: string | undefined;
    yield* scoped(function* () {
      const leases = yield* useLeases(root);
      try {
        yield* leases.hold("repository", slot, "the second entry");
      } catch (error) {
        refusal = error instanceof Error ? error.message : String(error);
      }
    });
    expect(refusal).toBeUndefined();
  });

  it("R9: a cancelled entry leaves no lane or lease behind for the next one", function* () {
    const fixture = yield* useFixture();
    const source = '<File path="one.md">one\n</File>\n';

    yield* scoped(function* () {
      const running = yield* spawn(() => run(fixture, source, new InMemoryStream()));
      yield* sleep(5);
      yield* running.halt();
    });

    // A second entry over its own journal works normally: nothing the cancelled
    // one took is still held.
    const events = yield* run(fixture, source, new InMemoryStream(), "0002");
    expect(recordsOf(events).length).toBeGreaterThan(0);
  });
});

function recordsOf(events: readonly DurableEvent[]) {
  const held = [];
  for (const event of events) {
    if (
      event.type === "yield" &&
      event.description.type === RETAINED_REPOSITORY_INTENT &&
      event.result.status === "ok"
    ) {
      held.push(event.result.value ?? null);
    }
  }
  return held;
}
