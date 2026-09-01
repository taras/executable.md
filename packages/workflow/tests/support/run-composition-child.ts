/**
 * A second process asking for the same managed checkout.
 *
 * Exclusive ownership is a claim about two operating-system processes, so it is
 * proved by two operating-system processes. This one constructs its own
 * ordinary repository provider — its own leases, its own invocation identity —
 * against a managed root and a starting directory the parent names, selects
 * what it was told to select, and writes one JSON line saying what happened.
 *
 * It prints and exits. Everything it holds is released by the kernel when it
 * does, which is the other half of what the parent asserts.
 */

import { main } from "effection";
import process from "node:process";
import { InMemoryStream } from "@executablemd/durable-streams";
import { collect, execute, inlineSource } from "@executablemd/core";
import { API, useHostFiles } from "@executablemd/runtime";
import { useCompositionComponents } from "../../src/composition/installation.ts";
import { useRunComposition } from "../../src/deno/run-composition/provider.ts";
import { ManagedCheckoutError } from "../../src/deno/run-composition/errors.ts";

/** What the parent reads back off this process's stdout. */
export interface ChildOutcome {
  readonly kind: "selected" | "refused" | "failed";
  /** The path a selection bound, when it made one. */
  readonly bound?: string;
  /** The fixed word a managed-checkout refusal is reported under. */
  readonly reason?: string;
  readonly message?: string;
}

await main(function* () {
  const [root, cwd, source] = process.argv.slice(2);
  if (root === undefined || cwd === undefined || source === undefined) {
    throw new Error("the child needs a managed root, a starting directory and a document");
  }

  let outcome: ChildOutcome;
  try {
    const rendered = yield* (function* () {
      yield* API.Env.around(
        {
          // deno-lint-ignore require-yield
          *cwd() {
            return cwd;
          },
        },
        { at: "min" },
      );
      yield* useHostFiles();
      yield* useCompositionComponents();
      yield* useRunComposition({ root, cwd });
      return yield* collect(
        yield* execute({ ...inlineSource(source), stream: new InMemoryStream() }),
      );
    })();
    outcome = { kind: "selected", bound: String(rendered).trim() };
  } catch (error) {
    const refusal = managedRefusal(error);
    outcome =
      refusal === undefined
        ? { kind: "failed", message: String(error) }
        : { kind: "refused", reason: refusal.reason, message: refusal.message };
  }

  process.stdout.write(`${JSON.stringify(outcome)}\n`);
});

/** The managed-checkout refusal in this error's chain, if there is one. */
function managedRefusal(error: unknown): ManagedCheckoutError | undefined {
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current);
    if (current instanceof ManagedCheckoutError) {
      return current;
    }
    current = current instanceof Error ? current.cause : undefined;
  }
  return undefined;
}
