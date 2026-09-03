/**
 * The root document a caller pipes in.
 *
 * `xmd run -` reads standard input to end of file and admits the whole result
 * as one root. Which stream that is belongs to the process that is running, so
 * each runtime-named entrypoint closes this adapter over its own
 * `process.stdin` and hands `runXmd` the reader (Code Rule 12). It is a value
 * the host supplies: not a Context, a syntax entry, a component, or anything an
 * authored document can name or replace.
 */

import { Err, Ok, withResolvers } from "effection";
import type { Operation, Result } from "effection";

/** The stable origin a document read from standard input reports. */
export const STANDARD_INPUT_PATH = "<stdin>";

/**
 * Everything a failed read says.
 *
 * The host's own error, the bytes that did arrive and the stream they arrived
 * on are all absent on purpose: none of them is something the caller of a
 * pipeline can act on, and each would put unbounded foreign text into a
 * diagnostic.
 */
export const STANDARD_INPUT_FAILURE =
  "xmd run could not read a complete document from standard input";

/** Read the complete root document from wherever this host keeps standard input. */
export type StandardInputReader = () => Operation<Result<string>>;

/**
 * The part of a Node-style readable this adapter uses.
 *
 * Stated structurally so the shared module names no host global: an entrypoint
 * passes its own stream in by value.
 */
export interface InputStream {
  on(event: "data", listener: (chunk: Uint8Array) => void): unknown;
  on(event: "end" | "close", listener: () => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  off(event: "data", listener: (chunk: Uint8Array) => void): unknown;
  off(event: "end" | "close", listener: () => void): unknown;
  off(event: "error", listener: (error: Error) => void): unknown;
  resume(): unknown;
  pause(): unknown;
}

/**
 * The supplied stream's complete UTF-8 text, read once, to end of file.
 *
 * The listeners and the flowing state they put the stream into belong to this
 * operation's scope: cancelling it removes them and stops the read without
 * manufacturing a failure, so a run cancelled while waiting for bytes reports
 * cancellation rather than a read that went wrong.
 *
 * A stream that closes without ending delivered part of a document and no end
 * of file, which is a failure rather than a short program.
 */
export function* readInputStream(stream: InputStream): Operation<Result<string>> {
  const settled = withResolvers<Result<string>>();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let ended = false;

  const onData = (chunk: Uint8Array) => {
    chunks.push(decoder.decode(chunk, { stream: true }));
  };
  const onEnd = () => {
    ended = true;
    settled.resolve(Ok(`${chunks.join("")}${decoder.decode()}`));
  };
  const onClose = () => {
    if (!ended) {
      settled.resolve(Err(new Error("standard input closed before end of file")));
    }
  };
  const onError = (error: Error) => {
    settled.resolve(Err(error));
  };

  try {
    stream.on("data", onData);
    stream.on("end", onEnd);
    stream.on("close", onClose);
    stream.on("error", onError);
    stream.resume();
    return yield* settled.operation;
  } finally {
    stream.off("data", onData);
    stream.off("end", onEnd);
    stream.off("close", onClose);
    stream.off("error", onError);
    stream.pause();
  }
}
