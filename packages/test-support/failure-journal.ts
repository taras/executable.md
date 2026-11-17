import { createContext, resource, scoped } from "effection";
import type { Operation } from "effection";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { DurableEvent } from "@executablemd/durable-streams";
import { withFailureJournal } from "@executablemd/testing";
import process from "node:process";
import { prepareTestDiagnostics, useTestDiagnostics } from "../cli/src/test-diagnostics.ts";
import type { JournalCase, TestDiagnostics } from "../cli/src/test-diagnostics.ts";
import type { DeliverySink } from "../cli/src/stdout-delivery.ts";
import { CaseOutcome } from "./case-outcome.ts";
import type { CaseSetup } from "./case-outcome.ts";

const CaseJournals = createContext<(source: string) => InMemoryStream>(
  "@executablemd/test-support/case-journals",
);

/**
 * Give ordinary cases fresh attributed roots with one suite setup. For example,
 * the held-host witness registers `beforeEach(journalBeforeEach(OWNER))`. Its
 * fixture selects `request.stream ?? (yield* useJournalStream(document.path))`.
 * Keep explicit replay and private inputs at the fixture that owns them.
 */
export function journalBeforeEach(owner: string): CaseSetup {
  return {
    *setup(): Operation<void> {
      if ((yield* CaseJournals.get()) === undefined) {
        yield* CaseJournals.set(yield* useCaseJournals(owner));
      }
    },
  };
}

function useCaseJournals(owner: string): Operation<(source: string) => InMemoryStream> {
  return resource(function* (provide) {
    const outcome = yield* CaseOutcome.expect();
    const openDiagnostics = yield* prepareTestDiagnostics(process.stderr, {
      owner,
      name: outcome.name,
      suite: outcome.suite,
    });
    const roots: Array<{ source: string; stream: InMemoryStream }> = [];
    try {
      yield* provide((source) => {
        const stream = new InMemoryStream();
        roots.push({ source, stream });
        return stream;
      });
    } finally {
      // The adapter can reject after destroying the entire case scope.
      if (roots.length > 0) {
        outcome.save = () => saveCaseJournals(openDiagnostics, roots);
      }
    }
  });
}

function* saveCaseJournals(
  openDiagnostics: () => Operation<TestDiagnostics>,
  roots: readonly { source: string; stream: InMemoryStream }[],
): Operation<void> {
  const diagnostics = yield* openDiagnostics();
  for (const { source, stream } of roots) {
    const host = diagnostics.execution("root", source).journal(() => false);
    const events = yield* stream.readAll();
    if (events.length === 0) {
      continue;
    }
    try {
      yield* host.save(events);
    } catch (error) {
      yield* host.reportSaveFailure(error instanceof Error ? error : new Error(String(error)));
    }
  }
}

/** Open a fresh journal at the actual source of an independent execution. */
export function* useJournalStream(source: string): Operation<InMemoryStream> {
  const open = yield* CaseJournals.get();
  return open === undefined ? new InMemoryStream() : open(source);
}

/**
 * Protect a repository test's fresh guarded execution and its assertions.
 * Pass the outer case's declared name and repository-relative file as the
 * label. A saved journal has a sibling .case.json with that label and the
 * execution's kind, ordinal and displayed source. The JSONL carries the
 * original durable records.
 *
 * A host with detached children passes its diagnostics to their journal
 * factory. An owner whose stream holds more than the admitted execution can
 * select the owned events for persistence after teardown.
 */
export function captureTestJournal<T>(
  testCase: JournalCase,
  source: string,
  body: (stream: InMemoryStream, diagnostics: TestDiagnostics) => Operation<T>,
  options: {
    sink?: DeliverySink;
    failed?: (value: T) => boolean;
    selectEvents?: (events: readonly DurableEvent[]) => readonly DurableEvent[];
  } = {},
): Operation<T> {
  return scoped(function* () {
    const diagnostics = yield* useTestDiagnostics(options.sink ?? process.stderr, testCase);
    const journal = diagnostics.execution("root", source).journal(options.failed ?? (() => false));
    return yield* withFailureJournal(
      {
        ...journal,
        *save(events) {
          const selected = options.selectEvents?.(events) ?? events;
          if (selected.length > 0) {
            yield* journal.save(selected);
          }
        },
      },
      (stream) => body(stream, diagnostics),
    );
  });
}
