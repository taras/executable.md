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
import { all, ensure, resource, scoped, sleep, spawn, until, withResolvers } from "effection";
import type { Operation } from "effection";
import { ensureDir, rm, writeTextFile } from "@effectionx/fs";
import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { API, hostFilesHandler } from "@executablemd/runtime";
import type { FilesHandler } from "@executablemd/runtime";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { DurableEvent, Json } from "@executablemd/durable-streams";
import { collect } from "@executablemd/core";
import { executeInstalled } from "@executablemd/core/host";
import { denoRepositoryHost } from "../src/deno/composition/host.ts";
import { gitSession } from "../src/deno/composition/git.ts";
import { useLeases } from "../src/deno/run-composition/leases.ts";
import { ManagedCheckoutError } from "../src/deno/run-composition/errors.ts";
import { useRetainedRepositoryEntry } from "../src/deno/retained-repository/provider.ts";
import {
  REPL_REPOSITORY_RESULT,
  parseReplRepositoryResult,
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
  given?: FilesHandler,
  managedRoot?: string,
): Operation<readonly DurableEvent[]> {
  return scoped(function* () {
    const path = join(fixture.root, "entry.md");
    yield* writeTextFile(path, source);
    const leaf = given ?? hostFilesHandler();
    yield* useEntryFiles(fixture, leaf);
    const entry = yield* useRetainedRepositoryEntry({
      executionId: "execution-1",
      entryKey,
      source: "entry.md",
      cwd: fixture.checkout,
      managedRoot: managedRoot ?? join(fixture.root, "managed"),
      host: denoRepositoryHost(),
      files: leaf,
    });
    yield* collect(
      yield* executeInstalled({ path, stream, includes: [fixture.root] }, [entry.installation]),
    );
    return yield* stream.readAll();
  });
}

/** A Files provider that records the mutations it is actually asked to make. */
function counted(): { readonly handler: FilesHandler; readonly writes: string[] } {
  const host = hostFilesHandler();
  const writes: string[] = [];
  return {
    writes,
    handler: {
      ...host,
      *writeTextFile(input) {
        writes.push(input.path);
        return yield* host.writeTextFile(input);
      },
    },
  };
}

describe("retained repository: what an entry holds and releases", () => {
  it("R9: one entry's mutations are one record each, in the order it made them", function* () {
    const fixture = yield* useFixture();
    const events = yield* run(
      fixture,
      '<File path="one.md">one\n</File>\n\n<File path="two.md">two\n</File>\n\n' +
        '<Git.Add paths="one.md" />\n',
      new InMemoryStream(),
    );

    // One record per operation, in the order the entry performed them, and
    // nothing else: no intent before the effect, no completion after it, and no
    // lane position to order them by. The journal's own order is the order.
    const results = recordsOf(events).map((record) => parseReplRepositoryResult(record));
    expect(results.every((record) => record !== undefined)).toBe(true);
    expect(results.map((record) => record?.operation)).toEqual([
      "ambient",
      "file-write",
      "file-write",
      "add",
    ]);
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

  it("R9: a second entry cannot work in the shared directory the first one holds", function* () {
    const fixture = yield* useFixture();
    // The first entry is stopped inside its own native write, so it is still
    // holding everything a running entry holds when the second one starts.
    const entered = withResolvers<void>();
    const release = withResolvers<void>();
    const host = hostFilesHandler();
    const holding: FilesHandler = {
      ...host,
      *writeTextFile(input) {
        entered.resolve();
        yield* release.operation;
        return yield* host.writeTextFile(input);
      },
    };
    const second = counted();
    let refusal: string | undefined;
    yield* scoped(function* () {
      const first = yield* spawn(function* () {
        try {
          yield* run(
            fixture,
            '<File path="one.md">one\n</File>\n',
            new InMemoryStream(),
            "0001",
            holding,
          );
        } catch {
          // What this asserts is what the second entry was allowed to do.
        }
      });
      // Registered before the waiting starts, so the first entry is let go of
      // however this scope ends: halting a holder that is still suspended on a
      // release nobody resolved would leave the scope waiting on it.
      yield* ensure(() => {
        release.resolve();
      });
      yield* ensure(() => first.halt());
      yield* entered.operation;
      try {
        yield* run(
          fixture,
          '<File path="two.md">two\n</File>\n',
          new InMemoryStream(),
          "0002",
          second.handler,
        );
      } catch (error) {
        refusal = error instanceof Error ? error.message : String(error);
      }
    });

    // Two independent providers, one shared Git directory: the second refuses
    // before it writes anything. It is an ordinary refusal — the same word the
    // ordinary provider uses for a slot somebody else holds — so what proves it
    // is that the second entry performed no write at all.
    expect(second.writes).toEqual([]);
    expect(refusal ?? "").not.toContain("wrote");
  });

  it("R9: two entries under different host roots still share one Git directory", function* () {
    const fixture = yield* useFixture();
    // Two entries that place their managed checkouts in different places, in
    // the same ambient checkout. Where a host puts what it creates says
    // nothing about who else is moving the refs of the repository the person
    // is standing in.
    const elsewhere = join(fixture.root, "managed-elsewhere");
    yield* ensureDir(elsewhere);
    const entered = withResolvers<void>();
    const release = withResolvers<void>();
    const host = hostFilesHandler();
    const holding: FilesHandler = {
      ...host,
      *writeTextFile(input) {
        entered.resolve();
        yield* release.operation;
        return yield* host.writeTextFile(input);
      },
    };
    const second = counted();
    let refusal: string | undefined;
    yield* scoped(function* () {
      const first = yield* spawn(function* () {
        try {
          yield* run(
            fixture,
            '<File path="one.md">one\n</File>\n',
            new InMemoryStream(),
            "0001",
            holding,
          );
        } catch {
          // What this asserts is what the second entry was allowed to do.
        }
      });
      yield* ensure(() => {
        release.resolve();
      });
      yield* ensure(() => first.halt());
      yield* entered.operation;
      try {
        yield* run(
          fixture,
          '<File path="two.md">two\n</File>\n',
          new InMemoryStream(),
          "0002",
          second.handler,
          elsewhere,
        );
      } catch (error) {
        refusal = error instanceof Error ? error.message : String(error);
      }
    });
    // Where a host puts what it creates says nothing about who is moving the
    // refs of the repository the person is standing in: the second entry is
    // refused the same way, and writes nothing.
    expect(second.writes).toEqual([]);
    expect(refusal ?? "").not.toContain("wrote");
  });

  it("R9: the shared directory an entry held is free for the next entry", function* () {
    const fixture = yield* useFixture();
    // A whole entry, run and ended, through the real provider.
    yield* run(fixture, '<File path="one.md">one\n</File>\n', new InMemoryStream(), "0001");

    // The next entry works in the same checkout: what the first provider held
    // went with it, including the lease on the common directory, which is not
    // released by anything the document did.
    const next = counted();
    const events = yield* run(
      fixture,
      '<File path="two.md">two\n</File>\n',
      new InMemoryStream(),
      "0002",
      next.handler,
    );
    expect(next.writes).toEqual(["two.md"]);
    expect(recordsOf(events).length).toBeGreaterThan(0);
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
  const held: Json[] = [];
  for (const event of events) {
    if (
      event.type === "yield" &&
      event.description.type === REPL_REPOSITORY_RESULT &&
      event.result.status === "ok"
    ) {
      held.push(event.result.value ?? null);
    }
  }
  return held;
}
