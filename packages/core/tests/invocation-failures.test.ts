/**
 * Tier O — the invocation boundary's failure contract (spec §4.4).
 *
 * These tests drive `withInvocation` directly: body execution and teardown are
 * different failure domains, and a cleanup failure must not erase the failure
 * that caused the scope to unwind. Every planted error is asserted back by
 * object identity, because that is what `fatalCause()` traverses.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, resource, sleep } from "effection";
import type { Operation } from "effection";
import { StaleInputError } from "@executablemd/durable-streams";
import { InvocationTeardownError, withInvocation } from "../src/invocation.ts";
import { DocumentationError, fatalCause } from "../src/errors.ts";
import type { Invocation } from "../src/invocation.ts";

/**
 * Records `start:<label>` on acquisition and `stop:<label>` on teardown, and
 * fails the teardown with the given error. The destructor genuinely yields
 * before it reports, so a stage has to await it rather than observe a
 * synchronous throw.
 */
function probe(timeline: string[], label: string, failure?: Error): Operation<void> {
  return resource(function* (provide) {
    timeline.push(`start:${label}`);
    yield* ensure(function* () {
      yield* sleep(1);
      timeline.push(`stop:${label}`);
      if (failure) {
        throw failure;
      }
    });
    yield* provide();
  });
}

/** One probe per teardown stage: content (stage 1), body (stage 2), eval (stage 3). */
function* plantStages(
  invocation: Invocation,
  timeline: string[],
  failures: { content?: Error; body?: Error; eval?: Error },
): Operation<void> {
  yield* invocation.evalScope.eval(() => probe(timeline, "eval", failures.eval));
  const content = yield* invocation.useContentScope();
  yield* content.eval(() => probe(timeline, "content", failures.content));
  yield* probe(timeline, "body", failures.body);
}

function* capture(op: () => Operation<unknown>): Operation<unknown> {
  try {
    yield* op();
  } catch (error) {
    return error;
  }
  throw new Error("expected the invocation to fail");
}

describe("Tier O — Eval scope hierarchy", () => {
  it("O34: a body failure is rethrown by identity when teardown succeeds", function* () {
    const timeline: string[] = [];
    const sentinel = new Error("body failure");

    const caught = yield* capture(() =>
      withInvocation(function* (invocation) {
        yield* plantStages(invocation, timeline, {});
        yield* sleep(1);
        throw sentinel;
      }),
    );

    expect(caught).toBe(sentinel);
    // Every stage still ran, in the boundary's order.
    expect(timeline).toEqual([
      "start:eval",
      "start:content",
      "start:body",
      "stop:content",
      "stop:body",
      "stop:eval",
    ]);
  });

  it("O35: a lone teardown failure keeps the InvocationTeardownError shape", function* () {
    const timeline: string[] = [];
    const stage = new Error("stage failure");

    const caught = yield* capture(() =>
      withInvocation(function* (invocation) {
        yield* plantStages(invocation, timeline, { body: stage });
        return "ok";
      }),
    );

    expect(caught).toBeInstanceOf(InvocationTeardownError);
    if (!(caught instanceof InvocationTeardownError)) {
      throw new Error("unreachable");
    }
    expect(caught.causes).toHaveLength(1);
    expect(caught.causes[0]).toBe(stage);
    expect(caught.cause).toBe(stage);
  });

  it("O36: a body failure and stage failures produce the two-domain aggregate", function* () {
    const timeline: string[] = [];
    const sentinel = new Error("body failure");
    const contentStage = new Error("content stage failure");
    const bodyStage = new Error("body stage failure");
    const evalStage = new Error("eval stage failure");

    const caught = yield* capture(() =>
      withInvocation(function* (invocation) {
        yield* plantStages(invocation, timeline, {
          content: contentStage,
          body: bodyStage,
          eval: evalStage,
        });
        throw sentinel;
      }),
    );

    expect(caught).toBeInstanceOf(AggregateError);
    if (!(caught instanceof AggregateError)) {
      throw new Error("unreachable");
    }
    expect(caught.errors).toHaveLength(2);
    expect(caught.errors[0]).toBe(sentinel);
    const teardown = caught.errors[1];
    expect(teardown).toBeInstanceOf(InvocationTeardownError);
    if (!(teardown instanceof InvocationTeardownError)) {
      throw new Error("unreachable");
    }
    expect(teardown.causes).toHaveLength(3);
    expect(teardown.causes[0]).toBe(contentStage);
    expect(teardown.causes[1]).toBe(bodyStage);
    expect(teardown.causes[2]).toBe(evalStage);
  });

  it("O37: a DocumentationError body failure survives a teardown failure", function* () {
    const timeline: string[] = [];
    const doc = new DocumentationError({ type: "error", message: "the document is wrong" });

    const caught = yield* capture(() =>
      withInvocation(function* (invocation) {
        yield* plantStages(invocation, timeline, { body: new Error("stage failure") });
        throw doc;
      }),
    );

    expect(caught).toBeInstanceOf(AggregateError);
    if (!(caught instanceof AggregateError)) {
      throw new Error("unreachable");
    }
    expect(caught.errors[0]).toBe(doc);
    expect(fatalCause(caught)).toBe(doc);
  });

  it("O38: a durability body failure plus a teardown failure stays fatal", function* () {
    const timeline: string[] = [];
    const fatal = new StaleInputError("journal entry no longer describes this run");

    const caught = yield* capture(() =>
      withInvocation(function* (invocation) {
        yield* plantStages(invocation, timeline, { body: new Error("stage failure") });
        throw fatal;
      }),
    );

    expect(fatalCause(caught)).toBe(fatal);
  });

  it("O39: a durability teardown failure outranks a documentation body failure", function* () {
    const timeline: string[] = [];
    const doc = new DocumentationError({ type: "error", message: "the document is wrong" });
    const fatal = new StaleInputError("journal entry no longer describes this run");

    const caught = yield* capture(() =>
      withInvocation(function* (invocation) {
        yield* plantStages(invocation, timeline, { body: fatal });
        throw doc;
      }),
    );

    expect(fatalCause(caught)).toBe(fatal);
  });

  it("O40: every stage runs after a body failure, even when stages fail", function* () {
    const timeline: string[] = [];

    yield* capture(() =>
      withInvocation(function* (invocation) {
        yield* plantStages(invocation, timeline, {
          content: new Error("content stage failure"),
          body: new Error("body stage failure"),
          eval: new Error("eval stage failure"),
        });
        throw new Error("body failure");
      }),
    );

    expect(timeline).toEqual([
      "start:eval",
      "start:content",
      "start:body",
      "stop:content",
      "stop:body",
      "stop:eval",
    ]);
  });
});
