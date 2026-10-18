/**
 * Tier ROB5, the half that needs a runtime which operates repositories.
 *
 * Three cases, kept apart from `retained-repository-observations.test.ts`
 * because each one needs the native side of a REPL entry's repository host.
 * Cancelling a finished read's append unwinds a real Deno-backed Files
 * provider; holding a read while the same entry mutates needs a real `git`
 * child to reach; and another holder's mutation lease is a kernel-released
 * exclusive advisory lock taken through the Deno runtime. Node and Bun expose
 * no equivalent of the lock, install no native provider for the mutation to
 * reach, and unwind the Files provider differently, so there these three fail
 * on the host rather than on what they assert.
 *
 * The record format, its admission, every refusal and the rest of
 * cancellation and persistence stay portable and stay in
 * `retained-repository-observations.test.ts` — ROB1 through ROB4, and ROB5's
 * interrupted-child and fatal-append cases, all run on every runtime.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { race, scoped, sleep, spawn, withResolvers } from "effection";
import type { Operation } from "effection";
import { exists } from "@effectionx/fs";
import { join } from "node:path";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { DurableEvent, DurableStream, Json } from "@executablemd/durable-streams";
import { registerComponents } from "@executablemd/core";
import {
  parseReplObservationRecord,
  REPL_REPOSITORY_OBSERVATION,
} from "../src/retained-repository/observation-records.ts";
import { useCommonDirectoryLease } from "../src/deno/retained-repository/leases.ts";
import { useObservationFixture, writeFixtureFile } from "./support/observations.ts";
import {
  entryCounters,
  entrySubcommands,
  repoint,
  runEntry,
  useEntryPlace,
} from "./support/repl-observations.ts";
import type { EntryCounters } from "./support/repl-observations.ts";
import { commonDirectoryOf } from "./support/run-composition.ts";

function collecting(
  events: DurableEvent[],
  before?: (event: DurableEvent) => Operation<void>,
): DurableStream {
  return {
    *readAll(): Operation<DurableEvent[]> {
      return [...events];
    },
    *append(event: DurableEvent): Operation<void> {
      if (before !== undefined) {
        yield* before(event);
      }
      events.push(event);
    },
  };
}

/** The native reads one entry performed, which is what a read's `git` is. */
const READ_SUBCOMMANDS: readonly string[] = ["ls-files", "diff", "cat-file", "ls-tree"];

function reads(counted: EntryCounters): string[] {
  // By exact argument rather than by "the first word that is not an option":
  // every read states `-c <setting>` pre-command options, and a setting's value
  // is not an option either.
  return counted.commands
    .map((args) => args.find((arg) => READ_SUBCOMMANDS.includes(arg)))
    .filter((name): name is string => name !== undefined);
}

function observations(events: readonly DurableEvent[]) {
  return events
    .filter(
      (event) => event.type === "yield" && event.description.type === REPL_REPOSITORY_OBSERVATION,
    )
    .map((event) => {
      if (event.type !== "yield" || event.result.status !== "ok") {
        throw new Error("an observation record is not a successful envelope");
      }
      const parsed = parseReplObservationRecord(event.result.value);
      if (parsed === undefined) {
        throw new Error("an observation record did not parse");
      }
      return { name: event.description.name, record: parsed };
    });
}

