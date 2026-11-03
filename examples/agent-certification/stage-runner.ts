import { agentIdentityComponents, Agent } from "@executablemd/core";
import { executeInstalled } from "@executablemd/core/host";
import type { HostExecution } from "@executablemd/core/host";
import { InMemoryStream } from "@executablemd/durable-streams";
import { scoped, spawn, race, sleep, withResolvers, Ok, Err, ensure } from "effection";
import type { Operation, Result } from "effection";
import { fileURLToPath } from "node:url";
import { Stdio } from "@effectionx/process";
import type { ProcessOutcome } from "@executablemd/runtime";
import { command, exec, useQuietProcessOutput } from "@executablemd/runtime";
import { readTextFile, writeTextFile } from "@effectionx/fs";
import { observeQualification, joinQualification } from "./observe.ts";
import { privateStateSchema } from "./state.ts";
import type { QualificationState } from "./state.ts";
import { recordCancellation, recordCleanup, reportSchema } from "./report.ts";
import type { Report } from "./report.ts";

interface Admission {
  open: boolean;
}
export function* settleStage<T>(
  report: Report,
  admission: Admission,
  work: () => Operation<T>,
): Operation<Result<T>> {
  const finished = withResolvers<void>();
  const owner = yield* spawn(function* (): Operation<Result<T>> {
    try {
      return Ok(
        yield* joinQualification(report, function* () {
          try {
            return yield* work();
          } finally {
            finished.resolve();
          }
        }),
      );
    } catch (error) {
      return Err(error instanceof Error ? error : new Error("Scenario failed"));
    }
  });
  yield* finished.operation;
  const settled = yield* race(
    [
      function* () {
        yield* owner;
        return true;
      },
      function* () {
        yield* sleep(30_000);
        return false;
      },
    ].map((operation) => operation()),
  );
  if (!settled) {
    admission.open = false;
  }
  const result = yield* owner;
  if (!result.ok) {
    admission.open = false;
  }
  return result;
}

function schedule(state: QualificationState) {
  const selected = (name: keyof Report["capabilities"]) => state.report.capabilities[name].selected;
  const seed =
    [
      "authentication",
      "streaming",
      "completion",
      "continuity",
      "separation",
      "reconnect",
      "resume",
    ].some((name) => state.configuration.scenarios.includes(reportCapability(name))) ||
    (selected("model") && state.configuration.model !== undefined) ||
    (selected("effort") && state.configuration.effort !== undefined);
  return {
    seed,
    recall: selected("continuity"),
    separation: selected("separation"),
    reconnect: selected("reconnect"),
    cancellation: selected("cancellation"),
    resume: selected("resume"),
  };
}
function reportCapability(name: string) {
  return privateStateSchema.shape.configuration.shape.scenarios.element.parse(name);
}

function* runDocument(
  state: QualificationState,
  stage: "initial" | "reconnect" | "cancel",
  flags: ReturnType<typeof schedule>,
  directory: string,
): Operation<boolean> {
  return yield* scoped(function* () {
    const journal = new InMemoryStream();
    const started = withResolvers<void>();
    const ended = withResolvers<void>();
    let active = false;
    let requested = false;
    let terminal = false;
    let execution: HostExecution | undefined;
    let stopSucceeded = false;
    yield* Agent.around({
      *agent(args, next) {
        try {
          return yield* next(...args);
        } catch (error) {
          for (const name of ["authentication", "streaming", "completion"] satisfies (
            | "authentication"
            | "streaming"
            | "completion"
          )[]) {
            const row = state.report.capabilities[name];
            if (row.selected && row.outcome === "not_run") {
              row.outcome = "failure";
              row.reason = "agent-unavailable";
            }
          }
          throw error;
        }
      },
    });
    yield* observeQualification(state.report, (event) => {
      if (event.type === "started") {
        state.turn.accepted = true;
        state.turn.identity = event.session.agentSessionId;
        active = true;
        started.resolve();
      } else if (event.type === "terminal") {
        state.turn.completed = event.status === "completed";
        terminal = true;
        active = false;
      }
    });
    const owner = yield* spawn(function* () {
      try {
        return yield* race(
          [
            function* () {
              execution = yield* executeInstalled(
                {
                  path: fileURLToPath(new URL(`stages/${stage}.md`, import.meta.url)),
                  stream: journal,
                  includes: [fileURLToPath(new URL("components", import.meta.url))],
                  props: { configuration: state.configuration, names: state.names, ...flags },
                },
                [{ components: agentIdentityComponents() }],
              );
              const output = yield* execution.output;
              let next = yield* output.next();
              while (!next.done) {
                next = yield* output.next();
              }
              const result = yield* execution;
              if (!result.ok) {
                yield* writeTextFile(
                  `${directory}/${stage}-failure.txt`,
                  result.error.stack ?? result.error.message,
                );
              }
              return result.ok;
            },
            function* (): Operation<boolean> {
              yield* sleep(60_000);
              throw new Error("Scenario deadline");
            },
          ].map((operation) => operation()),
        );
      } finally {
        ended.resolve();
      }
    });
    if (stage === "cancel") {
      const began = yield* race(
        [
          function* () {
            yield* started.operation;
            return true;
          },
          function* () {
            yield* ended.operation;
            return false;
          },
        ].map((operation) => operation()),
      );
      if (began) {
        const elapsed = yield* race(
          [
            function* () {
              yield* sleep(5000);
              return true;
            },
            function* () {
              yield* ended.operation;
              return false;
            },
          ].map((operation) => operation()),
        );
        if (elapsed && active && !terminal && execution !== undefined) {
          requested = true;
          stopSucceeded = (yield* execution.stop()).ok;
          yield* owner;
        }
      }
      const cancelled = journal
        .snapshot()
        .some((event) => event.type === "close" && event.result.status === "cancelled");
      recordCancellation(state.report, {
        requestedStop: requested,
        activeAtStop: requested,
        attributed: requested && stopSucceeded && cancelled,
        completed: state.turn.completed,
        ownerJoined: true,
        nativeCleanupVerified: false,
      });
      if (requested) {
        return stopSucceeded && cancelled;
      }
    }
    return yield* owner;
  });
}

