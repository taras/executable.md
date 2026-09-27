/**
 * The REPL's terminal on Deno.
 *
 * Named for its runtime because every line of it is a Deno capability: the
 * console size, raw mode on the standard input descriptor, `SIGWINCH`, and the
 * two writes. Nothing registers it — `deno.ts` installs it when the REPL opens,
 * so an ordinary `xmd run` never touches raw mode or the terminal's modes at
 * all.
 *
 * Standard input is a single source, so one subscriber consumes it; a second
 * would be a second decoder racing the first for the same bytes, which is not
 * something this REPL does.
 */

import type { Operation } from "effection";
import { installReplTerminal, writeAllTo } from "./repl/terminal-host.ts";
import type { ReplTerminalSize } from "./repl/terminal.ts";

/** Install the Deno-backed terminal for the calling scope. */
export function useDenoReplTerminal(): Operation<void> {
  return installReplTerminal({
    size(): ReplTerminalSize {
      const { columns, rows } = Deno.consoleSize();
      return { columns, rows };
    },
    write(bytes: Uint8Array): Promise<void> {
      return writeAllTo((chunk) => Deno.stdout.write(chunk), bytes);
    },
    writeNow(bytes: Uint8Array): void {
      let written = 0;
      while (written < bytes.length) {
        // Synchronous on purpose: the final reset must land as one uninterrupted
        // act, and a suspension here would let another teardown step write over
        // a half-restored terminal.
        // oxlint-disable-next-line local/no-sync-filesystem
        const count = Deno.stdout.writeSync(bytes.subarray(written));
        if (count <= 0) {
          return;
        }
        written += count;
      }
    },
    setRaw(raw: boolean): void {
      Deno.stdin.setRaw(raw);
    },
    bytes(): AsyncIterable<Uint8Array> {
      return Deno.stdin.readable;
    },
    onResize(listener: () => void): () => void {
      Deno.addSignalListener("SIGWINCH", listener);
      return () => {
        Deno.removeSignalListener("SIGWINCH", listener);
      };
    },
  });
}
