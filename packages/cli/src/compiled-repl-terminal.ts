/**
 * The REPL's terminal inside the compiled binary.
 *
 * The compiled binary is Deno, so the capabilities are Deno's — but it is its
 * own named factory because what installs a terminal is a distribution
 * decision, and a binary that shipped without a REPL should not be reached
 * through the factory the source runtime uses.
 *
 * Every line of it is a Deno capability: the
 * console size, raw mode on the standard input descriptor, `SIGWINCH`, and the
 * two writes. Nothing registers it — `compiled.ts` installs it when the REPL opens,
 * so an ordinary `xmd run` never touches raw mode or the terminal's modes at
 * all.
 *
 * The capabilities are read off the host rather than named, because this package
 * is typechecked under Node as well and a module that names `Deno` does not
 * compile there even though nothing would ever load it.
 *
 * Standard input is a single source, so one subscriber consumes it; a second
 * would be a second decoder racing the first for the same bytes, which is not
 * something this REPL does.
 */

import type { Operation } from "effection";
import { denoTerminalSurface } from "./deno-terminal-surface.ts";
import { installReplTerminal } from "./repl/terminal-host.ts";
import type { ReplTerminalSize } from "./repl/terminal.ts";

/** Install the compiled binary's terminal for the calling scope. */
export function* useCompiledReplTerminal(): Operation<void> {
  const host = denoTerminalSurface();
  if (host === undefined) {
    throw new Error("this host is not Deno, so it has no Deno terminal to install");
  }
  yield* installReplTerminal({
    size(): ReplTerminalSize {
      return host.consoleSize();
    },
    write(bytes: Uint8Array): Promise<void> {
      return writeAll(host, bytes);
    },
    writeNow(bytes: Uint8Array): void {
      let written = 0;
      while (written < bytes.length) {
        // Synchronous on purpose: the final reset must land as one uninterrupted
        // act, and a suspension here would let another teardown step write over
        // a half-restored terminal.
        const count = host.writeSync(bytes.subarray(written));
        if (count <= 0) {
          return;
        }
        written += count;
      }
    },
    setRaw(raw: boolean): void {
      host.setRaw(raw);
    },
    bytes: () => host.bytes(),
    onResize: (listener: () => void) => host.onResize(listener),
  });
}

/**
 * Write every byte, however few one call takes.
 *
 * A partial write nobody continued leaves a frame half drawn, which on a
 * terminal means escape sequences cut in the middle.
 */
function writeAll(
  host: { write(bytes: Uint8Array): Promise<number> },
  bytes: Uint8Array,
): Promise<void> {
  let written = 0;
  const step = (): Promise<void> => {
    if (written >= bytes.length) {
      return Promise.resolve();
    }
    return host.write(bytes.subarray(written)).then((count) => {
      if (count <= 0) {
        return Promise.reject(new Error("the terminal accepted none of the bytes it was given"));
      }
      written += count;
      return step();
    });
  };
  return step();
}
