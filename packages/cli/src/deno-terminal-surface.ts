/**
 * The pieces of Deno's terminal this REPL uses, read off the host.
 *
 * Read rather than imported, and named nowhere in this module's types, because
 * the repository typechecks every package under Node as well — where the `Deno`
 * global does not exist and a module that names it fails to compile even though
 * nothing there would ever load it. Reaching for the host through `globalThis`
 * and parsing what comes back is how the other runtime-named adapters in this
 * repository stay compilable everywhere and constructible only where they work.
 *
 * Every member is validated before it is offered. A host that is missing one is
 * a host with no terminal, which the caller reports rather than discovering
 * halfway through taking one.
 */

import { ensure, type Operation, resource, type Stream, type Subscription, until } from "effection";

/** What a Deno host offers a terminal. */
export interface DenoTerminalSurface {
  /** Whether both of this host's standard streams are a terminal. */
  interactive(): boolean;
  consoleSize(): { readonly columns: number; readonly rows: number };
  /**
   * Hand bytes over, answering with how many it took.
   *
   * An operation: the host's own write is a promise, and this is where it crosses
   * into one — so nothing above here chains onto a promise or holds one.
   */
  write(bytes: Uint8Array): Operation<number>;
  /** Hand bytes over with no suspension point inside the call. */
  writeSync(bytes: Uint8Array): number;
  setRaw(raw: boolean): void;
  /**
   * The byte source, as a stream whose resource owns the reader.
   *
   * One source, so one subscriber consumes it. A stream rather than an async
   * iterable because releasing this terminal has to be something a scope can
   * do: a reader's `return()` queues behind its own pending read, and this
   * host's standard input has no next read until somebody presses a key.
   */
  input(): Stream<Uint8Array, void>;
  /** Watch for size changes; the returned function stops watching. */
  onResize(listener: () => void): () => void;
}

/** One member of the host, when it is the function this needs. */
function callable(host: object, name: string): ((...args: unknown[]) => unknown) | undefined {
  const member: unknown = Reflect.get(host, name);
  if (typeof member !== "function") {
    return undefined;
  }
  return (...args: unknown[]) => Reflect.apply(member, host, args);
}

