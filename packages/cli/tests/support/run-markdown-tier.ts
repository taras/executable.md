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

import { Ok, scoped } from "effection";
import type { Operation, Result } from "effection";
import { forEach } from "@effectionx/stream-helpers";
import { InMemoryStream } from "@executablemd/durable-streams";
import { API, useHostFiles } from "@executablemd/runtime";
import { installAgentComponents } from "@executablemd/core";
import type { Json } from "@executablemd/core";
import { installTestAgentComponents, testAgentChildDeclaration } from "@executablemd/test-agent";
import { executeInstalled } from "@executablemd/core/host";
import { testHarnessInstallation, useTesting } from "@executablemd/testing";
import type { TestResult } from "@executablemd/testing";
import { cliBase, cliCommand, cliRuntime } from "@executablemd/test-support/launch";
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
    // How this process re-invokes itself, which only a runtime-named entrypoint
    // knows and this harness bypasses. A scripted child agent is a subprocess,
    // so without it a configured `<TestAgent>` child cannot start one.
    yield* API.Env.around({
      // deno-lint-ignore require-yield
      *command([args]): Operation<string[]> {
        const invocation = cliCommand(args ?? []);
        return [invocation.command, ...invocation.arguments];
      },
    });
    const tests = yield* useTesting();
    // What `xmd test` installs beside the session, in the order it installs
    // them: `<TestAgent>` before the Agent words, so its `<Prompt>` interceptor
    // is the nearer one. A suite that declares a scripted agent for a nested
    // child needs the outer document to be able to write the declaration.
    yield* installTestAgentComponents();
    yield* installAgentComponents();
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
      // vocabulary a child assembled by `xmd run` has. What ceiling it can
      // establish is the child's own answer, settled after that child's
      // configuration has been read: a configured `<TestAgent>` child gets the
      // controlled one, and every other child gets none and is refused at the
      // ceiling — which is what a host with no coding agent should say, rather
      // than that the component does not exist.
      planDeclaration: (request) =>
        planComponentDeclaration({
          surface: "component",
          includes: ["components", "."],
          ceiling: request.ceiling,
          ...(request.authorshipRoot === undefined
            ? {}
            : { authorshipRoot: request.authorshipRoot }),
          host: request.host,
          ...(request.observeAuthorship === undefined
            ? {}
            : { observeAuthorship: request.observeAuthorship }),
          installElicitation: request.installElicitation,
          *catalog(): Operation<string> {
            return renderSyntaxMarkdown(yield* syntaxCatalog(["components", "."]));
          },
        }),
      // This harness runs Markdown tiers, not repository work: a child that
      // asked for a checkout is told there is no provider.
      installRepositories: unsupportedRepositories,
    });
    const execution = yield* executeInstalled({ path: document, stream: new InMemoryStream() }, [
      // The child declarations `xmd test` hands the harness, so a suite can
      // configure a nested run's Agent the way the command lets one.
      testHarnessInstallation(testingHost, [testAgentChildDeclaration()]),
    ]);
    yield* forEach(function* () {}, execution.output);
    const completion = yield* execution;
    return { completion, results: yield* tests.results };
  });
}
