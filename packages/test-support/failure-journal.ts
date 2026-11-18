import { createContext, ensure, Err, Ok, resource, scoped } from "effection";
import type { Operation, Result } from "effection";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { DurableEvent } from "@executablemd/durable-streams";
import { withFailureJournal } from "@executablemd/testing";
import process from "node:process";
import { prepareTestDiagnostics, useTestDiagnostics } from "../cli/src/test-diagnostics.ts";
import type {
  JournalCase,
  SavedJournalFile,
  TestDiagnostics,
} from "../cli/src/test-diagnostics.ts";
import type { DeliverySink } from "../cli/src/stdout-delivery.ts";
import { CaseOutcome } from "./case-outcome.ts";
import type { CaseSetup } from "./case-outcome.ts";

/** A case's file-backed journals, read before the fixture that owns them deletes them. */
interface RetainedFiles {
  read?: Result<readonly SavedJournalFile[]>;
}

type CaseRoot =
  | { readonly source: string; readonly stream: InMemoryStream }
  | { readonly source: string; readonly files: RetainedFiles };

interface CaseRoots {
  stream(source: string): InMemoryStream;
  files(source: string): RetainedFiles;
}

const CaseJournals = createContext<CaseRoots>("@executablemd/test-support/case-journals");

/**
 * Give ordinary cases fresh attributed roots with one suite setup. For example,
 * the held-host witness registers `beforeEach(journalBeforeEach(OWNER))`. Its
 * fixture selects `request.stream ?? (yield* useJournalStream(document.path))`.
 * A fixture whose host writes journal files registers how to read them with
 * {@link retainJournalFiles}. Keep explicit replay and private inputs at the
 * fixture that owns them.
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

function useCaseJournals(owner: string): Operation<CaseRoots> {
  return resource(function* (provide) {
    const outcome = yield* CaseOutcome.expect();
    const openDiagnostics = yield* prepareTestDiagnostics(process.stderr, {
      owner,
      name: outcome.name,
      suite: outcome.suite,
    });
    const roots: CaseRoot[] = [];
    try {
      yield* provide({
        stream(source) {
          const stream = new InMemoryStream();
          roots.push({ source, stream });
          return stream;
        },
        files(source) {
          const files: RetainedFiles = {};
          roots.push({ source, files });
          return files;
        },
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
  roots: readonly CaseRoot[],
): Operation<void> {
  const diagnostics = yield* openDiagnostics();
  for (const root of roots) {
    const execution = diagnostics.execution("root", root.source);
    const host = execution.journal(() => false);
    try {
      if ("stream" in root) {
        const events = yield* root.stream.readAll();
        if (events.length > 0) {
          yield* host.save(events);
        }
        continue;
      }
      const read = root.files.read;
      if (read === undefined) {
        throw new Error("its files were never read before their owner ended");
      }
      if (!read.ok) {
        throw read.error;
      }
      if (read.value.length > 0) {
        yield* execution.saveFiles(read.value);
      }
    } catch (error) {
      yield* host.reportSaveFailure(error instanceof Error ? error : new Error(String(error)));
    }
  }
}

/** Open a fresh journal at the actual source of an independent execution. */
export function* useJournalStream(source: string): Operation<InMemoryStream> {
  const roots = yield* CaseJournals.get();
  return roots === undefined ? new InMemoryStream() : roots.stream(source);
}

/**
 * Keep the journal files a fixture's host writes for this case's failure save.
 *
 * `snapshot` is the owner's own operation for reading them, because only the
 * owner knows which of its files are journals. Acquire this once the fixture
 * owns the storage and before the work that writes there begins: `snapshot`
 * runs when this resource is torn down, after everything the calling scope
 * acquired later and before anything it acquired earlier — such as the
 * storage's own removal. A passing case discards what was read, and a failed
 * case saves each file beneath the registration's own execution name, keeping
 * its `path`. Outside an attributed case `snapshot` never runs.
 */
export function retainJournalFiles(
  source: string,
  snapshot: Operation<readonly SavedJournalFile[]>,
): Operation<void> {
  return resource(function* (provide) {
    const roots = yield* CaseJournals.get();
    if (roots === undefined) {
      yield* provide();
      return;
    }
    const retained = roots.files(source);
    yield* ensure(function* () {
      try {
        retained.read = Ok(yield* snapshot);
      } catch (error) {
        retained.read = Err(error instanceof Error ? error : new Error(String(error)));
      }
    });
    yield* provide();
  });
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
