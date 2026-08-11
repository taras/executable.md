/**
 * Where a foreground command's output goes, and what is kept of it (spec §3.6).
 *
 * This is one boundary in a chain, and where it sits decides what "the
 * command's output" means:
 *
 * ```
 * child → enclosing host middleware → here → this document's display → terminal
 * ```
 *
 * Everything upstream is the host's own preprocessing, and it is trusted: a
 * host may transform, redact, redirect or consume a channel before this
 * boundary sees it, and what arrives is then what the run captures, journals
 * and reports. Everything downstream is this document's display policy —
 * `silent`, a capture region, a value root's stream choice — and none of it may
 * change what was already received.
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
 * Every value here answers "does this channel reach the host, and does anything
 * else want it?" — never "which of the host's streams does it land on". A
 * channel is only ever forwarded on the one it was written to, taken into a
 * binding, or dropped. Which stream a host then shows it on is the host's, and
 * a value root's diagnostic channel is decided there.
 */
export type Routing = "forward" | "capture" | "hidden";

export interface ForegroundRouting {
  /** How stdout reaches the reader, or the binding that asked for it. */
  stdout: Routing;
  /** stderr is diagnostic: it is either displayed or hidden, never captured. */
  stderr: Exclude<Routing, "capture">;
}

/** An ordinary foreground block: both channels reach the reader as they arrive. */
export const FOREGROUND: ForegroundRouting = { stdout: "forward", stderr: "forward" };

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
 * A channel is the operation this boundary receives bytes on. Enclosing
 * middleware that forwards a command's stdout on stderr has reclassified it,
 * and the record says stderr, because that is what reached here. Nothing below
 * this boundary reclassifies anything: no path hands one channel's bytes to the
 * other channel's operation, so the received channel is never restated and
 * never has to be recovered from a payload or from contextual state. Showing
 * one channel on another of the host's streams is a decision taken downstream,
 * and it leaves the record alone.
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
      return yield* next(bytes);
    },
    *stderr([bytes], next) {
      if (retain) {
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
