/**
 * The journey as a program, so the same code can be run from source and from a
 * `deno compile` executable and the two answers compared.
 *
 * It prints exactly one JSON record and nothing else. A positive run prints the
 * journey report; a run given one of the closed set of mutations prints the
 * categories the invariant checker rejected it for. Exit status separates the
 * two failures that matter: a mutation that was rejected by name is a working
 * control and exits 0, while a mutation nobody caught, a shape nobody can
 * parse, or an exception nobody named exits non-zero.
 *
 * The component roots are located from this module's own URL rather than from
 * the working directory, because the compiled binary has no checkout to stand
 * in and is deliberately run from somewhere else.
 */

import { main } from "effection";
import { fileURLToPath } from "node:url";

import { categoriesOf, checkJourney, parseJourneyReport } from "./evidence.ts";
import { JOURNEY_MUTATIONS, parseJourneyMutation, REPORT_SCHEMA, runJourney } from "./journey.ts";

const ROOT = fileURLToPath(new URL(".", import.meta.url));

function emit(record: unknown): void {
  console.log(JSON.stringify(record));
}

await main(function* () {
  const [requested, ...extra] = Deno.args;
  if (extra.length > 0) {
    emit({
      schema: REPORT_SCHEMA,
      outcome: "failed",
      detail: `expected at most one mutation, got ${[requested, ...extra].join(" ")}`,
    });
    Deno.exitCode = 1;
    return;
  }

  const mutation = requested === undefined ? undefined : parseJourneyMutation(requested);
  if (requested !== undefined && mutation === undefined) {
    emit({
      schema: REPORT_SCHEMA,
      outcome: "failed",
      detail: `"${requested}" is not one of ${JOURNEY_MUTATIONS.join(", ")}`,
    });
    Deno.exitCode = 1;
    return;
  }

  let report: unknown;
  try {
    report = yield* runJourney({ root: ROOT, mutation });
  } catch (error) {
    emit({
      schema: REPORT_SCHEMA,
      outcome: "failed",
      mutation: mutation ?? null,
      detail: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    });
    Deno.exitCode = 1;
    return;
  }

  // The record goes out through the same parser the outer test uses, so a
  // journey that emitted a shape nothing can read fails here rather than in the
  // comparison.
  const parsed = parseJourneyReport(JSON.parse(JSON.stringify(report)));
  const violations = checkJourney(parsed);

  if (mutation === undefined) {
    if (violations.length > 0) {
      // A rejected positive run carries the record it was rejected on: the
      // reader of that failure needs the evidence, not just the verdict.
      emit({
        schema: REPORT_SCHEMA,
        outcome: "rejected",
        mutation: null,
        categories: categoriesOf(violations),
        violations,
        report,
      });
      Deno.exitCode = 1;
      return;
    }
    emit(report);
    return;
  }

  if (violations.length === 0) {
    emit({ schema: REPORT_SCHEMA, outcome: "admitted", mutation });
    Deno.exitCode = 1;
    return;
  }
  emit({
    schema: REPORT_SCHEMA,
    outcome: "rejected",
    mutation,
    categories: categoriesOf(violations),
    violations,
  });
});
