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

/** What a region declared, if anything did. */
export function* declaredRouting(): Operation<ForegroundRouting | undefined> {
  return yield* ForegroundRouting.get();
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
 * The route whose stdout is passing through stderr on this task, if any.
 *
 * A redirect is a fact about one emission, not about the route as a whole and
 * not about the bytes: middleware between a route and the host is entitled to
 * capture, transform, or redirect what it forwards, so anything carried in the
 * payload is gone the moment a legitimate handler copies it. It lives here
 * instead, in a scope the redirecting task opens and closes around its own
 * call. `Stdio` handlers run in the scope of whoever called the operation, so
 * a channel forwarded by a sibling task never sees it — which is what keeps a
 * redirect held up in downstream middleware from swallowing a sibling's stderr.
 *
 * The value is the route's own token rather than `true`: a context is addressed
 * by name, and a record of what a child wrote should not be suppressible by
 * anything that can guess the name.
 */
const Redirecting: Context<object | undefined> = createContext<object | undefined>(
  "@executablemd/core/foreground/redirecting",
  undefined,
);

/** What one block's output did, once it has finished. */
export interface ForegroundOutput {
  /** stdout a `<Capture as>` region asked for; empty otherwise. */
  captured: string;
  /** stdout the host asked to retain; undefined when it asked for none. */
  retainedStdout: string | undefined;
  /** stderr the host asked to retain; undefined when it asked for none. */
  retainedStderr: string | undefined;
}

/**
 * Route one block's channels, and keep what this run has been told to keep.
 *
 * Installed before the child is acquired, so a chunk written during startup is
 * routed and retained like any other. Routing and retention are decided
 * together because they read the same bytes and must not read them twice:
 *
 * - retention records first, so silencing a block never weakens a record the
 *   host explicitly asked for;
 * - captured stdout goes to the region's own buffer and no further, which is
 *   what stops it being displayed as well as captured; and
 * - a run that keeps no record accumulates nothing, so a capture's stderr —
 *   diagnostic, and possibly enormous — is forwarded and forgotten.
 *
 * A channel is classified by where the child wrote it, before any display
 * decision. A value root displays its commands' stdout on the host's stderr,
 * and that redirection re-enters this Api, so the stderr handler has to tell a
 * child's own stderr from stdout passing through on its way to a free channel.
 * The origin is the redirecting task's own, held in a scope this route opens
 * around its call and never in the bytes it forwards: the two channels are
 * forwarded by concurrent tasks, and enclosing middleware may hand on a copy of
 * what it was given. Neither a sibling's progress nor a byte-preserving
 * transformation can make one channel look like the other.
 *
 * Each channel decodes with its own streaming decoder, and each chunk is
 * decoded once and reused, so a code point split across chunks survives and one
 * channel can never disturb the other's partial character. Both decoders are
 * flushed once, when the process is done.
 */
export function* route(
  selected: ForegroundRouting,
  retain: boolean,
): Operation<() => ForegroundOutput> {
  let captured = "";
  let retainedStdout = "";
  let retainedStderr = "";
  // This route's own, so nothing outside it can claim one of its emissions.
  const mine = {};
  const fromStdout = new TextDecoder();
  const fromStderr = new TextDecoder();
  const wanted = retain || selected.stdout === "capture";

  yield* Stdio.around({
    *stdout([bytes], next) {
      // Decoded once, for whoever wants it: feeding the same bytes through a
      // stateful decoder twice would corrupt a split code point.
      const text = wanted ? fromStdout.decode(bytes, { stream: true }) : "";
      if (retain) {
        retainedStdout += text;
      }
      if (selected.stdout === "capture") {
        captured += text;
        return;
      }
      if (selected.stdout === "hidden") {
        return;
      }
      if (selected.stdout === "diagnostic") {
        // Shown on the channel a value root leaves free. It is still the
        // child's stdout: recorded as such above, and announced here for the
        // length of this one call so the stderr handler does not record it
        // again. The scope closes with the call, whatever it forwards.
        return yield* scoped(function* () {
          yield* Redirecting.set(mine);
          return yield* Stdio.operations.stderr(bytes);
        });
      }
      return yield* next(bytes);
    },
    *stderr([bytes], next) {
      if (retain && (yield* Redirecting.get()) !== mine) {
        retainedStderr += fromStderr.decode(bytes, { stream: true });
      }
      if (selected.stderr === "hidden") {
        return;
      }
      return yield* next(bytes);
    },
  });

  return () => {
    // Flushed once the child is done, so a truncated final sequence is
    // reported rather than held.
    if (wanted) {
      const tail = fromStdout.decode();
      if (retain) {
        retainedStdout += tail;
      }
      if (selected.stdout === "capture") {
        captured += tail;
      }
    }
    if (retain) {
      retainedStderr += fromStderr.decode();
    }
    return {
      captured,
      retainedStdout: retain ? retainedStdout : undefined,
      retainedStderr: retain ? retainedStderr : undefined,
    };
  };
}
