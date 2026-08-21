/**
 * Complete testing activation, and what cannot manufacture one.
 *
 * `installTestingComponents()` registers behavior and `TestApi.testing` is
 * policy; neither owns a collector, a final flush or a completion policy. A
 * composition that has only those used to run every test body into nothing and
 * report the document as a success, so the whole of what these tests
 * discriminate is what the body did — a sentinel the body sets is the signal,
 * and "no results" is the vacuous failure mode rather than the evidence.
 */

import { describe, it, beforeAll } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { scoped } from "effection";
import type { Operation, Result } from "effection";
import { createApi } from "@effectionx/context-api";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { DurableEvent } from "@executablemd/durable-streams";
import { useStubFs } from "@executablemd/runtime/test";
import { execute, registerComponents, useTempFileCompiler } from "@executablemd/core";
import type { Operation as CoreOperation } from "effection";
import type { Json } from "@executablemd/core";
import { installTestingComponents } from "../src/components.ts";
import { useTesting } from "../src/use-testing.ts";
import type { TestResult } from "../src/test-api.ts";

/**
 * The stable names a separately loaded copy — or anything else — can reach.
 *
 * Written as literals rather than imported: a name nobody outside this package
 * could spell would prove nothing about a name everybody can.
 */
const TEST_API = "Test";
const COMPLETE_ACTIVATION = "executablemd.testing.complete-activation";

/** A separately constructed descriptor for the public policy surface. */
interface LoadedCopyTestApi {
  testing: boolean;
  record(result: TestResult): Operation<void>;
}

/** A separately constructed descriptor for core's activation seam. */
interface LoadedCopyCoreActivationApi {
  require(...args: unknown[]): CoreOperation<void>;
}

function loadedCopyCoreActivationApi() {
  return createApi<LoadedCopyCoreActivationApi>("TestActivation", {
    // deno-lint-ignore require-yield
    *require(..._args: unknown[]): CoreOperation<void> {},
  });
}

/** A separately constructed descriptor for the activation operation. */
interface LoadedCopyActivationApi {
  prove(...args: unknown[]): Operation<void>;
}

function loadedCopyTestApi() {
  return createApi<LoadedCopyTestApi>(TEST_API, {
    testing: false,
    // deno-lint-ignore require-yield
    *record(_result: TestResult): Operation<void> {},
  });
}

/** A separately constructed descriptor for the public behavior surface. */
function loadedCopyBehaviorApi() {
  return createApi<{ test(props: Record<string, Json>): CoreOperation<Json> }>("TestBehavior", {
    // deno-lint-ignore require-yield
    *test(): CoreOperation<Json> {
      throw new Error("unreachable: the installed handler answers");
    },
  });
}

function loadedCopyActivationApi() {
  return createApi<LoadedCopyActivationApi>(COMPLETE_ACTIVATION, {
    // deno-lint-ignore require-yield
    *prove(..._args: unknown[]): Operation<void> {},
  });
}

interface Attempt {
  completion: Result<Json>;
  output: string;
  /** Results that reached a collector outside the composition under test. */
  results: TestResult[];
  /** Names of `<Test>` bodies that started expanding. */
  sentinels: string[];
  events: DurableEvent[];
  stream: InMemoryStream;
}

/** `<Sentinel name="…" />` — proof that a `<Test>` body expanded. */
function useSentinel(sentinels: string[]): Operation<void> {
  return registerComponents([
    {
      name: "Sentinel",
      origin: "issue-523",
      props: {
        type: "object",
        properties: { name: { type: "string" } },
        additionalProperties: false,
      },
      // deno-lint-ignore require-yield
      *fn(props: Record<string, Json>) {
        sentinels.push(String(props.name));
        return "";
      },
    },
  ]);
}

/**
 * Run `document` under a composition of the caller's choosing.
 *
 * `compose` installs whatever activation the case is about, after the observers
 * this harness needs are already in place — the position from which a handler
 * would see everything a real one does.
 */
