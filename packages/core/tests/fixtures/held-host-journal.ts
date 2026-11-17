import { beforeEach, describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { API, env } from "@executablemd/runtime";
import { all, ensure, scoped, spawn, suspend, withResolvers } from "effection";
import type { Operation } from "effection";
import { join } from "node:path";
import { journalBeforeEach } from "@executablemd/test-support/failure-journal";
import { answerProvider } from "../support/answer-provider.ts";
import { useSelection } from "../support/generated-selection.ts";
import { useHeldHost, withHeldHost } from "../support/held-host.ts";

const OWNER = "packages/core/tests/fixtures/held-host-journal.ts";

function witness(name: string, body: () => Operation<void>): void {
  describe("held host journal " + name, () => {
    beforeEach(function* () {
      const root = yield* env("XMD_TEST_ARTIFACTS");
      if (!root) {
        throw new Error("The held-host journal witness needs an artifact root.");
      }
      yield* API.Env.around({
        *env([variable], next) {
          return variable === "XMD_TEST_ARTIFACTS" ? join(root, name) : yield* next(variable);
        },
      });
    });
    beforeEach(journalBeforeEach(OWNER));
    it(name, body);
  });
}

function* completeOverlappingRoots(): Operation<void> {
  const both = withResolvers<void>();
  let started = 0;
  const closed: string[] = [];
  const sources = ["host/first.md", "host/second.md"];
  yield* all(
    sources.map((path) =>
      (function* () {
        const run = yield* withHeldHost(
          {
            root: { path, source: "<Held />\n" },
            *inside() {
              yield* ensure(() => {
                closed.push(path);
              });
            },
          },
          function* (held) {
            yield* held.started;
            if (++started === sources.length) {
              both.resolve();
            }
            yield* both.operation;
          },
        );
        expect(run.completion.ok).toBe(true);
      })(),
    ),
  );
  expect(closed.sort()).toEqual(sources);
}

witness("passing roots", completeOverlappingRoots);

witness("late assertion", function* () {
  yield* completeOverlappingRoots();
  expect("both held roots joined").toBe("deliberate held-host late assertion");
});

witness("rejected finalizer", function* () {
  let armed = false;
  yield* ensure(() => {
    if (armed) {
      throw new Error("deliberate held-host case teardown");
    }
  });
  yield* scoped(function* () {
    const entered = withResolvers<void>();
    let cleaned = false;
    const held = yield* useHeldHost({
      root: { path: "host/teardown.md", source: "<Held />\n" },
      installations: [
        {
          componentAnswers: [
            answerProvider("Hold", {
              kind: "function",
              name: "Hold",
              props: { type: "object", properties: {}, additionalProperties: false },
              generated: {
                "self-closing": {
                  identity: "https://executable.md/test/journal/hold",
                  effect: "read",
                },
              },
              *fn(): Operation<string> {
                yield* ensure(() => {
                  cleaned = true;
                });
                entered.resolve();
                yield* suspend();
                return "";
              },
            }),
          ],
          *install() {
            yield* useSelection({ Hold: ["self-closing"] });
          },
        },
      ],
    });
    const evaluation = yield* spawn(() =>
      held.execution.evaluateGeneratedXmdRoot({
        id: "held-journal",
        source: "<Hold />",
        allow: ["read"],
      }),
    );
    yield* entered.operation;
    yield* evaluation.halt();
    expect(cleaned).toBe(true);
    held.release();
    expect((yield* held.watched).ok).toBe(true);
  });
  armed = true;
});