function* runJoinedChild(argv: string[]): Operation<ProcessOutcome> {
  let admitted = false;
  let result: ProcessOutcome | undefined;
  yield* scoped(function* () {
    // Once admitted, resume follows its own CLI deadline even if the outer owner is halted.
    yield* ensure(function* () {
      if (admitted) {
        result = yield* exec({ command: argv, retain: true });
      }
    });
    admitted = true;
  });
  if (result === undefined) {
    throw new Error("Resume was not admitted");
  }
  return result;
}

export function* runSequence(state: QualificationState, directory: string): Operation<void> {
  const flags = schedule(state);
  const plannedTurns =
    Number(flags.seed) +
    Number(flags.recall) +
    Number(flags.separation) +
    Number(flags.reconnect) +
    Number(flags.cancellation) +
    Number(flags.resume);
  if (plannedTurns > 6) {
    throw new Error("Qualification exceeds the authorized turn ceiling");
  }
  const admission: Admission = { open: true };
  const start = Date.now();
  for (const stage of ["initial", "reconnect", "cancel", "resume"] satisfies (
    | "initial"
    | "reconnect"
    | "cancel"
    | "resume"
  )[]) {
    const selected =
      stage === "initial" ? flags.seed : stage === "cancel" ? flags.cancellation : flags[stage];
    if (!selected) {
      continue;
    }
    if (!admission.open || Date.now() - start >= 600_000) {
      break;
    }
    if (
      (stage === "reconnect" || stage === "resume") &&
      (!state.seedAccepted || state.identity === undefined)
    ) {
      continue;
    }
    state.turn = { accepted: false, completed: false };
    const result = yield* settleStage(state.report, admission, function* () {
      if (stage === "resume") {
        const input = `${directory}/resume-input.json`;
        const output = `${directory}/resume-output.json`;
        yield* writeTextFile(input, JSON.stringify(state));
        yield* useQuietProcessOutput();
        yield* Stdio.around(
          {
            *stderr() {
              return;
            },
          },
          { at: "min" },
        );
        const argv = yield* command([
          "run",
          fileURLToPath(new URL("stages/resume.md", import.meta.url)),
          "--include",
          fileURLToPath(new URL("components", import.meta.url)),
          "--props-input",
          input,
          "--props-output",
          output,
          "--deny-all",
          "--timeout",
          "60s",
          "--raw",
        ]);
        const child = yield* runJoinedChild(argv);
        yield* writeTextFile(`${directory}/resume-stdout.txt`, child.stdout ?? "");
        yield* writeTextFile(`${directory}/resume-stderr.txt`, child.stderr ?? "");
        const fragment = privateStateSchema.parse(JSON.parse(yield* readTextFile(output)));
        Object.assign(state.report, fragment.report);
        if (child.exitCode !== 0) {
          return false;
        }
        return true;
      }
      return yield* runDocument(state, stage, flags, directory);
    });
    if (!result.ok || !result.value) {
      if (!result.ok) {
        yield* writeTextFile(
          `${directory}/${stage}-owner-failure.txt`,
          result.error.stack ?? result.error.message,
        );
      }
      admission.open = false;
      state.report.exitState = "failed";
      state.failure = new Error("Qualification scenario failed; see capability matrix");
    }
  }
  recordCleanup(
    state.report,
    true,
    false,
    state.report.capabilities.cleanup.reason === "cleanup-failed",
  );
  reportSchema.parse(state.report);
}
