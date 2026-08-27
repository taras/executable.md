/**
 * Tier BE — behavior-engine tests (specs/test-agent-spec.md §Behavior
 * documents): the `<WhenPrompt>` component driven in-process against a
 * real document execution, with no ACP transport, controller, or worker.
 * Proves stage advancement, capture exposure, mismatch retention, and
 * reaching a second stage through EOF.
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, Ok, scoped, spawn } from "effection";
import type { Operation, Result, Subscription } from "effection";
import { ensureDir, rm, writeTextFile } from "@effectionx/fs";
import { randomUUID } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import { Component, DocumentOutput, execute } from "@executablemd/core";
import { InMemoryStream } from "@executablemd/durable-streams";
import { collectTurn, createTurnBridge } from "../src/worker/bridge.ts";
import type { BridgeEvent } from "../src/worker/bridge.ts";
import type { Captures } from "@executablemd/core";
import { installWhenPromptComponent } from "../src/worker/when-prompt.ts";

const REVIEW = [
  "<WhenPrompt",
  '  as="review"',
  '  template="Review {?subject} at revision {?revision}"',
  "/>",
  "",
  "The review of **{review.subject}** at `{review.revision}` passed.",
  "",
  '<WhenPrompt template="Summarize {review.subject}" />',
  "",
  "The review of **{review.subject}** passed.",
  "",
].join("\n");

interface Engine {
  turnEvents: Subscription<BridgeEvent, never>;
  offer(text: string): Operation<Result<Captures>>;
}

function* useEngine(source: string): Operation<Engine> {
  const dir = path.join(os.tmpdir(), `xmd-be-${randomUUID()}`);
  yield* ensureDir(dir);
  yield* ensure(() => rm(dir, { recursive: true, force: true }));
  const docPath = path.join(dir, "behavior.md");
  yield* writeTextFile(docPath, source);

  const bridge = createTurnBridge();
  const turnEvents = yield* bridge.events;
  const stream = new InMemoryStream();

  yield* installWhenPromptComponent(bridge);
  yield* Component.around({
    // deno-lint-ignore require-yield
    *raise([segment]) {
      throw new Error(segment.message);
    },
  });
  yield* DocumentOutput.around({
    *output([text], next) {
      yield* bridge.events.send({ kind: "output", text });
      yield* next(text);
    },
  });

  const execution = yield* execute({ path: docPath, stream, includes: [] });
  yield* spawn(function* () {
    const result = yield* execution;
    if (result.ok) {
      yield* bridge.events.send({ kind: "eof" });
    } else {
      yield* bridge.events.send({ kind: "failed", error: result.error.message });
    }
  });

  return { turnEvents, offer: (text: string) => bridge.offer(text) };
}

/**
 * One engine per scope. `installWhenPromptComponent` registers the name for the
 * scope it runs in, and a second registration there is a configuration error —
 * so a test comparing two documents gives each its own.
 */
function withEngine<T>(source: string, body: (engine: Engine) => Operation<T>): Operation<T> {
  return scoped(function* () {
    return yield* body(yield* useEngine(source));
  });
}

