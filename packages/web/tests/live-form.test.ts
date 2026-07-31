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

/** The port a form bound, captured from the URL its opener was handed. */
function capturingOpener(seen: { url?: string }): Operation<void> {
  return FormOpener.around({
    // deno-lint-ignore require-yield
    *open([url]) {
      seen.url = url;
    },
  });
}

function portOf(url: string): number {
  return Number(new URL(url).port);
}

describe("liveForm: the assembled scope", () => {
  /**
   * The lower-level PRs proved each resource cleans up on its own. What this
   * proves is that the operation which assembles them owns them: after an answer,
   * the listener that served it is gone.
   */
  it("releases its listener once an answer has been returned", function* () {
    const seen: { url?: string } = {};

    const answer = yield* scoped(function* (): Operation<Json> {
      yield* fixtureAssets();
      yield* capturingOpener(seen);
      yield* FormResponder.around({
        *respond([url]) {
          yield* submitForm(url, { decision: "approve" });
        },
      });

      return yield* liveForm({ schema: REVIEW_SCHEMA, content: CONTENT });
    });

    expect(answer).toEqual({ decision: "approve" });
    if (!seen.url) {
      throw new Error("the opener was never given a URL");
    }
    expect(yield* portRefuses(portOf(seen.url))).toBe(true);
  });

  /**
   * A responder that throws is the form failing, and it must take the listener
   * with it rather than leave a port bound behind a failed operation.
   */
  it("dismantles everything when the responder fails", function* () {
    const seen: { url?: string } = {};
    let raised = "";

    yield* scoped(function* () {
      yield* fixtureAssets();
      yield* capturingOpener(seen);
      yield* FormResponder.around({
        // deno-lint-ignore require-yield
        *respond() {
          throw new Error("the responder failed");
        },
      });

      try {
        yield* liveForm({ schema: REVIEW_SCHEMA, content: CONTENT });
      } catch (error) {
        raised = error instanceof Error ? error.message : String(error);
      }
    });

    expect(raised).toContain("the responder failed");
    if (!seen.url) {
      throw new Error("the opener was never given a URL");
    }
    expect(yield* portRefuses(portOf(seen.url))).toBe(true);
  });

  /**
   * Interruption, not completion. A form is normally torn down while it is still
   * waiting — the workflow around it was halted — so the halt is observed and the
   * injected work is proved to have cleaned up, not merely to have stopped being
   * scheduled.
   */
  it("releases everything when the owning task is halted mid-wait", function* () {
    const serving = withResolvers<string>();
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
            // A person who never answers.
            yield* suspend();
          } finally {
            responderCleaned.resolve();
          }
        },
      });

      yield* liveForm({ schema: REVIEW_SCHEMA, content: CONTENT });
    });

    // Synchronized on the server actually serving and the opener actually running.
    const url = yield* serving.operation;
    expect(yield* portRefuses(portOf(url))).toBe(false);

    yield* owner.halt();

    // Both injected operations ran their cleanup, and the port is gone.
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
