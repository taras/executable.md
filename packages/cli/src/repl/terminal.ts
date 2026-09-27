/**
 * What the REPL needs from a terminal, and who restores it.
 *
 * Shared code never asks which runtime it is on. It asks this Api, and a
 * runtime-named adapter installs the answers: writing bytes, reading them,
 * reporting the size, being told when the size changes, and turning raw mode on
 * and off. Everything else — modes, the reader, the reset sequence — is
 * ordinary portable code built on top of those five things.
 *
 * ## One unsuspending write, and why
 *
 * Restoring a terminal has to happen in order, and the last step of it happens
 * while the process is already unwinding. `writeNow` is that one step: the
 * adapter hands the bytes to the terminal with no suspension point inside the
 * call, so nothing else being torn down can interleave between deciding to
 * reset and the reset landing. Every other write suspends and yields the
 * interpreter like any other operation.
 */

import { type Api, createApi } from "@effectionx/context-api";
import type { Operation, Stream } from "effection";

/** How much terminal there is, in cells. */
export interface ReplTerminalSize {
  readonly columns: number;
  readonly rows: number;
}

/** No adapter installed this operation, so the REPL cannot perform it. */
export class ReplTerminalError extends Error {
  constructor(operation: string) {
    super(
      `the REPL has no terminal for ${operation}. A runtime adapter installs one with ` +
        'ReplTerminal.around({ ... }, { at: "min" }) before the terminal is opened.',
    );
    this.name = "ReplTerminalError";
  }
}

export interface ReplTerminalApi {
  /**
   * Whether a person is at this terminal.
   *
   * Asked before anything is created, because the REPL is not available over a
   * pipe and finding that out by calling `setRaw` on one is finding it out
   * after a history file already exists. A host answers from what it knows
   * about its own descriptors; nothing here guesses.
   */
  interactive(): Operation<boolean>;
  /** The size as it stands. */
  size(): Operation<ReplTerminalSize>;
  /** Write bytes, returning once the terminal has them. */
  write(bytes: Uint8Array): Operation<void>;
  /**
   * Write bytes without suspending.
   *
   * The one ordered-teardown case: the final reset must not be interleaved with
   * anything else unwinding, so the adapter completes it inside the call rather
   * than at a suspension point. Nothing else uses it.
   */
  writeNow(bytes: Uint8Array): void;
  /** Turn raw mode on or off. */
  setRaw(raw: boolean): Operation<void>;
  /** Each chunk of input bytes, closing at end of input. */
  input(): Stream<Uint8Array, void>;
  /** Each size the terminal becomes. A host event, never a decoded key. */
  resizes(): Stream<ReplTerminalSize, never>;
}

export const ReplTerminal: Api<ReplTerminalApi> = createApi<ReplTerminalApi>("ReplTerminal", {
  // deno-lint-ignore require-yield
  *interactive(): Operation<boolean> {
    throw new ReplTerminalError("asking whether a person is at it");
  },
  // deno-lint-ignore require-yield
  *size(): Operation<ReplTerminalSize> {
    throw new ReplTerminalError("reading its size");
  },
  // deno-lint-ignore require-yield
  *write(_bytes: Uint8Array): Operation<void> {
    throw new ReplTerminalError("writing to it");
  },
  writeNow(_bytes: Uint8Array): void {
    throw new ReplTerminalError("writing to it");
  },
  // deno-lint-ignore require-yield
  *setRaw(_raw: boolean): Operation<void> {
    throw new ReplTerminalError("changing its modes");
  },
  input(): Stream<Uint8Array, void> {
    throw new ReplTerminalError("reading from it");
  },
  resizes(): Stream<ReplTerminalSize, never> {
    throw new ReplTerminalError("watching its size");
  },
});