function runComposed(
  document: string,
  compose: Operation<unknown>,
  stream: InMemoryStream = new InMemoryStream(),
): Operation<Attempt> {
  return scoped(function* () {
    yield* useStubFs({ "README.md": document });
    const sentinels: string[] = [];
    const results: TestResult[] = [];
    yield* useSentinel(sentinels);
    const observer = loadedCopyTestApi();
    yield* observer.around({
      *record([result], next) {
        results.push(result);
        yield* next(result);
      },
    });
    yield* compose;
    const execution = yield* execute({ path: "README.md", stream });
    const completion = yield* execution;
    const output = completion.ok ? String(completion.value) : "";
    return { completion, output, results, sentinels, events: yield* stream.readAll(), stream };
  });
}

/** Registration plus a bare public `true`: the composition #523 refuses. */
function* incompleteActivation(): Operation<void> {
  yield* installTestingComponents();
  const policy = loadedCopyTestApi();
  yield* policy.around({ testing: () => true });
}

function testResultEvents(events: DurableEvent[]): DurableEvent[] {
  return events.filter(
    (event) => event.type === "yield" && event.description.type === "test_result",
  );
}

function errorOf(attempt: Attempt): Error | undefined {
  return attempt.completion.ok ? undefined : attempt.completion.error;
}

const REFUSAL = "complete testing activation";