describe("ROB5 — cancellation, persistence and ownership, on a native host", () => {
  it("leaves no completion when a finished read's append is cancelled", function* () {
    const fixture = yield* useObservationFixture();
    const place = yield* useEntryPlace(fixture);
    const counted = entryCounters();
    yield* writeFixtureFile(fixture.root, "src/a.ts", "export const a = 13;\n");
    const events: DurableEvent[] = [];
    const reached = withResolvers<void>();
    const held = withResolvers<void>();

    // A barrier between the native work and its acknowledgement: the read has
    // happened, and the append has not.
    const barrier = collecting(events, function* (event) {
      if (event.type === "yield" && event.description.type === REPL_REPOSITORY_OBSERVATION) {
        reached.resolve();
        yield* held.operation;
      }
    });

    const source = [
      "<PrintErrors>",
      '<Git.Diff compare="unstaged" as="diff" />',
      "Diff: {diff.length}",
      "</PrintErrors>",
      '<File path="sentinel.md">sentinel</File>',
    ].join("\n");

    yield* scoped(function* () {
      const task = yield* spawn(() => runEntry(place, source, barrier, counted, {}));
      yield* reached.operation;
      yield* task.halt();
    });

    // The read ran, and nothing says it did.
    expect(reads(counted)).toContain("diff");
    expect(observations(events)).toEqual([]);
    expect(yield* exists(join(fixture.root, "sentinel.md"))).toBe(false);

    // So a continuation takes the live path, and gets today's answer.
    yield* writeFixtureFile(fixture.root, "src/a.ts", "export const a = 17;\n");
    const again = entryCounters();
    const continued = yield* runEntry(place, source, new InMemoryStream([...events]), again);
    expect(continued.refusal).toBe(undefined);
    expect(reads(again)).toContain("diff");
    const recorded = observations(continued.events);
    expect(recorded).toHaveLength(1);
    const outcome = recorded[0]?.record.outcome;
    expect(outcome?.ok === true && "text" in outcome.value ? outcome.value.text : "").toContain(
      "+export const a = 17;",
    );
  });

  it("keeps the same entry's mutation out of a held read, then lets it through", function* () {
    const fixture = yield* useObservationFixture();
    const place = yield* useEntryPlace(fixture);
    const counted = entryCounters();
    yield* writeFixtureFile(fixture.root, "src/a.ts", "export const a = 123;\n");

    const readHeld = withResolvers<void>();
    const releaseRead = withResolvers<void>();
    const mutationEntered = withResolvers<void>();
    let holding = false;
    let enteredWhileHeld = false;

    const settled = yield* scoped(function* () {
      const task = yield* spawn(() =>
        runEntry(
          place,
          [
            "<All>",
            '<Spawn><Git.Diff compare="unstaged" as="patch" /></Spawn>',
            '<Spawn><WaitsForTheRead /><Git.Add paths="src/a.ts" /></Spawn>',
            "</All>",
            "",
          ].join("\n"),
          new InMemoryStream(),
          counted,
          {
            *between(): Operation<void> {
              // The second branch starts its mutation only once the read is
              // genuinely held, so the race the regression needs is arranged
              // rather than hoped for.
              yield* registerComponents([
                {
                  name: "WaitsForTheRead",
                  origin: "test://waits-for-the-read",
                  props: { type: "object", properties: {}, additionalProperties: false },
                  *fn(): Operation<string> {
                    yield* readHeld.operation;
                    return "";
                  },
                },
              ]);
            },
            *barrier(invocation): Operation<void> {
              if (invocation.args.includes("add")) {
                if (holding) {
                  enteredWhileHeld = true;
                }
                mutationEntered.resolve();
                return;
              }
              if (invocation.args.includes("diff") && !holding) {
                holding = true;
                readHeld.resolve();
                // Long enough that a mutation on a queue of its own would have
                // reached the host by now, and short enough to end the case.
                yield* race([
                  mutationEntered.operation,
                  (function* (): Operation<void> {
                    yield* sleep(2000);
                  })(),
                ]);
                holding = false;
                releaseRead.resolve();
              }
            },
          },
        ),
      );
      yield* releaseRead.operation;
      // The read has finished its own turn; the mutation may now proceed.
      yield* race([
        mutationEntered.operation,
        (function* (): Operation<void> {
          yield* sleep(30_000);
          throw new Error("the mutation never reached native Git");
        })(),
      ]);
      return yield* task;
    });

    // Nothing of this entry's own Git entered while its read held the turn,
    // and the mutation did run once the read released it.
    expect(enteredWhileHeld).toBe(false);
    expect(settled.refusal).toBe(undefined);
    expect(reads(counted)).toContain("diff");
    expect(entrySubcommands(counted)).toContain("add");
  });

  it("answers while another holder has the checkout's mutation lease", function* () {
    const fixture = yield* useObservationFixture();
    const place = yield* useEntryPlace(fixture);
    const common = commonDirectoryOf({ root: fixture.root, home: fixture.home, run: fixture.run });
    const counted = entryCounters();
    yield* writeFixtureFile(fixture.root, "src/a.ts", "export const a = 23;\n");

    const source = [
      '<Git.Changes compare="unstaged" as="changes" />',
      "",
      "<Json value={changes} />",
      "",
    ].join("\n");

    // Held for the whole of both runs by somebody else. A read that took one
    // would be refused by the operating system on the second descriptor.
    const live = yield* scoped(function* () {
      yield* useCommonDirectoryLease(common);
      return yield* runEntry(place, source, new InMemoryStream(), counted);
    });
    expect(live.refusal).toBe(undefined);
    expect(reads(counted)).toContain("diff");

    // And a completed replay takes neither the lease nor anything else: it
    // answers with the lease still held and the checkout gone.
    const replayed = entryCounters();
    const again = yield* scoped(function* () {
      yield* useCommonDirectoryLease(common);
      yield* repoint(place, place.root);
      return yield* runEntry(place, source, new InMemoryStream([...live.events]), replayed);
    });
    expect(again.output).toBe(live.output);
    expect(entrySubcommands(replayed)).toEqual([]);
  });
});
