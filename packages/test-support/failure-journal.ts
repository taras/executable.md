import { scoped } from "effection";
import type { Operation } from "effection";
import type { DurableEvent, InMemoryStream } from "@executablemd/durable-streams";
import { withFailureJournal } from "@executablemd/testing";
import process from "node:process";
import { useTestDiagnostics } from "../cli/src/test-diagnostics.ts";
import type { JournalCase, TestDiagnostics } from "../cli/src/test-diagnostics.ts";
import type { DeliverySink } from "../cli/src/stdout-delivery.ts";

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
