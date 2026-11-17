/**
 * What `xmd test` reports while it runs, and what it keeps when a test fails
 * (specs/testing-spec.md, "Progress and failure journals").
 *
 * Two diagnostics, both owned by the command and neither part of the report a
 * document renders:
 *
 * - **Progress** reports each test's start and recorded outcome after teardown,
 *   accepted Execution invocations as they start and settle, and interrupted
 *   operations on timeout or cancellation. Ordinary elements and blocks are
 *   observed without their own lines. It names things and places; it never
 *   carries a captured value, a prop, command text or rendered content.
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
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { deliverWhole } from "./stdout-delivery.ts";
import type { DeliverySink } from "./stdout-delivery.ts";

/** The variable that names where failure journals are written. */
const TEST_ARTIFACTS_VARIABLE = "XMD_TEST_ARTIFACTS";

/** Where failure journals go when the variable names nowhere. */
const DEFAULT_TEST_ARTIFACTS = join(".xmd", "test-artifacts");

const PREFIX = "[xmd test]";

/** The repository test declaration that owns an automatic journal. */
export interface JournalCase {
  readonly owner: string;
  readonly name: string;
  readonly suite?: string;
}

/** This command's diagnostics, shared by its root documents and their children. */
export interface TestDiagnostics {
  /**
   * The diagnostics of one execution this command owns.
   *
   * `source` is the document reference the execution runs, for the reader;
   * the file each execution saves is named by its own position in this
   * command, so two executions never share one.
   */
  execution(kind: "root" | "child", source: string, profile?: string): ExecutionDiagnostics;
  /** The first failure to deliver a progress line, or `Ok` when none failed. */
  delivery(): Result<void>;
  /** Counts recorded by root documents. Nested execution results are evidence. */
  results(): Readonly<{ pass: number; fail: number }>;
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
  /**
   * Saves journal files a host wrote for this execution, with their original
   * text, beneath one directory named like this execution's journal.
   *
   * `path` is each file's place beneath the storage root, so two files of one
   * root keep the names that tell them apart.
   */
  saveFiles(files: readonly SavedJournalFile[]): Operation<void>;
}

/** One journal file as its host wrote it. */
export interface SavedJournalFile {
  readonly path: string;
  readonly text: string;
}

/**
 * The invocation directory this command's failure journals would go to.
 *
 * Read once, before any document runs, and created only when a journal is
 * saved. A fresh directory per invocation keeps concurrent commands sharing
 * one artifact root from writing over each other.
 */
function* artifactDirectory(working: string): Operation<string> {
  const configured = yield* env(TEST_ARTIFACTS_VARIABLE);
  const base =
    configured !== undefined && configured.length > 0 ? configured : DEFAULT_TEST_ARTIFACTS;
  const root = isAbsolute(base) ? base : resolve(working, base);
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
export function* useTestDiagnostics(
  sink: DeliverySink,
  mode?: JournalCase | boolean,
): Operation<TestDiagnostics> {
  const testCase = typeof mode === "boolean" ? undefined : mode;
  return yield* (yield* prepareTestDiagnostics(sink, testCase, mode === true))();
}

/** Capture the artifact location before work whose diagnostics open after it joins. */
export function* prepareTestDiagnostics(
  sink: DeliverySink,
  testCase?: JournalCase,
  failuresOnly = false,
): Operation<() => Operation<TestDiagnostics>> {
  const working = yield* cwd();
  const directory = yield* artifactDirectory(working);
  const shown = relativeTo(working);
  const attribution = testCase === undefined ? undefined : { ...testCase };
  return () => testDiagnosticsAt(sink, directory, shown, attribution, failuresOnly);
}

function testDiagnosticsAt(
  sink: DeliverySink,
  directory: string,
  shown: (source: string) => string,
  attribution: JournalCase | undefined,
  failuresOnly: boolean,
): Operation<TestDiagnostics> {
  return resource(function* (provide) {
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
    const results = { pass: 0, fail: 0 };
    yield* provide({
      execution(kind, source, profile) {
        const ordinal = ++counts[kind];
        const stem = join(directory, `${kind}-${ordinal}`);
        const file = `${stem}.jsonl`;
        const displayedSource = shown(source);
        const named = `${kind} ${ordinal} ${displayedSource}${profile === undefined ? "" : ` (${profile})`}`;
        const context = kind === "root" ? "" : `${named}: `;
        function* identify(files?: readonly string[]): Operation<void> {
          yield* ensureDir(directory);
          if (attribution !== undefined) {
            yield* writeTextFile(
              `${stem}.case.json`,
              JSON.stringify({
                ...attribution,
                kind,
                ordinal,
                source: displayedSource,
                profile,
                files,
              }) + "\n",
            );
          }
        }
        return {
          observe: () =>
            observe(
              owner,
              shown,
              (line, failure = false) => {
                if (!failuresOnly || failure) {
                  emit(`${context}${line}`);
                }
              },
              (status) => {
                if (kind === "root") {
                  results[status] += 1;
                }
              },
            ),
          journal: <T>(failed: (value: T) => boolean): FailureJournalHost<T> => ({
            failed,
            *save(events: readonly DurableEvent[]) {
              yield* identify();
              yield* writeTextFile(file, events.map(serializeDurableEvent).join(""));
              emit(`journal saved: ${file} (${named})`);
            },
            // deno-lint-ignore require-yield
            *reportSaveFailure(error: Error) {
              emit(`journal not saved for ${named}: ${error.message}`);
            },
          }),
          *saveFiles(files: readonly SavedJournalFile[]) {
            yield* identify(files.map(({ path }) => path));
            for (const { path, text } of files) {
              const target = join(stem, path);
              yield* ensureDir(dirname(target));
              yield* writeTextFile(target, text);
            }
            emit(`journal saved: ${stem} (${named})`);
          },
        };
      },
      delivery: () => delivery,
      results: () => results,
    });
  });
}

/** Display in-root absolute paths relative to the command's captured directory. */
function relativeTo(working: string): (path: string) => string {
  return (path) => {
    if (!isAbsolute(path)) {
      return path;
    }
    const inside = relative(working, path);
    const outside =
      inside === "" || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside);
    return outside ? path : inside;
  };
}

