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

/** What a Deno host offers a terminal. */
export interface DenoTerminalSurface {
  /** Whether both of this host's standard streams are a terminal. */
  interactive(): boolean;
  consoleSize(): { readonly columns: number; readonly rows: number };
  /** Hand bytes over, resolving with how many it took. */
  write(bytes: Uint8Array): Promise<number>;
  /** Hand bytes over with no suspension point inside the call. */
  writeSync(bytes: Uint8Array): number;
  setRaw(raw: boolean): void;
  /** The byte source. One source, so one subscriber consumes it. */
  bytes(): AsyncIterable<Uint8Array>;
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
    !(Symbol.asyncIterator in readable)
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
    write(bytes: Uint8Array): Promise<number> {
      return Promise.resolve(write(bytes)).then((taken) => numeric(taken) ?? 0);
    },
    writeSync(bytes: Uint8Array): number {
      return numeric(writeSync(bytes)) ?? 0;
    },
    setRaw(raw: boolean): void {
      setRaw(raw);
    },
    bytes(): AsyncIterable<Uint8Array> {
      // Checked above: this object declares the async-iterable protocol, which
      // is the whole of what the shared reader asks of it.
      return {
        [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
          const method: unknown = Reflect.get(source, Symbol.asyncIterator);
          if (typeof method !== "function") {
            throw new Error("this host's standard input is not iterable after all");
          }
          const iterator: unknown = Reflect.apply(method, source, []);
          if (typeof iterator !== "object" || iterator === null) {
            throw new Error("this host's standard input produced no iterator");
          }
          const next = callable(iterator, "next");
          const back = callable(iterator, "return");
          if (next === undefined) {
            throw new Error("this host's standard input produced no reader");
          }
          return {
            next(): Promise<IteratorResult<Uint8Array>> {
              return Promise.resolve(next()).then((result) => {
                if (typeof result !== "object" || result === null) {
                  return { done: true, value: undefined };
                }
                const value: unknown = Reflect.get(result, "value");
                return Reflect.get(result, "done") === true || !(value instanceof Uint8Array)
                  ? { done: true, value: undefined }
                  : { done: false, value };
              });
            },
            ...(back === undefined
              ? {}
              : {
                  return(): Promise<IteratorResult<Uint8Array>> {
                    return Promise.resolve(back()).then(() => ({ done: true, value: undefined }));
                  },
                }),
          };
        },
      };
    },
    onResize(listener: () => void): () => void {
      addSignalListener("SIGWINCH", listener);
      return () => {
        removeSignalListener("SIGWINCH", listener);
      };
    },
  };
}
