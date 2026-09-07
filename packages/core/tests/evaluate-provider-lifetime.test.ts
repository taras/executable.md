/**
 * Tier FE15 — what a provider's answer is bound to, at execution scale.
 *
 * `answer-identity.test.ts` holds the unit half: an identity belongs to one
 * object in one execution, and a claimant that outlived its execution states
 * nothing. These rows are the other half — the same guarantees driven through a
 * real execution, where the provider is installed by a trusted host, the
 * resolution happens during capture before the root import, and the sealed
 * answer is what a fragment runs.
 *
 * The failure this tier exists to prevent is a provider that keeps working
 * after the run that admitted it. A resolution suspended when the execution is
 * cancelled, a claimant retained past teardown, a losing answer arriving late,
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
  ComponentAnswerClaim,
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

/** What a retained claimant refused with when it was used, as a string. */
function refusalFrom(claimant: ComponentAnswerClaim | undefined): string {
  if (claimant === undefined) {
    throw new Error("the provider was never installed");
  }
  try {
    claimant.claim("Open", implementation("Open", "late").definition, {
      key: "Open",
      revision: "1",
    });
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected the retained claimant to refuse");
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
  it("FE15: cancelling a suspended resolution waits for cleanup and revokes the claimant", function* () {
    const A = implementation("Open", "A ran");
    const stream = new InMemoryStream();
    const cleanup: string[] = [];
    const reached = withResolvers<void>();
    const retained: ComponentAnswerClaim[] = [];

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
                  *install(claim: ComponentAnswerClaim): Operation<void> {
                    retained.push(claim);
                    yield* Component.around({
                      *importComponent([asked, position], next) {
                        if (asked !== "Open") {
                          return yield* next(asked, position);
                        }
                        // Registered before the barrier, so cancellation cannot
                        // arrive between entering the handler and owning the
                        // cleanup.
                        yield* ensure(function* () {
                          cleanup.push("resolution cleanup");
                        });
                        reached.resolve();
                        yield* suspend();
                        return claim.claim("Open", A.definition, {
                          key: "Open",
                          revision: "1",
                        });
                      },
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
    // Cancellation is a teardown like any other: the claimant this provider was
    // handed belongs to an execution that is over.
    expect(refusalFrom(retained[0])).toContain("has ended");
  });

  it("FE15: a claimant retained past a successful execution states nothing afterwards", function* () {
    const A = implementation("Open", "A ran");
    const retained: ComponentAnswerClaim[] = [];

    // The provider keeps the claimant, which is the thing a real one holds onto.
    const output = yield* run(OPEN, [
      {
        evaluation: admits(),
        componentAnswers: [answerProvider("Open", A.definition, { retain: retained })],
      },
    ]);
    expect(String(output)).toContain("A ran");

    // The execution has ended. The claimant is the object the provider kept,
    // and it refuses rather than recording into a run that is over.
    expect(refusalFrom(retained[0])).toContain("has ended");
  });

  it("FE15: a failed execution revokes the claimant it minted", function* () {
    const A = implementation("Open", "A ran");
    const retained: ComponentAnswerClaim[] = [];

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

  it("FE15: a losing claimant states nothing into the execution still running", function* () {
    const A = implementation("Open", "A ran");
    const B = implementation("Open", "B ran");
    const late: ComponentAnswerClaim[] = [];
    const attempted: string[] = [];

    // Two providers under one name. The first is installed outermost and
    // declines to answer at all, which is what losing looks like; the second
    // answers, and the capture seals what it claimed.
    //
    // `<Meddle />` runs from the document, *after* the capture and while this
    // execution is still live — which is the window a post-run row cannot
    // reach. So what it proves is not that a revoked claimant is inert; it is
    // that a live losing one changes nothing either.
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
              throw new Error("the losing provider was never installed");
            }
            // The resolution of `Open` settled during capture, before the root
            // import. This claimant lost it, and the execution is still very
            // much alive — so what refuses here is the *occurrence*, not the
            // teardown. A claim admitted now would identify an answer nobody
            // asked this provider for.
            attempted.push(refused(() => held.claim("Open", A.definition, IDENTITY)));
            // The same for the winner's own implementation: there is no window
            // to retag it in either.
            attempted.push(refused(() => held.claim("Open", B.definition, IDENTITY)));
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
                origin: "test://provider",
                // deno-lint-ignore require-yield
                *install(claim: ComponentAnswerClaim): Operation<void> {
                  late.push(claim);
                },
              },
              answerProvider("Open", B.definition),
            ],
          },
        ],
      );
    });

    // The meddling really happened, while the run was live, and neither attempt
    // was admitted. The refusal names the settled resolution rather than a
    // finished execution — the document was still running when it was made.
    expect(attempted).toEqual(["this resolution has settled", "this resolution has settled"]);
    // And the fragment ran what the capture sealed.
    expect(String(output)).toContain("B ran");
    expect(B.invoked).toEqual(["B ran"]);
    expect(A.invoked).toEqual([]);
  });

  it("FE15: a claim from one settled resolution cannot land in another name's", function* () {
    const A = implementation("Open", "A ran");
    const B = implementation("Other", "B ran");
    const late = implementation("Open", "late ran");
    const losing: ComponentAnswerClaim[] = [];
    const attempted: string[] = [];

    // Two provider-backed names, so the capture opens two resolutions in
    // order. The first provider loses `Open` and keeps its claimant; the second
    // answers `Other`, and from *inside* that live resolution it uses the
    // losing claimant to record an answer for `Open`.
    //
    // That is the race a single execution-wide switch cannot see: the owner is
    // active, a resolution is open, and the claim still belongs to a decision
    // that is over.
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
              // deno-lint-ignore require-yield
              *install(claim: ComponentAnswerClaim): Operation<void> {
                losing.push(claim);
              },
            },
            answerProvider("Open", A.definition),
            answerProvider("Other", B.definition, {
              key: "Other",
              // Resolution two is open when this runs, and the claim it makes
              // is resolution one's. It names the name that already settled.
              whileResolving: () => {
                const held = losing[0];
                if (held === undefined) {
                  throw new Error("the losing provider was never installed");
                }
                attempted.push(refused(() => held.claim("Open", late.definition, IDENTITY)));
              },
            }),
          ],
        },
      ],
    );

    expect(attempted).toEqual(["this resolution has settled"]);
    // Both names ran what their own resolution sealed, and the late answer
    // reached neither of them.
    expect(String(output)).toContain("A ran");
    expect(String(output)).toContain("B ran");
    expect(A.invoked).toEqual(["A ran"]);
    expect(B.invoked).toEqual(["B ran"]);
    expect(late.invoked).toEqual([]);
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