describe("complete testing activation", () => {
  beforeAll(() => useTempFileCompiler());

  // Both body shapes, because a passing body and a failing one take different
  // paths through classification and reporting — and neither may start.
  const shapes = [
    { label: "a passing body", assertion: "<Assert expr={true} />" },
    { label: "a failing body", assertion: "<Assert expr={false} />" },
  ];
  for (const shape of shapes) {
    it(`refuses ${shape.label} before it expands`, function* () {
      const attempt = yield* runComposed(
        `<Test name="t"><Sentinel name="body" />${shape.assertion}</Test>\n`,
        incompleteActivation(),
      );
      expect(attempt.sentinels).toEqual([]);
      expect(errorOf(attempt)?.message).toContain(REFUSAL);
      expect(errorOf(attempt)?.message).toContain("useTesting()");
    });
  }

  // The refusal is a configuration failure, not a test outcome: nothing records
  // it, nothing journals it, and nothing reports it as an assertion.
  it("creates no test outcome anywhere", function* () {
    const attempt = yield* runComposed(
      '<Test name="t"><Sentinel name="body" /><Assert expr={false} /></Test>\n',
      incompleteActivation(),
    );
    expect(attempt.results).toEqual([]);
    expect(testResultEvents(attempt.events)).toEqual([]);
    expect(attempt.output).not.toContain("Assert");
    expect(attempt.output).not.toContain("❌");

    // Whatever the refused run left behind, reading it back restores no test.
    const replay = yield* runComposed(
      '<Test name="t"><Sentinel name="body" /><Assert expr={false} /></Test>\n',
      incompleteActivation(),
      new InMemoryStream(attempt.events),
    );
    expect(replay.results).toEqual([]);
    expect(testResultEvents(replay.events)).toEqual([]);
    expect(replay.sentinels).toEqual([]);
  });

  // Public middleware may narrow, observe, refuse and compose recording. What
  // it cannot do is be the activation: every manipulation below is available to
  // any loaded copy, and each one ends in the same pre-body refusal.
  it("cannot be manufactured through the stable public surfaces", function* () {
    const forged = loadedCopyActivationApi();
    const attempts: Record<string, Attempt> = {};

    attempts.droppedRecording = yield* runComposed(
      '<Test name="t"><Sentinel name="body" /><Assert expr={true} /></Test>\n',
      (function* () {
        yield* incompleteActivation();
        const policy = loadedCopyTestApi();
        // deno-lint-ignore require-yield
        yield* policy.around({ *record() {} });
      })(),
    );

    attempts.answeredWithoutDelegating = yield* runComposed(
      '<Test name="t"><Sentinel name="body" /><Assert expr={true} /></Test>\n',
      (function* () {
        yield* incompleteActivation();
        // deno-lint-ignore require-yield
        yield* forged.around({ *prove() {} }, { at: "min" });
      })(),
    );

    attempts.substitutedCredential = yield* runComposed(
      '<Test name="t"><Sentinel name="body" /><Assert expr={true} /></Test>\n',
      (function* () {
        yield* incompleteActivation();
        yield* forged.around(
          {
            *prove([request], next) {
              yield* next(request, { live: true, complete: true });
            },
          },
          { at: "min" },
        );
      })(),
    );

    attempts.substitutedRequest = yield* runComposed(
      '<Test name="t"><Sentinel name="body" /><Assert expr={true} /></Test>\n',
      (function* () {
        yield* incompleteActivation();
        yield* forged.around(
          {
            *prove([_request, credential], next) {
              yield* next({ accepted: true }, credential);
            },
          },
          { at: "min" },
        );
      })(),
    );

    // Under a complete session, so the second delegation carries a credential
    // that really is live: delivering one request twice is a protocol violation
    // rather than a second proof, and withdraws the claim.
    attempts.delegatedTwice = yield* runComposed(
      '<Test name="t"><Sentinel name="body" /><Assert expr={true} /></Test>\n',
      (function* () {
        yield* useTesting();
        yield* forged.around(
          {
            *prove(args, next) {
              yield* next(...args);
              yield* next(...args);
            },
          },
          { at: "min" },
        );
      })(),
    );

    // A same-name descriptor dispatching the operation itself: the chain runs,
    // and its own terminal records acceptance into state no <Test> reads.
    attempts.dispatchedItself = yield* runComposed(
      '<Test name="t"><Sentinel name="body" /><Assert expr={true} /></Test>\n',
      (function* () {
        yield* incompleteActivation();
        yield* forged.operations.prove({ accepted: true });
      })(),
    );

    for (const [label, attempt] of Object.entries(attempts)) {
      expect([label, attempt.sentinels]).toEqual([label, []]);
      expect([label, attempt.completion.ok]).toEqual([label, false]);
      expect([label, errorOf(attempt)?.message]).toEqual([label, expect.stringContaining(REFUSAL)]);
      expect([label, testResultEvents(attempt.events).length]).toEqual([label, 0]);
    }
  });

  // The same manipulation against core's activation seam. Core dispatches
  // through a terminal of its own and refuses an invocation whose decision was
  // never taken, so blocking the chain refuses the test rather than waving it
  // through — and the refusal is a configuration failure exactly as an
  // incomplete activation is, under either composition.
  //
  // The incomplete one is the case that matters: with no session, nothing would
  // convert a contained test failure into a document failure, so absorbing this
  // as a test outcome would report a run that never ran a test as a success.
  const blockedCompositions = [
    { label: "an incomplete composition", compose: () => incompleteActivation() },
    { label: "a complete session", compose: () => useTesting() },
  ];
  for (const composition of blockedCompositions) {
    it(`refuses a blocked activation decision under ${composition.label}`, function* () {
      const attempt = yield* runComposed(
        '<Test name="t"><Sentinel name="body" /><Assert expr={true} /></Test>\n',
        (function* () {
          const seam = loadedCopyCoreActivationApi();
          // deno-lint-ignore require-yield
          yield* seam.around({ *require() {} });
          yield* composition.compose();
        })(),
      );
      expect(attempt.sentinels).toEqual([]);
      expect(attempt.completion.ok).toBe(false);
      // Core's own protocol violation: this package is never reached, so the
      // message is core's rather than the incomplete-activation refusal.
      expect(errorOf(attempt)?.message).toContain("without delegating it");
      expect(attempt.results).toEqual([]);
      expect(testResultEvents(attempt.events)).toEqual([]);
    });
  }

  // The behavior surface is public middleware, and answering without delegating
  // is a legitimate use of it — which is why the activation decision cannot
  // live inside that chain. Canonical core takes it before the harness exists
  // and before this chain is dispatched, so a handler that answers for what a
  // test does cannot answer for whether it may run.
  it("survives a TestBehavior handler that never delegates", function* () {
    const behavior = loadedCopyBehaviorApi();
    const attempt = yield* runComposed(
      '<Test name="t"><Sentinel name="body" /><Assert expr={false} /></Test>\n',
      (function* () {
        // Installed before the package's own handler, so it is the outer link
        // and answers first.
        // deno-lint-ignore require-yield
        yield* behavior.around({
          *test() {
            return "";
          },
        });
        yield* incompleteActivation();
      })(),
    );
    expect(attempt.sentinels).toEqual([]);
    expect(errorOf(attempt)?.message).toContain(REFUSAL);
    expect(testResultEvents(attempt.events)).toEqual([]);
  });

  // The control, in the identical middleware order: a handler that delegates
  // observes the behavior and changes nothing about it.
  it("leaves an ordinary TestBehavior handler composing under a complete session", function* () {
    const behavior = loadedCopyBehaviorApi();
    const observed: string[] = [];
    const attempt = yield* runComposed(
      '<Test name="t"><Sentinel name="body" /><Assert expr={true} /></Test>\n',
      (function* () {
        yield* behavior.around({
          *test([props], next) {
            observed.push(String(props.name));
            return yield* next(props);
          },
        });
        yield* useTesting();
      })(),
    );
    expect(observed).toEqual(["t"]);
    expect(attempt.sentinels).toEqual(["body"]);
    expect(attempt.completion.ok).toBe(true);
    expect(attempt.results.map((result) => [result.name, result.status])).toEqual([["t", "pass"]]);
    expect(testResultEvents(attempt.events)).toHaveLength(1);
  });

  // The other direction: under a real session the same public surface keeps
  // working, and observes results in discovery order.
  it("leaves loaded-copy policy and recording composition working", function* () {
    const attempt = yield* runComposed(
      [
        '<Test name="first"><Sentinel name="first" /><Assert expr={true} /></Test>',
        '<Test name="second"><Sentinel name="second" /><Assert expr={true} /></Test>',
        "",
      ].join("\n"),
      useTesting(),
    );
    expect(attempt.completion.ok).toBe(true);
    expect(attempt.sentinels).toEqual(["first", "second"]);
    expect(attempt.results.map((result) => [result.name, result.status])).toEqual([
      ["first", "pass"],
      ["second", "pass"],
    ]);
    expect(testResultEvents(attempt.events)).toHaveLength(2);
  });

  // Narrowing is what the public boolean is for, and it still works: a policy
  // that answers `false` leaves the test inactive rather than refused.
  it("lets public policy narrow testing to false under a complete session", function* () {
    const attempt = yield* runComposed(
      '<Test name="t"><Sentinel name="body" /><Assert expr={false} /></Test>\n',
      (function* () {
        yield* useTesting();
        const policy = loadedCopyTestApi();
        yield* policy.around({ testing: () => false });
      })(),
    );
    expect(attempt.sentinels).toEqual([]);
    expect(attempt.results).toEqual([]);
    // No tests were discovered, which is the session's own outcome — not the
    // activation refusal.
    expect(errorOf(attempt)?.message).toContain("no tests were discovered");
  });

  // An ended boundary's credential is retired, so a `<Test>` written after it
  // is refused exactly as one written before it.
  it("expires with the boundary that established it", function* () {
    const attempt = yield* runComposed(
      [
        "<Testing>",
        '<Test name="inside"><Sentinel name="inside" /><Assert expr={true} /></Test>',
        "</Testing>",
        '<Test name="after"><Sentinel name="after" /><Assert expr={true} /></Test>',
        "",
      ].join("\n"),
      incompleteActivation(),
    );
    expect(attempt.sentinels).toEqual(["inside"]);
    expect(errorOf(attempt)?.message).toContain(REFUSAL);
  });
});
