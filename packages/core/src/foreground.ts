/**
 * Where a foreground command's output goes, and what is kept of it (spec §3.6).
 *
 * Three separate questions, deliberately not one:
 *
 * - **Routing** is what a reader sees while the command runs. An ordinary block
 *   forwards both channels to the host's, so a build prints as it builds;
 *   `<Capture as>` takes stdout into the captured value instead; `silent` shows
 *   neither. Routing never decides success.
 * - **Retention** is what the run keeps afterwards. A host that asked for a
 *   diagnostic journal keeps stdout and stderr; a host that asked for none keeps
 *   the exit status alone, and nothing accumulates the bytes on their way past.
 * - **Rendering** is what the document says. Forwarded bytes were already
 *   displayed, so nothing renders them a second time; captured bytes are the
 *   binding's text.
 *
 * Retention defaults to keeping output, so a programmatic caller that hands
 * `execute()` a durable stream keeps the record it has always had. The CLI
 * chooses transient execution explicitly when no `--journal` was asked for.
 */

import { createContext, scoped } from "effection";
import type { Context, Operation } from "effection";
import { Stdio } from "@effectionx/process";

/**
 * What happens to one channel of a foreground command.
 *
 * `diagnostic` displays the channel on stderr. A value root's stdout carries
 * its JSON result and nothing else, so a command's progress is shown beside it
 * rather than in it — visible, and never mistaken for the result.
 */
export type Routing = "forward" | "capture" | "hidden" | "diagnostic";

export interface ForegroundRouting {
  /** How stdout reaches the reader, or the binding that asked for it. */
  stdout: Routing;
  /** stderr is diagnostic: it is either displayed or hidden, never captured. */
  stderr: Exclude<Routing, "capture">;
}

/** An ordinary foreground block: both channels reach the reader as they arrive. */
export const FOREGROUND: ForegroundRouting = { stdout: "forward", stderr: "forward" };

/** A value root: stdout is the result's, so a command's stdout is shown beside it. */
export const VALUE_ROOT: ForegroundRouting = { stdout: "diagnostic", stderr: "forward" };

/**
 * The routing a structure declared, or `undefined` where none did.
 *
 * Absence is meaningful: a block whose region declared nothing is an ordinary
 * foreground block, and telling "declared forward" from "declared nothing"
 * is what lets the block context carry a region's decision across the durable
 * boundary without the default overwriting it.
 */
export const ForegroundRouting: Context<ForegroundRouting | undefined> = createContext<
  ForegroundRouting | undefined
>("core.foregroundRouting", undefined);

/**
 * Whether the run keeps a command's output once it has finished.
 *
 * The host decides this and says so. Nothing here infers it from which stream
 * implementation a journal happens to use.
 */
export const RetainProcessOutput: Context<boolean> = createContext<boolean>(
  "core.retainProcessOutput",
  true,
);

/** What a region declared, if anything did. */
export function* declaredRouting(): Operation<ForegroundRouting | undefined> {
  return yield* ForegroundRouting.get();
}

/** Whether this run keeps process output; hosts that want none say so. */
export function* retaining(): Operation<boolean> {
  return (yield* RetainProcessOutput.get()) ?? true;
}

/**
 * Run `body` with `routing` in effect for the foreground commands inside it.
 *
 * Scoped, so a region's routing ends with the region: the block after a
 * `<Capture>` forwards again.
 */
export function withRouting<T>(
  selected: ForegroundRouting,
  body: () => Operation<T>,
): Operation<T> {
  return scoped(function* () {
    yield* ForegroundRouting.set(selected);
    return yield* body();
  });
}

/**
 * Install what `selected` means for the child about to start.
 *
 * A channel that is displayed installs nothing: the process package's own
 * default writes it to the host's corresponding stream, which is the behavior
 * being asked for. A channel that is not displayed is answered here instead, so
 * the bytes stop at this scope rather than reaching a terminal.
 */
export function* silence(selected: ForegroundRouting): Operation<void> {
  const around: Record<string, unknown> = {};
  if (selected.stdout === "capture" || selected.stdout === "hidden") {
    Object.assign(around, { *stdout() {} });
  }
  if (selected.stdout === "diagnostic") {
    // Shown, on the channel a value root leaves free.
    Object.assign(around, {
      *stdout([bytes]: [Uint8Array]) {
        yield* Stdio.operations.stderr(bytes);
      },
    });
  }
  if (selected.stderr !== "forward") {
    Object.assign(around, { *stderr() {} });
  }
  if (Object.keys(around).length > 0) {
    yield* Stdio.around(around as Parameters<typeof Stdio.around>[0]);
  }
}
