/**
 * Tier CK — what `<Elicit>` becomes under a workflow run.
 *
 * The claim is a substitution, so every case here is about which of two
 * registrations answered, and the discriminator is what each leaves behind:
 * core's `<Elicit>` wraps the asking in a durable `elicit` record, and the
 * workflow's does not. A suite that only checked "the answer bound" could not
 * tell them apart, and the whole point of the substitution is the record that
 * is missing — a durable wait cannot sit inside one.
 *
 * The attachment is the production `withWorkflowWorkspace`, not a hand-built
 * install, so what these cases prove is that the host wires it rather than that
 * the test does.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { call, race, scoped } from "effection";
import type { Operation } from "effection";
import { collect, execute, inlineSource } from "@executablemd/core";
import type { DurableEvent } from "@executablemd/durable-streams";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { WorkflowRunDatabase } from "../mod.ts";
import { runWorkflowDocument } from "./support/composition.ts";
import { useStorageRoot, withBegunRun } from "./support/storage.ts";
import { createSuspensionController } from "../src/deno/suspension.ts";
import type { SuspensionNotice } from "../src/deno/suspension.ts";
import { SUSPENSION_REQUEST } from "../src/suspension/suspend.ts";

/** The durable record core's `<Elicit>` writes and the workflow's must not. */
const ELICIT = "elicit";

const SCHEMA = `{"type":"object","properties":{"proceed":{"type":"boolean"}},"required":["proceed"]}`;

/** One `<Elicit>`, answered in the document so nobody is asked. */
const ANSWERED = `<Answers>
<Answer value={{proceed: true}} />

<Elicit schema={${SCHEMA}} as="decision">
Proceed with the change?
</Elicit>
</Answers>

decision: {decision.proceed}
`;

/** The same question with nothing to answer it. */
const UNANSWERED = `<Elicit schema={${SCHEMA}} as="decision">
Proceed with the change?
</Elicit>

decision: {decision.proceed}
`;

/** A question the document never reaches. */
const UNREACHED = `<If condition={false}>
<Elicit schema={${SCHEMA}} as="decision">
Proceed with the change?
</Elicit>
</If>

nothing was asked
`;

function withRun<T>(body: (database: WorkflowRunDatabase) => Operation<T>): Operation<T> {
  return scoped(function* () {
    const root = yield* useStorageRoot();
    return yield* withBegunRun(root, (run) => body(run.database), "checkpoint");
  });
}

/** Every durable yield this run retained, as `type` alone. */
function* yields(database: WorkflowRunDatabase): Operation<string[]> {
  const events: DurableEvent[] = yield* database.journal.readAll();
  return events
    .filter((event) => event.type === "yield")
    .map((event) => (event as unknown as Described).description.type as string);
}

/** One retained yield's description, as the journal holds it. */
type Described = { description: Record<string, unknown> };

/** The retained suspension requests, in order. */
function* requests(database: WorkflowRunDatabase): Operation<Described[]> {
  const events: DurableEvent[] = yield* database.journal.readAll();
  return events
    .filter((event) => event.type === "yield")
    .map((event) => event as unknown as Described)
    .filter((event) => event.description.type === SUSPENSION_REQUEST);
}

/**
 * Run a document that parks on an unentered wait, and stop when it does.
 *
 * The controller stands in for the executor: it observes the reported wait, and
 * `race` halts the execution the way the real owner does. Halting rather than
 * waiting keeps a suite finite while still exercising an operation that never
 * returns.
 */
function suspending(
  database: WorkflowRunDatabase,
  source: string,
): Operation<SuspensionNotice | undefined> {
  return scoped(function* () {
    const suspension = createSuspensionController({ database });
    let notice: SuspensionNotice | undefined;
    yield* race([
      call(function* (): Operation<void> {
        try {
          yield* suspension.own(runWorkflowDocument(database, source));
        } catch {
          // A halted execution is how this suite ends; the journal is the claim.
        }
      }),
      call(function* (): Operation<void> {
        notice = yield* suspension.notice;
      }),
    ]);
    return notice;
  });
}

describe("Tier CK — the durable checkpoint", () => {
  it("CK2: the workflow's <Elicit> answers without writing a durable elicit record", function* () {
    yield* withRun(function* (database) {
      const output = yield* runWorkflowDocument(database, ANSWERED);

      expect(String(output)).toContain("decision: true");
      expect(yield* yields(database)).not.toContain(ELICIT);
    });
  });

  it("CK2b: an unanswered question publishes one suspension request and no elicit record", function* () {
    yield* withRun(function* (database) {
      const notice = yield* suspending(database, UNANSWERED);

      expect(notice).toBeDefined();
      const published = yield* requests(database);
      expect(published).toHaveLength(1);

      // What the person was asked, and what an answer must satisfy, are the
      // request — not something a later execution reconstructs.
      const description = published[0].description;
      const request = description.request as Record<string, unknown>;
      expect(request.kind).toBe("elicitation");
      expect(String(request.message)).toContain("Proceed with the change?");
      expect(description.responseSchema).toMatchObject({ type: "object" });

      expect(yield* yields(database)).not.toContain(ELICIT);
    });
  });

  it("CK6: an <Answers> region answers first, so nothing suspends", function* () {
    yield* withRun(function* (database) {
      yield* runWorkflowDocument(database, ANSWERED);

      expect(yield* requests(database)).toHaveLength(0);
    });
  });

  // A guard rather than a discriminator: it passes with either registration,
  // because both publish nothing for an element that never expands. What it
  // catches is a future install that published a request eagerly — at
  // attachment or at expansion — instead of when the question is asked.
  it("CK8: a question the document never reaches publishes nothing", function* () {
    yield* withRun(function* (database) {
      const output = yield* runWorkflowDocument(database, UNREACHED);

      expect(String(output)).toContain("nothing was asked");
      expect(yield* requests(database)).toHaveLength(0);
      expect(yield* yields(database)).not.toContain(ELICIT);
    });
  });

  it("CK7: ordinary execution is unchanged — core's <Elicit> still records", function* () {
    const stream = new InMemoryStream();
    const output = yield* collect(yield* execute({ ...inlineSource(ANSWERED), stream }));

    expect(String(output)).toContain("decision: true");

    const events: DurableEvent[] = yield* stream.readAll();
    const recorded = events
      .filter((event) => event.type === "yield")
      .map((event) => event as unknown as Described)
      .filter((event) => event.description.type === ELICIT);
    expect(recorded).toHaveLength(1);
  });
});
