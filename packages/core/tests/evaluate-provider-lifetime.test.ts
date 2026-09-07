/**
 * Tier FE15 — what a provider's answer is bound to, at execution scale.
 *
 * `answer-identity.test.ts` holds the unit half: an identity belongs to one
 * object in one execution, and a request that outlived its invocation states
 * nothing. These rows are the other half — the same guarantees driven through
 * a real execution, where the provider is installed by a trusted host, the
 * resolution happens during capture before the root import, and the sealed
 * answer is what a fragment runs.
 *
 * The failure this tier exists to prevent is a provider that keeps working
 * after the run that admitted it. A resolution suspended when the execution is
 * cancelled, a request retained past teardown, a losing answer arriving late,
 * and a captured body invoked afterwards are four shapes of the same thing, and
 * each of them here is asked about state the run actually left behind rather
 * than about the wording of a refusal.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { DurableEvent, Json } from "@executablemd/durable-streams";
import { ensure, scoped, spawn, suspend, withResolvers } from "effection";
import type { Operation } from "effection";

import { collect } from "../src/collect.ts";
import { Component } from "../src/component-api.ts";
import { executeInstalled } from "../host.ts";
import type {
  ComponentAnswerRegistrar,
  ComponentAnswerRequest,
  ExecutionInstallation,
  FragmentEvaluationInput,
} from "../host.ts";
import { registerComponents } from "../src/components/registration.ts";
import { prepareEvaluationProfile } from "../src/evaluation-profile.ts";
import type { ComponentAnswerEntry, ResolvedAnswer } from "../src/evaluation-profile.ts";
import { REVOKED_CAPABILITY } from "../src/fragment-capabilities.ts";
import { retainedSource } from "../src/root-source.ts";
import { recordedFiles } from "./support/fragment-files.ts";
import { answerProvider, implementation } from "./support/answer-provider.ts";
import type { Implementation } from "./support/answer-provider.ts";
import type { ComponentInvocation } from "../src/invocation-identity.ts";

const ROOT_PATH = "evaluate.md";
const OPEN = `<Evaluate text={'<Open />\\n'} as="answer" />\n\n<Json value={answer} />\n`;

/** What a provider states for the one name these rows admit. */
const IDENTITY = { key: "Open", revision: "1" } as const;

/** One provider-backed entry, under the identity this suite's providers claim. */
function answerEntry(name: string): ComponentAnswerEntry {
  return {
    kind: "component-answer",
    name,
    identity: { origin: "test://provider", key: name, revision: "1" },
    forms: ["self-closing"],
  };
}

/** The entry a host states for a provider-backed name. */
function admits(): FragmentEvaluationInput {
  return { read: [answerEntry("Open")], files: recordedFiles() };
}

/**
 * The first sentence of what one call refused with.
 *
 * A row comparing whole refusal prose would be comparing wording; what these
 * rows are about is *which* refusal happened — the settled resolution or the
 * ended execution — so they read the clause that says so.
 */
function refused(attempt: () => unknown): string {
  try {
    attempt();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return message.split(",")[0]?.trim() ?? message;
  }
  throw new Error("expected the claim to be refused");
}

function run(
  source: string,
  installations: readonly ExecutionInstallation[],
  stream: InMemoryStream = new InMemoryStream(),
): Operation<Json> {
  return scoped(function* () {
    return yield* collect(
      yield* executeInstalled({ ...retainedSource(ROOT_PATH, source), stream }, [...installations]),
    );
  });
}

