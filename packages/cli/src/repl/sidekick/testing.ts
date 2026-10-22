import { allSettled, ensure, Err, Ok, scoped, spawn } from "effection";
import type { Operation, Result, Scope, Task } from "effection";
import { Stdio } from "@effectionx/process";
import { forEach } from "@effectionx/stream-helpers";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  Component,
  Execution,
  SecretDetectedError,
  SecretScannerError,
  useNormalizedOutput,
} from "@executablemd/core";
import { executeInstalled } from "@executablemd/core/host";
import type { ExecutionInstallation } from "@executablemd/core/host";
import { API, asFilesFatal } from "@executablemd/runtime";
import {
  InMemoryStream,
  DurablePersistenceError,
  DivergenceError,
  StaleInputError,
  TerminalDivergenceError,
  ContinuePastCloseDivergenceError,
} from "@executablemd/durable-streams";
import { useTesting, testHarnessInstallation } from "@executablemd/testing";
import type { TestResult } from "@executablemd/testing";
import { installTestAgentComponents } from "@executablemd/test-agent";
import { installAgentComponents } from "@executablemd/core";
import { resolveTestTarget } from "../../test-target.ts";
import type { ReplExecutionProfile } from "../../repl-profile.ts";

type TestStatus = "passed" | "failed" | "no-tests";
type CompletedTest = {
  status: "pass" | "fail";
  location: string;
  name?: string;
  error?: {
    kind: "assertion" | "timeout" | "teardown" | "error";
    message: string;
    actual?: string;
    expected?: string;
  };
};
type TestDocumentReport = {
  path: string;
  status: TestStatus;
  tests: CompletedTest[];
  error: { name: string; message: string } | null;
  report: string;
};
export type ReplTestReport = { path: string; status: TestStatus; documents: TestDocumentReport[] };
export type ReplTesting = (path: string) => Operation<Result<ReplTestReport>>;

export function replTesting(
  host: Scope,
  profile: ReplExecutionProfile,
  workspace: string | undefined,
  harness?: (includes: readonly string[]) => Operation<ExecutionInstallation>,
): ReplTesting {
  return (path) =>
    owned(host, function* () {
      if (workspace === undefined) {
        return Err(new Error("this execution has no session workspace for testing"));
      }
      const selected = resolve(workspace, path);
      const local = relative(workspace, selected);
      if (
        path.trim() === "" ||
        isAbsolute(path) ||
        local === ".." ||
        local.startsWith(`..${sep}`)
      ) {
        return Err(
          new Error(
            "REPL.Test path must be a non-empty session-relative path that stays in the session workspace",
          ),
        );
      }
      let documents: readonly string[];
      try {
        const target = yield* resolveTestTarget(selected, ["**/*.test.md"]);
        documents =
          target.kind === "file"
            ? [target.path]
            : target.documents.map((document) => document.path);
      } catch (error) {
        const fatal = fatalFailure(error);
        if (fatal !== undefined) {
          throw fatal;
        }
        return Err(error);
      }
      const reports: TestDocumentReport[] = [];
      for (const document of documents) {
        reports.push(
          yield* owned(host, function* () {
            yield* API.Env.around({
              *cwd() {
                return workspace;
              },
            });
            yield* useNormalizedOutput();
            let nativeOutput = "";
            const stdout = new TextDecoder();
            const stderr = new TextDecoder();
            yield* Stdio.around(
              {
                *stdout([bytes]) {
                  nativeOutput += stdout.decode(bytes, { stream: true });
                },
                *stderr([bytes]) {
                  nativeOutput += stderr.decode(bytes, { stream: true });
                },
              },
              { at: "min" },
            );
            let reachedPolicy = false;
            let acceptedPolicy = false;
            yield* Execution.around({
              *execute([request], next) {
                request.addCompletionFailure(() => {
                  reachedPolicy = true;
                  return undefined;
                });
                yield* next(request);
              },
            });
            const testing = yield* useTesting();
            yield* Execution.around({
              *execute([request], next) {
                yield* next(request);
                request.addCompletionFailure(() => {
                  acceptedPolicy = true;
                  return undefined;
                });
              },
            });
            yield* installTestAgentComponents();
            yield* installAgentComponents();
            const installations = [
              ...profile.installations,
              harness === undefined ? testHarnessInstallation() : yield* harness(profile.includes),
            ];
            yield* Component.around({ generated: (_args, next) => next() ?? profile.generated });
            const execution = yield* executeInstalled(
              { path: document, includes: [...profile.includes], stream: new InMemoryStream() },
              installations,
            );
            const draining = yield* spawn(() =>
              forEach(function* (_chunk: string) {}, execution.output),
            );
            const outcome = yield* execution;
            const rendered = yield* draining;
            const report = nativeOutput + stdout.decode() + stderr.decode() + rendered;
            const tests = (yield* testing.results).map(detachTest);
            if (!outcome.ok) {
              const fatal = fatalFailure(outcome.error);
              if (fatal !== undefined) {
                throw fatal;
              }
              if (acceptedPolicy) {
                throw outcome.error;
              }
            }
            return {
              path: relative(workspace, document).split(sep).join("/"),
              status:
                outcome.ok && tests.length > 0
                  ? "passed"
                  : reachedPolicy && tests.length === 0
                    ? "no-tests"
                    : "failed",
              tests,
              error: outcome.ok
                ? null
                : { name: outcome.error.name, message: outcome.error.message },
              report,
            };
          }),
        );
      }
      const status =
        reports.length === 0 || reports.every((document) => document.status === "no-tests")
          ? "no-tests"
          : reports.every((document) => document.status === "passed")
            ? "passed"
            : "failed";
      return Ok({ path, status, documents: reports });
    });
}

function owned<T>(host: Scope, work: () => Operation<T>): Operation<T> {
  return scoped(function* () {
    let child: Task<Result<T>> | undefined;
    yield* ensure(function* () {
      if (child !== undefined) {
        yield* child.halt();
      }
    });
    child = host.run(function* () {
      const [result] = yield* allSettled([work()]);
      if (result === undefined) {
        throw new Error("test task produced no result");
      }
      return result;
    });
    const result = yield* child;
    if (!result.ok) {
      throw result.error;
    }
    return result.value;
  });
}

function detachTest(result: TestResult): CompletedTest {
  return {
    status: result.status,
    location: result.location,
    ...(result.name === undefined ? {} : { name: result.name }),
    ...(result.error === undefined
      ? {}
      : {
          error: {
            kind: result.error.kind,
            message: result.error.message,
            ...(result.error.actual === undefined ? {} : { actual: result.error.actual }),
            ...(result.error.expected === undefined ? {} : { expected: result.error.expected }),
          },
        }),
  };
}

function fatalFailure(error: unknown): Error | undefined {
  if (
    error instanceof DurablePersistenceError ||
    error instanceof DivergenceError ||
    error instanceof StaleInputError ||
    error instanceof TerminalDivergenceError ||
    error instanceof ContinuePastCloseDivergenceError ||
    error instanceof SecretDetectedError ||
    error instanceof SecretScannerError
  ) {
    return error;
  }
  const files = asFilesFatal(error);
  if (files !== undefined) {
    return files;
  }
  if (error instanceof AggregateError) {
    for (const cause of error.errors) {
      const fatal = fatalFailure(cause);
      if (fatal !== undefined) {
        return fatal;
      }
    }
  }
  return error instanceof Error && error.cause !== undefined
    ? fatalFailure(error.cause)
    : undefined;
}
