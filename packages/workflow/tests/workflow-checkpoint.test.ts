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
 * the test does. What a suspended run then costs the executor — settlement,
 * released lock, delivery, resume — is Tier CKX's, against the real command.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { call, race, scoped } from "effection";
import type { Operation } from "effection";
import { DatabaseSync } from "node:sqlite";
import { collect, execute, inlineSource, isJsonObject } from "@executablemd/core";
import type { Json } from "@executablemd/core";
import type { DurableEvent, Yield } from "@executablemd/durable-streams";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { WorkflowRunDatabase } from "../mod.ts";
import { runWorkflowDocument } from "./support/composition.ts";
import { runPath, useStorageRoot, withBegunRun } from "./support/storage.ts";
import { createSuspensionController } from "../src/deno/suspension.ts";
import type { SuspensionNotice } from "../src/deno/suspension.ts";
import { SUSPENSION_REQUEST } from "../src/suspension/suspend.ts";

/** The durable record core's `<Elicit>` writes and the workflow's must not. */
const ELICIT = "elicit";

const RUN_ID = "checkpoint";

const DECISION_SCHEMA =
  `{"type":"object","properties":{"proceed":{"type":"boolean"},"response":{"type":"string"},` +
  `"rationale":{"type":"string"}},"required":["proceed","response","rationale"],` +
  `"additionalProperties":false}`;

const ASSESSMENT_SCHEMA =
  `{"type":"object","properties":{"requiresUser":{"type":"boolean"},"question":{"type":"string"}},` +
  `"required":["requiresUser","question"],"additionalProperties":false}`;

/** One `<Elicit>`, answered in the document so nobody is asked. */
const ANSWERED = `<Answers>
<Answer value={{proceed: true, response: "go", rationale: "because"}} />

<Elicit schema={${DECISION_SCHEMA}} as="decision">
Proceed with the change?
</Elicit>
</Answers>

decision: {decision.proceed}
`;

/** The same question with nothing to answer it. */
const UNANSWERED = `<Elicit schema={${DECISION_SCHEMA}} as="decision">
Proceed with the change?
</Elicit>

decision: {decision.proceed}
`;

/**
 * A checkpoint whose assessment found no material choice.
 *
 * The shape a checkpoint component uses, written here rather than imported: the
 * `<Else>` branch parses an explicit decision, so `proceed` is a validated
 * boolean some path produced on purpose. Nothing reads a missing elicitation as
 * consent, and the branch that would have asked is never expanded.
 */
const NO_MATERIAL_CHOICE = `<Parse schema={${ASSESSMENT_SCHEMA}} as="assessment">
{"requiresUser": false, "question": ""}
</Parse>

<If condition={assessment.requiresUser}>
  <Elicit schema={${DECISION_SCHEMA}} as="decision">
  {assessment.question}
  </Elicit>
  <Else>
    <Parse schema={${DECISION_SCHEMA}} as="decision">
    {"proceed": true, "response": "continue", "rationale": "The assessing agent found no material choice, so this transition needs no user decision."}
    </Parse>
  </Else>
</If>

proceed: {decision.proceed}
rationale: {decision.rationale}
`;

/** Narrowing rather than a cast: `filter` alone does not refine the element. */
function isYield(event: DurableEvent): event is Yield {
  return event.type === "yield";
}

function withRun<T>(
  body: (database: WorkflowRunDatabase, root: string) => Operation<T>,
): Operation<T> {
  return scoped(function* () {
    const root = yield* useStorageRoot();
    return yield* withBegunRun(root, (run) => body(run.database, root), RUN_ID);
  });
}

/** Every durable yield this run retained, as `type` alone. */
function* yields(database: WorkflowRunDatabase): Operation<string[]> {
  const events: DurableEvent[] = yield* database.journal.readAll();
  return events.filter(isYield).map((event) => event.description.type);
}

/** The retained suspension requests, in order. */
function* requests(database: WorkflowRunDatabase): Operation<Yield[]> {
  const events: DurableEvent[] = yield* database.journal.readAll();
  return events.filter(isYield).filter((event) => event.description.type === SUSPENSION_REQUEST);
}

/** The run's retained status, read the way something outside XMD would. */
function status(root: string, runId: string): string {
  const database = new DatabaseSync(runPath(root, runId), { readOnly: true });
  try {
    return String(
      database.prepare("SELECT status FROM workflow_run WHERE id = 1").get()?.["status"],
    );
  } finally {
    database.close();
  }
}

/** One retained JSON object field, parsed rather than asserted. */
function object(value: Json | undefined, what: string): Record<string, Json> {
  if (!isJsonObject(value)) {
    throw new Error(`${what} is not a JSON object`);
  }
  return value;
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
      const request = object(description.request, "the retained request");
      expect(request.kind).toBe("elicitation");
      expect(String(request.message)).toContain("Proceed with the change?");
      expect(object(description.responseSchema, "the retained response schema").type).toBe(
        "object",
      );

      expect(yield* yields(database)).not.toContain(ELICIT);
    });
  });

  it("CK6: an <Answers> region answers first, so nothing suspends and the run stays running", function* () {
    yield* withRun(function* (database, root) {
      yield* runWorkflowDocument(database, ANSWERED);

      expect(yield* requests(database)).toHaveLength(0);
      // Not merely "no request": the lifecycle never left `running`, so nothing
      // settled a suspension the executor would have had to release a lock for.
      expect(status(root, RUN_ID)).toBe("running");
    });
  });

  it("CK8: a checkpoint with no material choice proceeds on its own reason, and suspends nothing", function* () {
    yield* withRun(function* (database, root) {
      const output = yield* runWorkflowDocument(database, NO_MATERIAL_CHOICE);

      // The decision is produced by the branch that ran, with the reason it
      // gave — an advance because a decision said so, not because none existed.
      expect(String(output)).toContain("proceed: true");
      expect(String(output)).toContain("The assessing agent found no material choice");

      expect(yield* requests(database)).toHaveLength(0);
      expect(yield* yields(database)).not.toContain(ELICIT);
      expect(status(root, RUN_ID)).toBe("running");
    });
  });

  it("CK7: ordinary execution is unchanged — core's <Elicit> still records", function* () {
    const stream = new InMemoryStream();
    const output = yield* collect(yield* execute({ ...inlineSource(ANSWERED), stream }));

    expect(String(output)).toContain("decision: true");

    const events: DurableEvent[] = yield* stream.readAll();
    const recorded = events.filter(isYield).filter((event) => event.description.type === ELICIT);
    expect(recorded).toHaveLength(1);
  });
});
