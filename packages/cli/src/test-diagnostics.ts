/**
 * What `xmd test` reports while it runs, and what it keeps when a test fails
 * (specs/testing-spec.md, "Progress and failure journals").
 *
 * Two diagnostics, both owned by the command and neither part of the report a
 * document renders:
 *
 * - **Progress** is a stream of plain lines on stderr, written as work starts
 *   and settles: each test, each executable element and each command block,
 *   named and located, then the test's final outcome once its teardown has
 *   joined. It names things and places; it never carries a captured value, a
 *   prop, command text or anything a document rendered.
 * - **Failure journals** are the in-memory journals of a failed root document
 *   and of each failed nested `<Execution>` child, saved as JSONL once that
 *   execution's owner has unwound. A passing run creates no file.
 *
 * One value of this module is captured by the command before any document code
 * runs and is handed to nested children through the trusted host settings, so
 * a child's records and files are this command's and no Context or profile a
 * document can reach selects them.
 */

import { createQueue, each, ensure, Ok, resource, spawn, useScope } from "effection";
import type { Operation, Result, Scope } from "effection";
import { ensureDir, writeTextFile } from "@effectionx/fs";
import { cwd, env } from "@executablemd/runtime";
import { Component, getExpansion, TestBehavior } from "@executablemd/core";
import type { CodeBlockContext, Modifier, SourcePosition } from "@executablemd/core";
import type { ComponentExpansionRequest } from "@executablemd/core/api";
import { serializeDurableEvent } from "@executablemd/durable-streams";
import type { DurableEvent } from "@executablemd/durable-streams";
import { Test, testing } from "@executablemd/testing";
import type { FailureJournalHost, TestResult } from "@executablemd/testing";
import { randomUUID } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";
import { deliverWhole } from "./stdout-delivery.ts";
import type { DeliverySink } from "./stdout-delivery.ts";

/** The variable that names where failure journals are written. */
const TEST_ARTIFACTS_VARIABLE = "XMD_TEST_ARTIFACTS";

/** Where failure journals go when the variable names nowhere. */
const DEFAULT_TEST_ARTIFACTS = join(".xmd", "test-artifacts");

const PREFIX = "[xmd test]";

/** This command's diagnostics, shared by its root documents and their children. */
export interface TestDiagnostics {
  /**
   * The diagnostics of one execution this command owns.
   *
   * `source` is the document reference the execution runs, for the reader;
   * the file each execution saves is named by its own position in this
   * command, so two executions never share one.
   */
  execution(kind: "root" | "child", source: string): ExecutionDiagnostics;
  /** The first failure to deliver a progress line, or `Ok` when none failed. */
  delivery(): Result<void>;
}

/** What one execution is observed and preserved through. */
export interface ExecutionDiagnostics {
  /**
   * Observe this execution's tests, elements and command blocks.
   *
   * Installed in the host scope before the testing package, because the
   * testing behavior answers `<Test>` without delegating and an observer
   * installed nearer the document would never be reached.
   */
  observe(): Operation<void>;
  /** Saves this execution's journal when `failed` says its outcome failed. */
  journal<T>(failed: (value: T) => boolean): FailureJournalHost<T>;
}

/**
 * The invocation directory this command's failure journals would go to.
 *
 * Read once, before any document runs, and created only when a journal is
 * saved. A fresh directory per invocation keeps concurrent commands sharing
 * one artifact root from writing over each other.
 */
function* artifactDirectory(): Operation<string> {
  const configured = yield* env(TEST_ARTIFACTS_VARIABLE);
  const base =
    configured !== undefined && configured.length > 0 ? configured : DEFAULT_TEST_ARTIFACTS;
  const root = isAbsolute(base) ? base : resolve(yield* cwd(), base);
  const stamp = new Date().toISOString().replaceAll(":", "-");
  return join(root, `${stamp}-${randomUUID()}`);
}

/**
 * Open this command's diagnostics, writing progress to `sink`.
 *
 * One writer serializes every line in the order it was accepted. Closing the
 * diagnostics drains what was accepted before it returns — on success, failure
 * and cancellation alike — and nothing is written after that.
 */
export function useTestDiagnostics(sink: DeliverySink): Operation<TestDiagnostics> {
  return resource(function* (provide) {
    const directory = yield* artifactDirectory();
    const owner = yield* useScope();
    const lines = createQueue<string, void>();
    let delivery: Result<void> = Ok(undefined);
    let open = true;
    const emit = (line: string): void => {
      if (open) {
        lines.add(`${PREFIX} ${line}\n`);
      }
    };

    const writer = yield* spawn(function* () {
      for (let next = yield* lines.next(); !next.done; next = yield* lines.next()) {
        const written = yield* deliverWhole(next.value, sink);
        if (!written.ok && delivery.ok) {
          delivery = written;
        }
      }
    });
    yield* ensure(function* () {
      open = false;
      lines.close();
      yield* writer;
    });

    const counts = { root: 0, child: 0 };
    yield* provide({
      execution(kind, source) {
        counts[kind] += 1;
        const label = `${kind} ${counts[kind]}`;
        const file = join(directory, `${kind}-${counts[kind]}.jsonl`);
        const context = kind === "root" ? "" : `${label} ${source}: `;
        return {
          observe: () => observe(owner, (line) => emit(`${context}${line}`)),
          journal: <T>(failed: (value: T) => boolean): FailureJournalHost<T> => ({
            failed,
            *save(events: readonly DurableEvent[]) {
              yield* ensureDir(directory);
              yield* writeTextFile(file, events.map(serializeDurableEvent).join(""));
              emit(`journal saved: ${file} (${label} ${source})`);
            },
            // deno-lint-ignore require-yield
            *reportSaveFailure(error: Error) {
              emit(`journal not saved for ${label} ${source}: ${error.message}`);
            },
          }),
        };
      },
      delivery: () => delivery,
    });
  });
}

