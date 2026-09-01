/**
 * Run one checked-in Markdown tier suite in process, under the production run
 * host (quest #543, issue #583).
 *
 * The row evidence lives in the tier's `*.test.md` document; this runner only
 * assembles what `xmd test <document>` assembles once the command line has
 * been read — a complete `useTesting()` activation, the host filesystem, and
 * the production `testingExecutionHost()` delivered through
 * `testHarnessInstallation()` — around one `executeInstalled()` call. A
 * launcher that calls this holds no row behavior of its own: it may assert
 * only that the one execution succeeded and that its results are non-empty
 * and all passing.
 *
 * The child host's settings restate `xmd test`'s single-document defaults —
 * the `--include` default and secret detection on — so a document that
 * passes here proves the same assembly the command builds. Output is consumed
 * and discarded: the document's report belongs to its own execution, and a
 * result left unread would hold the completion open.
 */

import { Ok, scoped, useScope } from "effection";
import type { Operation, Result } from "effection";
import { forEach } from "@effectionx/stream-helpers";
import { InMemoryStream } from "@executablemd/durable-streams";
import { useHostFiles } from "@executablemd/runtime";
import type { Json } from "@executablemd/core";
import { executeInstalled } from "@executablemd/core/host";
import { testHarnessInstallation, useTesting } from "@executablemd/testing";
import type { TestResult } from "@executablemd/testing";
import { cliBase, cliRuntime } from "@executablemd/test-support/launch";
import { planComponentDeclaration } from "../../src/plan-component.ts";
import { renderSyntaxMarkdown, syntaxCatalog } from "../../src/syntax.ts";
import { testingExecutionHost } from "../../src/testing-host.ts";
import { useBunService } from "../../src/bun-service.ts";
import { useDenoService } from "../../src/deno-service.ts";
import { useNodeService } from "../../src/node-service.ts";

import { unsupportedRepositories } from "../../src/run-repositories.ts";
/** The native service adapter the entrypoint for this runtime installs. */
const SERVICES = {
  bun: useBunService,
  deno: useDenoService,
  node: useNodeService,
} as const;

export interface MarkdownTierRun {
  /** Exactly what the execution returned, testing completion policy included. */
  readonly completion: Result<Json>;
  /** Completed tests in discovery order, from the session that ran them. */
  readonly results: readonly TestResult[];
}

/**
 * Execute `document` — a path relative to the repository root, where every
 * runtime's test process runs — once, and report how it finished.
 */
export function runMarkdownTier(document: string): Operation<MarkdownTierRun> {
  return scoped(function* () {
    yield* useHostFiles();
    const tests = yield* useTesting();
    const installService = SERVICES[cliRuntime()];
    const testingHost = testingExecutionHost({
      includes: ["components", "."],
      secretDetection: true,
      installService,
      // The same relaunch a runtime-named entrypoint installs, because this
      // harness bypasses `runXmd()` and there is no `API.Env` handler here to
      // ask.
      testAgentWorker: Ok([...cliBase(), "test-agent"]),
      // The run profile's own `<Plan>`, so a child assembled here has the
      // vocabulary a child assembled by `xmd run` has. This harness settles no
      // Agent stack, so a document that writes one resolves the packaged Component
      // and is refused at the ceiling — which is what a host with no coding
      // agent should say, rather than that the component does not exist.
      plan: yield* planComponentDeclaration({
        surface: "component",
        includes: ["components", "."],
        host: yield* useScope(),
        // deno-lint-ignore require-yield
        *installElicitation(): Operation<void> {},
        *catalog(): Operation<string> {
          return renderSyntaxMarkdown(yield* syntaxCatalog(["components", "."]));
        },
      }),
      // This harness runs Markdown tiers, not repository work: a child that
      // asked for a checkout is told there is no provider.
      installRepositories: unsupportedRepositories,
    });
    const execution = yield* executeInstalled({ path: document, stream: new InMemoryStream() }, [
      testHarnessInstallation(testingHost),
    ]);
    yield* forEach(function* () {}, execution.output);
    const completion = yield* execution;
    return { completion, results: yield* tests.results };
  });
}