describe("Tier BE — behavior engine", () => {
  it("BE1: a matched prompt advances the stage, exposes captures, and reaches the second stage", function* () {
    const engine = yield* useEngine(REVIEW);

    const init = yield* collectTurn(engine.turnEvents);
    expect(init.end).toBe("suspended");
    expect(init.text.trim()).toBe("");
    expect(init.stage).toContain("Review {?subject} at revision {?revision}");

    const first = yield* engine.offer("Review packages/core at revision abc123");
    expect(first).toEqual(Ok({ subject: "packages/core", revision: "abc123" }));

    const turn1 = yield* collectTurn(engine.turnEvents);
    expect(turn1.end).toBe("suspended");
    expect(turn1.stage).toContain("Summarize {review.subject}");
    expect(turn1.text).toContain("The review of **packages/core** at `abc123` passed.");
  });

  it("BE2: a mismatch keeps the stage active; a later match advances it to EOF", function* () {
    const engine = yield* useEngine(REVIEW);
    yield* collectTurn(engine.turnEvents);
    expect((yield* engine.offer("Review packages/core at revision abc123")).ok).toBe(true);
    yield* collectTurn(engine.turnEvents);

    const mismatch = yield* engine.offer("Do something unrelated");
    expect(mismatch.ok).toBe(false);
    expect(mismatch).toMatchObject({ error: { kind: "mismatch" } });

    const second = yield* engine.offer("Summarize packages/core");
    expect(second.ok).toBe(true);
    const turn2 = yield* collectTurn(engine.turnEvents);
    expect(turn2.text).toContain("The review of **packages/core** passed.");
    expect(turn2.end).toBe("eof");
  });

  /**
   * The tag's shape chooses the template form, and BE3/BE4 are the pair that
   * shows it: neither writes a `template` prop, and they differ only in being
   * self-closing or paired. A form chosen from whether children happen to
   * render something could not tell them apart.
   */
  it("BE3: a self-closing tag reads its template from the prop, and has none without one", function* () {
    yield* withEngine('<WhenPrompt template="hi" />\n\nafter\n', function* (engine) {
      const init = yield* collectTurn(engine.turnEvents);
      expect(init.end).toBe("suspended");
      expect(init.stage).toBe("hi");
      expect((yield* engine.offer("hi")).ok).toBe(true);
    });

    yield* withEngine("<WhenPrompt />\n\nafter\n", function* (engine) {
      const failed = yield* collectTurn(engine.turnEvents);
      expect(failed.end).toBe("failed");
      expect(failed.error).toContain("requires a template prop or template children");
    });
  });

  it("BE4: a paired tag is the content form even when it is empty", function* () {
    const engine = yield* useEngine("<WhenPrompt></WhenPrompt>\n\nafter\n");

    // Not the "requires a template" diagnostic BE3's self-closing tag gets: an
    // empty pair is a template, and an empty one constrains like any other.
    const init = yield* collectTurn(engine.turnEvents);
    expect(init.end).toBe("suspended");
    expect(init.stage).toBe("");

    const mismatch = yield* engine.offer("anything");
    expect(mismatch.ok).toBe(false);
    expect(mismatch).toMatchObject({ error: { kind: "mismatch", expected: "" } });

    expect(yield* engine.offer("")).toEqual(Ok({}));
    expect((yield* collectTurn(engine.turnEvents)).text).toContain("after");
  });

  it("BE5: supplying both template forms is rejected", function* () {
    for (const source of [
      '<WhenPrompt template="hi"></WhenPrompt>\n',
      '<WhenPrompt template="hi">bye</WhenPrompt>\n',
    ]) {
      yield* withEngine(source, function* (engine) {
        const failed = yield* collectTurn(engine.turnEvents);
        expect(failed.end).toBe("failed");
        expect(failed.error).toContain("accepts either a template prop or children, not both");
      });
    }
  });

  it("BE6: captures bind by reference under `as`", function* () {
    const engine = yield* useEngine(
      [
        '<WhenPrompt as="r" template="Review {?subject} at {?revision}" />',
        "",
        "each=[{r.subject}|{r.revision}] whole=[{r}]",
        "",
      ].join("\n"),
    );
    yield* collectTurn(engine.turnEvents);
    expect(yield* engine.offer("Review core at abc123")).toEqual(
      Ok({ subject: "core", revision: "abc123" }),
    );

    const turn = yield* collectTurn(engine.turnEvents);
    // The object itself: member access resolves, and interpolating the binding
    // whole reaches an object rather than the text a rendering would have left.
    expect(turn.text).toContain("each=[core|abc123]");
    expect(turn.text).toContain("whole=[[object Object]]");
  });

  it("BE7: an `as` naming an existing binding replaces it rather than merging into it", function* () {
    const engine = yield* useEngine(
      [
        '<WhenPrompt as="review" template="Review {?subject}" />',
        "",
        "first=[{review.subject}]",
        "",
        '<WhenPrompt as="review" template="Check {?target}" />',
        "",
        "second=[{review.target}] previous=[{review.subject}]",
        "",
      ].join("\n"),
    );

    yield* collectTurn(engine.turnEvents);
    expect((yield* engine.offer("Review core")).ok).toBe(true);
    expect((yield* collectTurn(engine.turnEvents)).text).toContain("first=[core]");

    expect((yield* engine.offer("Check tests")).ok).toBe(true);
    const turn = yield* collectTurn(engine.turnEvents);
    expect(turn.text).toContain("second=[tests]");
    // The whole binding was replaced, so the first stage's capture is not a key
    // of it any more. Merging would have kept `previous=[core]`.
    expect(turn.text).toContain("previous=[undefined]");
  });

  it("BE8: a capturing template invoked without `as` discards its captures", function* () {
    const engine = yield* useEngine(
      [
        '<WhenPrompt template="Review {?subject} at {?revision}" />',
        "",
        "seen=[{subject}]",
        "",
      ].join("\n"),
    );

    yield* collectTurn(engine.turnEvents);
    // Captured, and reported to whoever offered the prompt — so what the
    // document lacks is a binding, not a match.
    expect(yield* engine.offer("Review core at abc123")).toEqual(
      Ok({ subject: "core", revision: "abc123" }),
    );

    const turn = yield* collectTurn(engine.turnEvents);
    expect(turn.end).toBe("eof");
    expect(turn.text).toContain("seen=[{subject}]");
    expect(turn.text).not.toContain("seen=[core]");
  });
});
