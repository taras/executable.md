/**
 * Tier BE — behavior-engine tests (specs/test-agent-spec.md §Behavior
 * documents): the `<WhenPrompt>` vocabulary driven in-process against a
 * real document execution, with no ACP transport, controller, or worker.
 * Proves stage advancement, capture exposure, mismatch retention, and
 * reaching a second stage through EOF.
 */
import { describe, it } from "@effectionx/bdd/node";
import { expect } from "@effectionx/bdd/expect";
import { ensure, spawn } from "effection";
import type { Operation, Subscription } from "effection";
import { ensureDir, rm, writeTextFile } from "@effectionx/fs";
import { randomUUID } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import { Component, DocumentOutput, execute } from "@executablemd/core";
import { InMemoryStream } from "@executablemd/durable-streams";
import { collectTurn, createTurnBridge } from "../src/worker/bridge.ts";
import type { BridgeEvent } from "../src/worker/bridge.ts";
import type { TemplateMatchResult } from "../src/template.ts";
import { installWhenPromptVocabulary } from "../src/worker/when-prompt.ts";

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
  offer(text: string): Operation<TemplateMatchResult>;
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

  yield* installWhenPromptVocabulary(bridge);
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

  const execution = yield* execute({ docPath, stream, componentDirs: [] });
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

describe("Tier BE — behavior engine", () => {
  it("BE1: a matched prompt advances the stage, exposes captures, and reaches the second stage", function* () {
    const engine = yield* useEngine(REVIEW);

    const init = yield* collectTurn(engine.turnEvents);
    expect(init.end).toBe("suspended");
    expect(init.text.trim()).toBe("");
    expect(init.stage).toContain("Review {?subject} at revision {?revision}");

    const first = yield* engine.offer("Review packages/core at revision abc123");
    expect(first).toEqual({
      ok: true,
      captures: { subject: "packages/core", revision: "abc123" },
    });

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
    expect(mismatch).toMatchObject({ ok: false, kind: "mismatch" });

    const second = yield* engine.offer("Summarize packages/core");
    expect(second.ok).toBe(true);
    const turn2 = yield* collectTurn(engine.turnEvents);
    expect(turn2.text).toContain("The review of **packages/core** passed.");
    expect(turn2.end).toBe("eof");
  });
});
