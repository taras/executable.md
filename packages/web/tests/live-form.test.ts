import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { scoped, spawn, suspend, withResolvers } from "effection";
import type { Operation } from "effection";

import { FormAssets } from "../src/assets.ts";
import type { Json } from "../src/json.ts";
import { liveForm } from "../src/live-form.ts";
import { FormOpener } from "../src/opener.ts";
import { FormResponder, submitForm } from "../src/responder.ts";
import { portRefuses, REVIEW_SCHEMA } from "./server-support.ts";

const CONTENT = "<p>Decide.</p>";

function fixtureAssets(): Operation<void> {
  return FormAssets.around({
    // deno-lint-ignore require-yield
    *assets() {
      return { clientJs: "/* fixture */", themeCss: "/* fixture */" };
    },
  });
}

function silentOpener(): Operation<void> {
  return FormOpener.around({
    // deno-lint-ignore require-yield
    *open() {},
  });
}

function portOf(url: string): number {
  return Number(new URL(url).port);
}

describe("liveForm: the assembled scope", () => {
  /**
   * The lower-level PRs proved each resource cleans up on its own. What this
   * proves is that the operation assembling them owns them — and it holds the
   * opener open until the answer arrives, so "the scope halted it" is something
   * the test observes rather than assumes.
   */
  it("halts an active opener and releases its listener before returning", function* () {
    const serving = withResolvers<string>();
    const openerCleaned = withResolvers<void>();
    let cleanedBeforeReturn = false;

    const answer = yield* scoped(function* (): Operation<Json> {
      yield* fixtureAssets();
      yield* FormOpener.around({
        *open([url]) {
          try {
            serving.resolve(url);
            // Still running when the answer arrives, so returning has to halt it.
            yield* suspend();
          } finally {
            openerCleaned.resolve();
            cleanedBeforeReturn = true;
          }
        },
      });
      yield* FormResponder.around({
        *respond([url]) {
          yield* submitForm(url, { decision: "approve" });
        },
      });

      return yield* liveForm({ schema: REVIEW_SCHEMA, content: CONTENT });
    });

    const url = yield* serving.operation;

    expect(answer).toEqual({ decision: "approve" });
    // The opener's cleanup ran as part of returning, not afterwards.
    expect(cleanedBeforeReturn).toBe(true);
    yield* openerCleaned.operation;
    expect(yield* portRefuses(portOf(url))).toBe(true);
  });

  /**
   * A responder that throws is the form failing. The failure must reach the
   * caller only after everything the form started has been dismantled — a
   * failure that outran its own teardown would leave a port bound behind it.
   */
  it("dismantles opener, responder, and listener before the failure propagates", function* () {
    const serving = withResolvers<string>();
    const openerCleaned = withResolvers<void>();
    const responderCleaned = withResolvers<void>();
    let openerCleanedFirst = false;
    let responderCleanedFirst = false;
    let raised = "";

    yield* scoped(function* () {
      yield* fixtureAssets();
      yield* FormOpener.around({
        *open([url]) {
          try {
            serving.resolve(url);
            yield* suspend();
          } finally {
            openerCleaned.resolve();
            openerCleanedFirst = true;
          }
        },
      });
      yield* FormResponder.around({
        // deno-lint-ignore require-yield
        *respond() {
          try {
            throw new Error("the responder failed");
          } finally {
            responderCleaned.resolve();
            responderCleanedFirst = true;
          }
        },
      });

      try {
        yield* liveForm({ schema: REVIEW_SCHEMA, content: CONTENT });
      } catch (error) {
        raised = error instanceof Error ? error.message : String(error);
      }
    });

    const url = yield* serving.operation;

    expect(raised).toContain("the responder failed");
    // Both cleanups had already run by the time the failure was caught.
    expect({ openerCleanedFirst, responderCleanedFirst }).toEqual({
      openerCleanedFirst: true,
      responderCleanedFirst: true,
    });
    yield* openerCleaned.operation;
    yield* responderCleaned.operation;
    expect(yield* portRefuses(portOf(url))).toBe(true);
  });

  /**
   * Interruption, not completion. Both halves are synchronized on separately:
   * waiting only for the opener would leave whether the responder had started at
   * the mercy of the scheduler, and a halt that happened to land first would
   * prove nothing about responder teardown.
   */
  it("releases everything when the owning task is halted mid-wait", function* () {
    const serving = withResolvers<string>();
    const responderActive = withResolvers<void>();
    const openerCleaned = withResolvers<void>();
    const responderCleaned = withResolvers<void>();

    const owner = yield* spawn(function* () {
      yield* fixtureAssets();
      yield* FormOpener.around({
        *open([url]) {
          try {
            serving.resolve(url);
            yield* suspend();
          } finally {
            openerCleaned.resolve();
          }
        },
      });
      yield* FormResponder.around({
        *respond() {
          try {
            responderActive.resolve();
            // A person who never answers.
            yield* suspend();
          } finally {
            responderCleaned.resolve();
          }
        },
      });

      yield* liveForm({ schema: REVIEW_SCHEMA, content: CONTENT });
    });

    // Both are genuinely running before anything is halted.
    const url = yield* serving.operation;
    yield* responderActive.operation;
    expect(yield* portRefuses(portOf(url))).toBe(false);

    yield* owner.halt();

    yield* openerCleaned.operation;
    yield* responderCleaned.operation;
    expect(yield* portRefuses(portOf(url))).toBe(true);
  });

  it("compiles before it serves anything", function* () {
    let served = 0;

    yield* scoped(function* () {
      yield* FormAssets.around({
        // deno-lint-ignore require-yield
        *assets() {
          served += 1;
          return { clientJs: "", themeCss: "" };
        },
      });
      yield* silentOpener();

      let failed = false;
      try {
        // Valid draft-07, unresolvable pointer: only compilation catches it.
        yield* liveForm({
          schema: { type: "object", properties: { a: { $ref: "#/definitions/missing" } } },
          content: CONTENT,
        });
      } catch {
        failed = true;
      }
      expect(failed).toBe(true);
    });

    expect(served).toBe(0);
  });
});