/** `path:line:column`, `line:column`, or `unknown`, as test results write it. */
function located(position: Readonly<SourcePosition> | undefined): string {
  if (position === undefined) {
    return "unknown";
  }
  const at = `${position.line}:${position.column}`;
  return position.path ? `${position.path}:${at}` : at;
}

/** A command block, by its language and modifier words — never its body or parameters. */
function blockName(
  modifiers: readonly Modifier[],
  block: CodeBlockContext,
  bound: boolean,
): string {
  const words = modifiers.map((modifier) => modifier.name);
  return [block.language, ...words, ...(bound ? ["as"] : [])].join(" ");
}

/** One test being observed, from its start to its recorded outcome. */
interface ObservedTest {
  name: string | undefined;
  interrupted?: string;
}

/**
 * Observe one execution, reporting through `report`.
 *
 * Subscriptions run in `owner`, the command's diagnostics scope, because an
 * element's terminal phase is published after the handler that saw it begin
 * has already unwound. Every request is delegated once, as it arrived.
 */
function* observe(owner: Scope, report: (line: string) => void): Operation<void> {
  const tests = new Map<string, ObservedTest[]>();
  let current: ObservedTest | undefined;

  const interrupted = (test: ObservedTest | undefined, what: string): void => {
    if (test !== undefined && test.interrupted === undefined) {
      test.interrupted = what;
    }
  };

  const watch = (what: string, request: ComponentExpansionRequest): void => {
    const test = current;
    owner.run(function* () {
      let started = false;
      for (const phase of yield* each(request.phases)) {
        if (!started) {
          started = true;
          report(`start ${what}`);
        }
        if (phase.phase === "complete") {
          report(`${phase.result.ok ? "done" : "failed"} ${what}`);
        } else if (phase.phase === "cancelled") {
          interrupted(test, what);
          report(`cancelled ${what}`);
        }
        yield* each.next();
      }
    });
  };

  function* block<T>(what: string, work: () => Operation<T>): Operation<T> {
    const test = current;
    report(`start ${what}`);
    let settled = false;
    try {
      const value = yield* work();
      settled = true;
      report(`done ${what}`);
      return value;
    } catch (error) {
      settled = true;
      report(`failed ${what}`);
      throw error;
    } finally {
      if (!settled) {
        interrupted(test, what);
        report(`cancelled ${what}`);
      }
    }
  }

  const finished = (result: TestResult): void => {
    const observed = tests.get(result.location);
    // A predecessor can record after the next same-site test has run. Match
    // its name too; identical names at that site record in discovery order.
    const index = observed?.findIndex((test) => test.name === result.name) ?? -1;
    const test = index < 0 ? undefined : observed?.splice(index, 1)[0];
    if (observed?.length === 0) {
      tests.delete(result.location);
    }
    const name = result.name === undefined ? "test" : `test ${JSON.stringify(result.name)}`;
    if (result.status === "pass") {
      report(`pass ${name} at ${result.location}`);
      return;
    }
    const why = [
      result.error?.kind ?? "error",
      ...(test?.interrupted === undefined ? [] : [`interrupted ${test.interrupted}`]),
    ];
    report(`fail ${name} at ${result.location} (${why.join("; ")})`);
  };

  yield* Component.around({
    *expand([request], next) {
      // `<Test>` is reported by its behavior and its recorded result, which
      // know whether it is a test at all and how it finally ended.
      if (request.expansion.name !== "Test") {
        watch(`${request.expansion.name} at ${located(request.expansion.position)}`, request);
      }
      yield* next(request);
    },
    *applyModifiers([modifiers, context], next) {
      const what = `${blockName(modifiers, context, false)} at ${located(context.position)}`;
      return yield* block(what, () => next(modifiers, context));
    },
    *applyBoundModifiers([modifiers, context], next) {
      const what = `${blockName(modifiers, context, true)} at ${located(context.position)}`;
      return yield* block(what, () => next(modifiers, context));
    },
  });
  yield* TestBehavior.around({
    *test([props], next) {
      // The same two answers the behavior reads before it runs anything: a
      // test that is skipped or nested inside another is not a test start.
      if ((yield* testing) && !(yield* Test.operations.inTest)) {
        const location = located((yield* getExpansion()).position);
        const name = typeof props.name === "string" ? props.name : undefined;
        const test: ObservedTest = { name };
        const observed = tests.get(location) ?? [];
        observed.push(test);
        tests.set(location, observed);
        const previous = current;
        current = test;
        report(`start test${name === undefined ? "" : ` ${JSON.stringify(name)}`} at ${location}`);
        try {
          return yield* next(props);
        } finally {
          current = previous;
        }
      }
      return yield* next(props);
    },
  });
  yield* Test.around({
    *record([result], next) {
      finished(result);
      yield* next(result);
    },
  });
}