/** What a retained request refused with when it was used, as a string. */
function refusalFrom(request: ComponentAnswerRequest | undefined): string {
  if (request === undefined) {
    throw new Error("the provider was never asked");
  }
  try {
    request.claim(implementation("Open", "late").definition, { key: "Open", revision: "1" });
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected the retained request to refuse");
}

/** What one execution refused with, as a string. */
function* refusal(operation: Operation<unknown>): Operation<string> {
  try {
    yield* operation;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected the operation to be refused");
}

/** Every generated-XMD admission a run recorded. */
function admissions(events: readonly DurableEvent[]): DurableEvent[] {
  return events.filter(
    (event) => event.type === "yield" && event.description.type === "generated_xmd",
  );
}

/** Whether a run got as far as importing its root document. */
function importedRoot(events: readonly DurableEvent[]): boolean {
  return events.some(
    (event) =>
      event.type === "yield" &&
      event.description.type === "import_component" &&
      event.description.name === "__root__",
  );
}

describe("Tier FE15 — a provider's answer belongs to the execution that captured it", () => {
  it("FE15: cancelling a suspended resolution waits for cleanup and revokes the request", function* () {
    const A = implementation("Open", "A ran");
    const stream = new InMemoryStream();
    const cleanup: string[] = [];
    const reached = withResolvers<void>();
    const retained: ComponentAnswerRequest[] = [];

    yield* scoped(function* () {
      const running = yield* spawn(() =>
        run(
          OPEN,
          [
            {
              evaluation: admits(),
              componentAnswers: [
                {
                  origin: "test://provider",
                  *install(registrar: ComponentAnswerRegistrar): Operation<void> {
                    yield* registrar.around(function* (request, next) {
                      if (request.name !== "Open") {
                        return yield* next();
                      }
                      retained.push(request);
                      // Registered before the barrier, so cancellation cannot
                      // arrive between entering the handler and owning the
                      // cleanup.
                      yield* ensure(function* () {
                        cleanup.push("resolution cleanup");
                      });
                      reached.resolve();
                      yield* suspend();
                      return request.claim(A.definition, { key: "Open", revision: "1" });
                    });
                  },
                },
              ],
            },
          ],
          stream,
        ),
      );
      // The resolution has actually entered, so this cancels work in flight
      // rather than work that never started.
      yield* reached.operation;
      yield* running.halt();
    });

    // Halt waited for the resolution's own cleanup before returning.
    expect(cleanup).toEqual(["resolution cleanup"]);
    // And the capture never completed, so nothing downstream of it happened:
    // no profile was sealed, the root was never imported, no admission was
    // decided, and the answer's body never ran.
    const events = yield* stream.readAll();
    expect(importedRoot(events)).toBe(false);
    expect(admissions(events)).toHaveLength(0);
    expect(A.invoked).toEqual([]);
    // Cancellation is a teardown like any other: the request this handler was
    // handed belongs to an execution that is over.
    expect(refusalFrom(retained[0])).toContain("has ended");
  });

  it("FE15: a request retained past a successful execution states nothing afterwards", function* () {
    const A = implementation("Open", "A ran");
    const retained: ComponentAnswerRequest[] = [];

    // The provider keeps the request its handler received.
    const output = yield* run(OPEN, [
      {
        evaluation: admits(),
        componentAnswers: [answerProvider("Open", A.definition, { retain: retained })],
      },
    ]);
    expect(String(output)).toContain("A ran");

    // The execution has ended. The request is the object the provider kept,
    // and it refuses rather than recording into a run that is over.
    expect(refusalFrom(retained[0])).toContain("has ended");
  });

  it("FE15: a failed execution revokes the request it minted", function* () {
    const A = implementation("Open", "A ran");
    const retained: ComponentAnswerRequest[] = [];

    // The third way a run ends. The fragment names something the profile never
    // admitted, so the run fails after capture succeeded — and teardown is
    // registered before the first installation, so it runs anyway.
    const failed = yield* refusal(
      run(`<Evaluate text={'<Elsewhere />\\n'} />\n`, [
        {
          evaluation: admits(),
          componentAnswers: [answerProvider("Open", A.definition, { retain: retained })],
        },
      ]),
    );

    expect(failed).toContain("did not admit");
    expect(A.invoked).toEqual([]);
    expect(refusalFrom(retained[0])).toContain("has ended");
  });

  it("FE15: a losing handler's request states nothing into the execution still running", function* () {
    const A = implementation("Open", "A ran");
    const B = implementation("Open", "B ran");
    const late: ComponentAnswerRequest[] = [];
    const attempted: string[] = [];

    // Two providers under one name. The first is installed outermost, is
    // genuinely asked, keeps the request it was handed and delegates without
    // claiming — which is what losing looks like. The second answers, and the
    // capture seals what it claimed.
    //
    // `<Meddle />` runs from the document, *after* the capture and while this
    // execution is still live — the window a post-run row cannot reach. So what
    // it proves is not that a revoked handle is inert; it is that a live losing
    // one changes nothing either.
    const output = yield* scoped(function* () {
      yield* registerComponents([
        {
          name: "Meddle",
          origin: "test://meddler",
          props: { type: "object", properties: {}, additionalProperties: false },
          // deno-lint-ignore require-yield
          *fn(): Operation<string> {
            const held = late[0];
            if (held === undefined) {
              throw new Error("the losing provider was never asked");
            }
            // The resolution of `Open` settled during capture, before the root
            // import, and this handler returned before that. The execution is
            // still very much alive — so what refuses is the invocation, not
            // the teardown.
            attempted.push(refused(() => held.claim(A.definition, IDENTITY)));
            // The same for the winner's own implementation: there is no live
            // request to retag it through either.
            attempted.push(refused(() => held.claim(B.definition, IDENTITY)));
            return "meddled";
          },
        },
      ]);
      return yield* run(
        `<Meddle />\n\n<Evaluate text={'<Open />\\n'} as="answer" />\n\n<Json value={answer} />\n`,
        [
          {
            evaluation: admits(),
            componentAnswers: [
              {
                origin: "test://losing",
                *install(registrar: ComponentAnswerRegistrar): Operation<void> {
                  yield* registrar.around(function* (request, next) {
                    if (request.name === "Open") {
                      late.push(request);
                    }
                    return yield* next();
                  });
                },
              },
              answerProvider("Open", B.definition),
            ],
          },
        ],
      );
    });

    // The meddling really happened, while the run was live, and neither attempt
    // was admitted.
    expect(attempted).toEqual(["this resolution has settled", "this resolution has settled"]);
    // And the fragment ran what the capture sealed.
    expect(String(output)).toContain("B ran");
    expect(B.invoked).toEqual(["B ran"]);
    expect(A.invoked).toEqual([]);
  });

  it("FE15: a losing handler cannot claim once it has returned, mid-resolution", function* () {
    const A = implementation("Open", "A ran");
    const B = implementation("Open", "B ran");
    const inner: ComponentAnswerRequest[] = [];
    const attempted: string[] = [];
    const delegated: unknown[] = [];
    let outerSettled = false;
    let innerSettled = false;

    // The frozen mid-resolution race. The inner provider is asked, keeps its
    // request and returns without claiming; the outer provider is *still
    // running* the same resolution, and invokes the inner one's request from
    // inside its own handler. The window is open, the name is right, the
    // execution is live — and the invocation that would have been speaking is
    // over.
    const output = yield* run(OPEN, [
      {
        evaluation: admits(),
        componentAnswers: [
          {
            // The origin the profile admits: this is the provider whose claim
            // has to be the one the capture reconciles.
            origin: "test://provider",
            *install(registrar: ComponentAnswerRegistrar): Operation<void> {
              yield* registrar.around(function* (request, next) {
                // Settles at the capture, like any provider: a fragment's own
                // import is canonical execution's to answer.
                if (request.name !== "Open" || outerSettled) {
                  return yield* next();
                }
                outerSettled = true;
                // Delegating first is what an outer replacement does, and it is
                // what closes the inner handler.
                delegated.push(yield* next());
                const held = inner[0];
                if (held === undefined) {
                  throw new Error("the inner provider was never asked");
                }
                attempted.push(refused(() => held.claim(A.definition, IDENTITY)));
                // And the outer handler's own request is still live, so it may
                // claim its replacement before returning.
                return request.claim(B.definition, { key: "Open", revision: "1" });
              });
            },
          },
          {
            origin: "test://inner",
            *install(registrar: ComponentAnswerRegistrar): Operation<void> {
              yield* registrar.around(function* (request, next) {
                if (request.name !== "Open" || innerSettled) {
                  return yield* next();
                }
                innerSettled = true;
                // Answers, keeps its request, and claims nothing — so it loses
                // the decision the outer handler goes on to make.
                inner.push(request);
                return A.definition;
              });
            },
          },
        ],
      },
    ]);

    expect(delegated).toHaveLength(1);
    expect(attempted).toEqual(["this resolution has settled"]);
    // The outer replacement is what ran, which is the positive half: claiming
    // after delegating has to keep working.
    expect(String(output)).toContain("B ran");
    expect(B.invoked).toEqual(["B ran"]);
    expect(A.invoked).toEqual([]);
  });

  it("FE15: a request from one settled resolution cannot restate that name", function* () {
    const A = implementation("Open", "A ran");
    const B = implementation("Other", "B ran");
    const late = implementation("Open", "late ran");
    const stale: ComponentAnswerRequest[] = [];
    const attempted: string[] = [];
    const carried: unknown[] = [];

    // Two provider-backed names, so the capture opens two resolutions in order.
    // The stale request is the one that *answered* the first, used from inside
    // the second resolution's live handler.
    const output = yield* run(
      `<Evaluate text={'<Open />\\n<Other />\\n'} as="answer" />\n\n<Json value={answer} />\n`,
      [
        {
          evaluation: {
            read: [answerEntry("Open"), answerEntry("Other")],
            files: recordedFiles(),
          },
          componentAnswers: [
            answerProvider("Open", A.definition, { retain: stale }),
            answerProvider("Other", B.definition, {
              key: "Other",
              whileResolving: () => {
                const held = stale[0];
                if (held === undefined) {
                  throw new Error("the first provider was never asked");
                }
                // The request is fixed to the name it was asked, so it cannot
                // even address the name being decided — and its own invocation
                // is over.
                expect(held.name).toBe("Open");
                attempted.push(refused(() => held.claim(late.definition, IDENTITY)));
                carried.push(A.definition);
              },
            }),
          ],
        },
      ],
    );

    expect(attempted).toEqual(["this resolution has settled"]);
    expect(carried).toEqual([A.definition]);
    // Both names ran what their own resolution sealed — which is also the
    // positive control that the second provider's own claim, made in the same
    // window as the refusal, was admitted.
    expect(String(output)).toContain("A ran");
    expect(String(output)).toContain("B ran");
    expect(A.invoked).toEqual(["A ran"]);
    expect(B.invoked).toEqual(["B ran"]);
    // The substitution reached no fragment.
    expect(late.invoked).toEqual([]);
  });

  it("FE15: one provider installation answers two admitted names", function* () {
    const A = implementation("Open", "A ran");
    const B = implementation("Other", "B ran");
    const answered: string[] = [];
    let installations = 0;

    // The positive control the request contract exists to keep working. One
    // installation owns one origin and registers *one* handler for both
    // admitted names; the capture opens a resolution per name, and that handler
    // is invoked once per resolution with a distinct request each time. An
    // installation spent on its first answer would fail here, on the second
    // name.
    const requests: ComponentAnswerRequest[] = [];
    const output = yield* run(
      `<Evaluate text={'<Open />\\n<Other />\\n'} as="answer" />\n\n<Json value={answer} />\n`,
      [
        {
          evaluation: {
            read: [answerEntry("Open"), answerEntry("Other")],
            files: recordedFiles(),
          },
          componentAnswers: [
            {
              origin: "test://provider",
              *install(registrar: ComponentAnswerRegistrar): Operation<void> {
                installations += 1;
                const supplied: Record<string, Implementation> = { Open: A, Other: B };
                yield* registrar.around(function* (request, next) {
                  const held = supplied[request.name];
                  if (held === undefined || answered.includes(request.name)) {
                    return yield* next();
                  }
                  answered.push(request.name);
                  requests.push(request);
                  return request.claim(held.definition, {
                    key: request.name,
                    revision: "1",
                  });
                });
              },
            },
          ],
        },
      ],
    );

    // One installation, one registered handler, two distinct requests — each
    // fixed to the name its own invocation was asked.
    expect(installations).toBe(1);
    expect(answered).toEqual(["Open", "Other"]);
    expect(requests).toHaveLength(2);
    expect(requests[0]).not.toBe(requests[1]);
    expect(requests.map((request) => request.name)).toEqual(["Open", "Other"]);
    expect(String(output)).toContain("A ran");
    expect(String(output)).toContain("B ran");
    expect(A.invoked).toEqual(["A ran"]);
    expect(B.invoked).toEqual(["B ran"]);
  });

  it("FE15: two executions live at once each run the answer it captured", function* () {
    const B = implementation("Open", "B ran");
    const entered = withResolvers<void>();
    const release = withResolvers<void>();
    const first: string[] = [];

    // The first execution's admitted body stops inside itself, so the second
    // one below overlaps it rather than following it. Two live executions, two
    // owners, two sealed profiles.
    const held = {
      kind: "function" as const,
      name: "Open",
      props: { type: "object", properties: {}, additionalProperties: false },
      *fn(): Operation<Json> {
        first.push("A ran");
        entered.resolve();
        yield* release.operation;
        return "A ran";
      },
    };

    yield* scoped(function* () {
      const running = yield* spawn(() =>
        run(OPEN, [{ evaluation: admits(), componentAnswers: [answerProvider("Open", held)] }]),
      );
      yield* entered.operation;

      // Started and finished while the first is suspended inside its fragment.
      const second = yield* run(OPEN, [
        { evaluation: admits(), componentAnswers: [answerProvider("Open", B.definition)] },
      ]);
      expect(String(second)).toContain("B ran");
      // The overlapping run did not reach into the first: its answer ran once,
      // and the first is still holding its own.
      expect(B.invoked).toEqual(["B ran"]);
      expect(first).toEqual(["A ran"]);

      release.resolve();
      expect(String(yield* running)).toContain("A ran");
    });

    // Each finished with what it captured, and neither ran the other's.
    expect(first).toEqual(["A ran"]);
    expect(B.invoked).toEqual(["B ran"]);
  });

  it("FE15: a captured provider body cannot run after the execution ends", function* () {
    const A = implementation("Open", "A ran");

    // The internal seam: this is the two-stage capture canonical execution
    // performs, driven directly, because there is no public way to reach a
    // sealed profile — which is itself the point. A row that had to add a
    // getter to observe this would be proving something about the getter.
    const prepared = yield* prepareEvaluationProfile(admits());
    expect(prepared.answered).toEqual([
      { name: "Open", identity: { origin: "test://provider", key: "Open", revision: "1" } },
    ]);

    const answers = new Map<string, ResolvedAnswer>([["Open", { definition: A.definition }]]);
    const profile = yield* prepared.seal(answers);
    const sealed = profile.read[0]?.definition.fn;
    if (typeof sealed !== "function") {
      throw new Error("the profile sealed no invocable entry");
    }

    // While the execution is live, the sealed definition runs.
    const invocation: ComponentInvocation = { hasContent: () => false };
    expect(yield* sealed({}, invocation)).toBe("A ran");
    expect(A.invoked).toEqual(["A ran"]);

    // Teardown. Whatever a provider, a handler or a retained callback still
    // holds is bound to an execution that has ended.
    profile.revoke();

    let refused: unknown;
    try {
      yield* sealed({}, invocation);
    } catch (error) {
      refused = error;
    }
    expect(String(refused)).toContain(REVOKED_CAPABILITY);
    // The body itself never entered a second time.
    expect(A.invoked).toEqual(["A ran"]);
  });

  it("FE15: a later execution without the provider sees nothing the first left", function* () {
    const A = implementation("Open", "A ran");
    const first = yield* run(OPEN, [
      { evaluation: admits(), componentAnswers: [answerProvider("Open", A.definition)] },
    ]);
    expect(String(first)).toContain("A ran");

    // The same document and the same profile, with no provider installed. The
    // first run's answer is not somewhere the second can find it: a claim leaves
    // no registry, no context and no module-level table behind it, so the name
    // resolves to nothing at all rather than to what the first run admitted.
    const failed = yield* refusal(run(OPEN, [{ evaluation: admits() }]));
    expect(failed).toContain("Cannot resolve component: Open");
    expect(A.invoked).toEqual(["A ran"]);
  });

  it("FE15: cancelling an admitted body waits for its cleanup and records no result", function* () {
    const stream = new InMemoryStream();
    const cleanup: string[] = [];
    const reached = withResolvers<void>();
    const invoked: string[] = [];

    const slow = {
      kind: "function" as const,
      name: "Open",
      props: { type: "object", properties: {}, additionalProperties: false },
      *fn(): Operation<Json> {
        yield* ensure(function* () {
          cleanup.push("body cleanup");
        });
        invoked.push("entered");
        reached.resolve();
        yield* suspend();
        return "A ran";
      },
    };

    yield* scoped(function* () {
      const running = yield* spawn(() =>
        run(
          OPEN,
          [{ evaluation: admits(), componentAnswers: [answerProvider("Open", slow)] }],
          stream,
        ),
      );
      yield* reached.operation;
      yield* running.halt();
    });

    // Halt waited for the admitted body's own cleanup.
    expect(invoked).toEqual(["entered"]);
    expect(cleanup).toEqual(["body cleanup"]);

    const events = yield* stream.readAll();
    // The admission committed — it is the decision, and it precedes what it
    // authorized. What did not happen is a terminal: a run that recorded one
    // here would resume believing the fragment finished.
    expect(admissions(events)).toHaveLength(1);
    expect(events.some((event) => event.type === "close" && event.coroutineId === "root")).toBe(
      false,
    );
  });
});
