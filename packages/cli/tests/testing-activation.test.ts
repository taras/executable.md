/**
 * A real workflow installation grants no testing authority.
 *
 * `executeInstalled()` is how a trusted host attaches what an execution needs,
 * and a retained workflow installation is the most privileged thing this
 * repository attaches through it. It decides the run, the definition and the
 * journal — none of which is a testing session — so a document that registered
 * the testing components and answered the public boolean `true` is in exactly
 * the incomplete composition a `<Test>` refuses, however it was launched.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { scoped } from "effection";
import type { Operation } from "effection";
import { createApi } from "@effectionx/context-api";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { DurableEvent } from "@executablemd/durable-streams";
import { inlineSource, registerComponents, useTempFileCompiler } from "@executablemd/core";
import type { Json } from "@executablemd/core";
import { executeInstalled } from "@executablemd/core/host";
import { Git, retainedWorkflowInstallation } from "@executablemd/workflow";
import { installTestingComponents } from "@executablemd/testing";
import type { TestResult } from "@executablemd/testing";

const RUN = Object.freeze({
  runId: "issue-523",
  base: "main",
  pinnedCommit: "9fceb02d0ae598e95dc970b74767f19372d61af8",
});

/** A Git that fails the run if the retained installation consults it. */
function useForbiddenGit(): Operation<void> {
  return Git.around(
    {
      // deno-lint-ignore require-yield
      *revParse([revision]) {
        throw new Error(`Git was consulted for "${revision}"`);
      },
    },
    { at: "min" },
  );
}

/** The public policy surface, reached the way a separately loaded copy reaches it. */
function publicTestPolicy() {
  return createApi<{ testing: boolean; record(result: TestResult): Operation<void> }>("Test", {
    testing: false,
    // deno-lint-ignore require-yield
    *record(_result: TestResult): Operation<void> {},
  });
}

describe("workflow installation and testing activation", () => {
  it("refuses a <Test> the installation did not activate, before its body runs", function* () {
    const sentinels: string[] = [];
    const results: TestResult[] = [];
    const stream = new InMemoryStream();

    const outcome = yield* scoped(function* () {
      yield* useTempFileCompiler();
      yield* useForbiddenGit();
      yield* registerComponents([
        {
          name: "Sentinel",
          origin: "issue-523",
          props: { type: "object", properties: {}, additionalProperties: false },
          // deno-lint-ignore require-yield
          *fn(): Operation<Json> {
            sentinels.push("body");
            return "";
          },
        },
      ]);
      const policy = publicTestPolicy();
      yield* policy.around({
        *record([result], next) {
          results.push(result);
          yield* next(result);
        },
      });

      // The whole of the composition: components registered, testing mode on,
      // and a trusted host installation that is not a testing session.
      yield* installTestingComponents();
      yield* policy.around({ testing: () => true });

      const execution = yield* executeInstalled(
        {
          ...inlineSource('<Test name="t"><Sentinel /><Assert expr={true} /></Test>\n'),
          stream,
        },
        [retainedWorkflowInstallation(RUN)],
      );
      return yield* execution;
    });

    expect(sentinels).toEqual([]);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.message).toContain("complete testing activation");
    }
    expect(results).toEqual([]);

    // The run itself was prepared and journaled; what it holds is the workflow's
    // own record and no test result.
    const events: DurableEvent[] = yield* stream.readAll();
    expect(events.length).toBeGreaterThan(0);
    expect(
      events.filter((event) => event.type === "yield" && event.description.type === "test_result"),
    ).toEqual([]);
  });
});
