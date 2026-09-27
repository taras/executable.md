/**
 * The REPL's terminal on Bun.
 *
 * Named for its runtime because every line of it is a Node-compatible capability Bun implements: the
 * stream's own reported width and height, `setRawMode` on the tty read stream,
 * the `SIGWINCH` process event, and the two writes. Nothing registers it —
 * `bun.ts` installs it when the REPL opens, so an ordinary `xmd run` never
 * touches raw mode.
 *
 * Standard input is a single source, so one subscriber consumes it; a second
 * would be a second decoder racing the first for the same bytes, which is not
 * something this REPL does.
 */

import { writeSync } from "node:fs";
import process from "node:process";
import type { Operation } from "effection";
import { decodedChunks, installReplTerminal, writeThrough } from "./repl/terminal-host.ts";
import type { ReplTerminalSize } from "./repl/terminal.ts";

/** Install the Bun-backed terminal for the calling scope. */
export function useBunReplTerminal(): Operation<void> {
  return installReplTerminal({
    size(): ReplTerminalSize {
      return { columns: process.stdout.columns, rows: process.stdout.rows };
    },
    write(bytes: Uint8Array): Promise<void> {
      return writeThrough((chunk, done) => process.stdout.write(chunk, done), bytes);
    },
    writeNow(bytes: Uint8Array): void {
      // Synchronous on purpose: the final reset must land as one uninterrupted
      // act, and a suspension here would let another teardown step write over a
      // half-restored terminal. Written to the descriptor rather than the stream
      // because the stream may still be holding buffered output of its own.
      // oxlint-disable-next-line local/no-sync-filesystem
      writeSync(1, bytes);
    },
    setRaw(raw: boolean): void {
      process.stdin.setRawMode(raw);
    },
    bytes(): AsyncIterable<Uint8Array> {
      process.stdin.resume();
      return decodedChunks(process.stdin);
    },
    onResize(listener: () => void): () => void {
      process.on("SIGWINCH", listener);
      return () => {
        process.off("SIGWINCH", listener);
      };
    },
  });
}
