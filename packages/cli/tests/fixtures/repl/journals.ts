/**
 * A journal of entries that really ran.
 *
 * The REPL reads a model, and a model is what a run leaves behind: these
 * entries are executed through the same installed host a submission goes
 * through, so what the rows below read is a journal the current runtime wrote.
 * A handwritten event array would keep passing on the day a record's shape
 * changed.
 */

import { collect, inlineSource, useTempFileCompiler } from "@executablemd/core";
import { executeInstalled } from "@executablemd/core/host";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { DurableEvent } from "@executablemd/durable-streams";
import type { Operation } from "effection";

import { EntrySegmentStream } from "../../../src/repl/entries.ts";
import { entryInitialBindings, projectRepl } from "../../../src/repl/model.ts";
import type { ReplModel } from "../../../src/repl/model.ts";

/** One projected model, or the failure the projector ended in. */
export function projected(events: readonly DurableEvent[]): ReplModel {
  const result = projectRepl(events);
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

/**
 * Run each of these sources as its own entry, in order, and project the journal.
 *
 * Each entry starts from the bindings the entries before it left, which is what
 * the program does: an entry that began from nothing would be a different run
 * from the one a person submits.
 */
export function* journalModel(sources: readonly string[]): Operation<ReplModel> {
  yield* useTempFileCompiler();
  const physical = new InMemoryStream();
  for (const source of sources) {
    const settled = yield* physical.readAll();
    const execution = yield* executeInstalled(
      { ...inlineSource(source), stream: new EntrySegmentStream(physical) },
      [],
      {
        initialBindings: settled.length === 0 ? {} : entryInitialBindings(projected(settled)),
      },
    );
    yield* collect(execution);
  }
  return projected(yield* physical.readAll());
}

/** The journal a command opens on: nothing recorded and nothing retained. */
export function* emptyModel(): Operation<ReplModel> {
  yield* useTempFileCompiler();
  return projected([]);
}