/** `path:line:column`, `line:column`, or `unknown`, as test results write it. */
function located(
  position: Readonly<SourcePosition> | undefined,
  shown: (path: string) => string = (path) => path,
): string {
  if (position === undefined) {
    return "unknown";
  }
  const at = `${position.line}:${position.column}`;
  return position.path ? `${shown(position.path)}:${at}` : at;
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
  shown: string;
  recorded?: boolean;
  interrupted?: string;
}

/**
 * Observe one execution, reporting through `report`.
 *
 * Subscriptions run in `owner`, the command's diagnostics scope, because an
 * element's terminal phase is published after the handler that saw it begin
 * has already unwound. Every request is delegated once, as it arrived.
 */
function* observe(
  owner: Scope,
  shown: (path: string) => string,
  report: (line: string, failure?: boolean) => void,
  record: (status: TestResult["status"]) => void,
): Operation<void> {
  const tests = new Map<string, ObservedTest[]>();
  let current: ObservedTest | undefined;

  const interrupted = (test: ObservedTest | undefined, what: string): void => {
    if (test !== undefined && test.interrupted === undefined) {
      test.interrupted = what;
    }
  };

  const watch = (what: string, request: ComponentExpansionRequest, milestone: boolean): void => {
    const test = current;
    owner.run(function* () {
      let active = false;
      for (const phase of yield* each(request.phases)) {
        if (milestone && phase.phase === "active") {
          active = true;
          report(`start ${what}`);
        }
        if (phase.phase === "complete") {
          if (active) {
            report(`${phase.result.ok ? "done" : "failed"} ${what}`, !phase.result.ok);
          }
        } else if (phase.phase === "cancelled") {
          interrupted(test, what);
          if (active) {
            report(`cancelled ${what}`, true);
          }
        }
        yield* each.next();
      }
    });
  };

  function* block<T>(what: string, work: () => Operation<T>): Operation<T> {
    const test = current;
    let settled = false;
    try {
      const value = yield* work();
      settled = true;
      return value;
    } catch (error) {
      settled = true;
      throw error;
    } finally {
      if (!settled) {
        interrupted(test, what);
      }
    }
  }

  const finished = (result: TestResult): void => {
    const observed = tests.get(result.location);
    // A predecessor can record after the next same-site test has run. Match
    // its name too; identical names at that site record in discovery order.
    const index = observed?.findIndex((test) => test.name === result.name) ?? -1;
    const test = index < 0 ? undefined : observed?.splice(index, 1)[0];
    if (test !== undefined) {
      test.recorded = true;
    }
    if (observed?.length === 0) {
      tests.delete(result.location);
    }
    const name = result.name === undefined ? "test" : `test ${JSON.stringify(result.name)}`;
    const where = test?.shown ?? shown(result.location);
    if (result.status === "pass") {
      report(`pass ${name} at ${where}`);
      return;
    }
    const why = [
      result.error?.kind ?? "error",
      ...(test?.interrupted === undefined ? [] : [`interrupted ${test.interrupted}`]),
    ];
    report(`fail ${name} at ${where} (${why.join("; ")})`, true);
  };

  yield* Component.around({
    *expand([request], next) {
      // `<Test>` is reported by its behavior and its recorded result, which
      // know whether it is a test at all and how it finally ended.
      if (request.expansion.name !== "Test") {
        watch(
          `${request.expansion.name} at ${located(request.expansion.position, shown)}`,
          request,
          request.expansion.name === "Execution",
        );
      }
      yield* next(request);
    },
    *applyModifiers([modifiers, context], next) {
      const what = `${blockName(modifiers, context, false)} at ${located(context.position, shown)}`;
      return yield* block(what, () => next(modifiers, context));
    },
    *applyBoundModifiers([modifiers, context], next) {
      const what = `${blockName(modifiers, context, true)} at ${located(context.position, shown)}`;
      return yield* block(what, () => next(modifiers, context));
    },
  });
  yield* TestBehavior.around({
    *test([props], next) {
      // The same two answers the behavior reads before it runs anything: a
      // test that is skipped or nested inside another is not a test start.
      if ((yield* testing) && !(yield* Test.operations.inTest)) {
        const position = (yield* getExpansion()).position;
        const location = located(position);
        const name = typeof props.name === "string" ? props.name : undefined;
        const test: ObservedTest = { name, shown: located(position, shown) };
        const observed = tests.get(location) ?? [];
        observed.push(test);
        tests.set(location, observed);
        const previous = current;
        current = test;
        const named = name === undefined ? "test" : `test ${JSON.stringify(name)}`;
        report(`start ${named} at ${test.shown}`);
        let settled = false;
        try {
          const value = yield* next(props);
          settled = true;
          return value;
        } catch (error) {
          settled = true;
          throw error;
        } finally {
          current = previous;
          if (!settled && !test.recorded) {
            const detail =
              test.interrupted === undefined ? "" : ` (interrupted ${test.interrupted})`;
            report(`cancelled ${named} at ${test.shown}${detail}`, true);
          }
        }
      }
      return yield* next(props);
    },
  });
  yield* Test.around({
    *record([result], next) {
      finished(result);
      record(result.status);
      yield* next(result);
    },
  });
}