/** A number the host reported, or none when it reported something else. */
function numeric(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * This host's terminal, or none when it is not a Deno host.
 *
 * `undefined` rather than a throw: whether this runtime has one is a question
 * with an answer, and the caller is the one that knows whether an absent
 * terminal is a problem.
 */
export function denoTerminalSurface(): DenoTerminalSurface | undefined {
  const host: unknown = Reflect.get(globalThis, "Deno");
  if (typeof host !== "object" || host === null) {
    return undefined;
  }
  const consoleSize = callable(host, "consoleSize");
  const addSignalListener = callable(host, "addSignalListener");
  const removeSignalListener = callable(host, "removeSignalListener");
  const stdout: unknown = Reflect.get(host, "stdout");
  const stdin: unknown = Reflect.get(host, "stdin");
  if (
    consoleSize === undefined ||
    addSignalListener === undefined ||
    removeSignalListener === undefined ||
    typeof stdout !== "object" ||
    stdout === null ||
    typeof stdin !== "object" ||
    stdin === null
  ) {
    return undefined;
  }

  const write = callable(stdout, "write");
  const writeSync = callable(stdout, "writeSync");
  const setRaw = callable(stdin, "setRaw");
  const readingTerminal = callable(stdin, "isTerminal");
  const writingTerminal = callable(stdout, "isTerminal");
  const readable: unknown = Reflect.get(stdin, "readable");
  if (
    write === undefined ||
    writeSync === undefined ||
    setRaw === undefined ||
    readingTerminal === undefined ||
    writingTerminal === undefined ||
    typeof readable !== "object" ||
    readable === null ||
    typeof Reflect.get(readable, "getReader") !== "function"
  ) {
    return undefined;
  }
  const source = readable;

  return {
    interactive(): boolean {
      // Both ends, because the REPL reads keys from one and draws frames on
      // the other: a redirected half is a half this product cannot run on.
      return readingTerminal() === true && writingTerminal() === true;
    },
    consoleSize(): { readonly columns: number; readonly rows: number } {
      const reported: unknown = consoleSize();
      if (typeof reported !== "object" || reported === null) {
        throw new Error("this host did not report a console size");
      }
      const columns = numeric(Reflect.get(reported, "columns"));
      const rows = numeric(Reflect.get(reported, "rows"));
      if (columns === undefined || rows === undefined) {
        throw new Error("this host reported a console size with no columns or rows");
      }
      return { columns, rows };
    },
    *write(bytes: Uint8Array): Operation<number> {
      // `Reflect.apply` answers with `unknown`, so the host's own promise is
      // wrapped once to be awaited and the count is then parsed rather than
      // asserted.
      const taken: unknown = yield* until(Promise.resolve(write(bytes)));
      return numeric(taken) ?? 0;
    },
    writeSync(bytes: Uint8Array): number {
      return numeric(writeSync(bytes)) ?? 0;
    },
    setRaw(raw: boolean): void {
      setRaw(raw);
    },
    input(): Stream<Uint8Array, void> {
      return readerStream(source);
    },
    onResize(listener: () => void): () => void {
      addSignalListener("SIGWINCH", listener);
      return () => {
        removeSignalListener("SIGWINCH", listener);
      };
    },
  };
}

/**
 * One owned stream over a readable this host supplied.
 *
 * Exported for the evidence that its release cannot be silent. The release is the
 * whole contract here — cancel the outstanding read, release the lock, and raise
 * when either could not be done — and a contract that can only be exercised
 * through `Deno.stdin` is one no row can put a failing reader behind.
 *
 * The reader is acquired *after* its release is registered, and the release
 * cancels it: cancelling a reader with a read outstanding settles that read and
 * stops the underlying source, which is what lets a command that decided to
 * leave finish without the person pressing one more key. `return()` on an
 * iterator cannot do that — it is queued behind the very read it needs to end.
 *
 * Cancellation is awaited, never fired and forgotten, and is idempotent: a
 * second teardown finds no reader and releases nothing twice.
 */
export function readerStream(source: object): Stream<Uint8Array, void> {
  return resource<Subscription<Uint8Array, void>>(function* (provide) {
    let reader: object | undefined;

    yield* ensure(function* (): Operation<void> {
      const open = reader;
      if (open === undefined) {
        return;
      }
      // Cleared first, so a second pass through this cleanup releases nothing a
      // second time.
      reader = undefined;

      // Both steps are attempted, and neither failure is swallowed. Cancelling
      // is what settles the read this stream was holding, so a cancellation that
      // failed leaves a native read outstanding — and a command that reported an
      // orderly exit over one would be claiming it had joined work it had not.
      // Releasing the lock is what lets whatever runs next read this terminal at
      // all, so it is attempted even when cancelling failed rather than skipped
      // along with it.
      let failure: Error | undefined;
      const cancel = callable(open, "cancel");
      if (cancel !== undefined) {
        try {
          yield* until(Promise.resolve(cancel()));
        } catch (error) {
          failure = asFailure(error, "cancel the read it was holding");
        }
      }
      const release = callable(open, "releaseLock");
      if (release !== undefined) {
        try {
          release();
        } catch (error) {
          // The first failure is the one that explains the rest: a lock that
          // cannot be released after a cancellation that failed is a consequence
          // of it, not a second independent fact.
          failure = failure ?? asFailure(error, "release its reader");
        }
      }
      if (failure !== undefined) {
        throw failure;
      }
    });

    const acquire = callable(source, "getReader");
    if (acquire === undefined) {
      throw new Error("this host's standard input offers no reader");
    }
    const acquired: unknown = acquire();
    if (typeof acquired !== "object" || acquired === null) {
      throw new Error("this host's standard input produced no reader");
    }
    reader = acquired;
    const read = callable(acquired, "read");
    if (read === undefined) {
      throw new Error("this host's standard input produced a reader that cannot read");
    }

    yield* provide({
      *next(): Operation<IteratorResult<Uint8Array, void>> {
        const result: unknown = yield* until(Promise.resolve(read()));
        if (typeof result !== "object" || result === null) {
          return { done: true, value: undefined };
        }
        const value: unknown = Reflect.get(result, "value");
        return Reflect.get(result, "done") === true || !(value instanceof Uint8Array)
          ? { done: true, value: undefined }
          : { done: false, value };
      },
    });
  });
}

/** One cleanup failure, named for the step that could not be completed. */
function asFailure(cause: unknown, step: string): Error {
  const because = cause instanceof Error ? cause.message : String(cause);
  const failure = new Error(`this terminal could not ${step}: ${because}`);
  failure.name = "ReplTerminalReleaseError";
  return failure;
}
