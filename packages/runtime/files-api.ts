import { createContext, ensure, useScope } from "effection";
import type { Operation, Result, Scope } from "effection";
import type { Api, Around, Middleware } from "@effectionx/context-api";
import type { FilesHandler } from "./files.ts";

type Layers = Partial<Around<FilesHandler>>;
interface State {
  max: Layers[];
  min: Layers[];
}
const context = createContext<State>("$api:executablemd.runtime.files", { max: [], min: [] });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
function isLayers(value: unknown): value is Layers {
  return (
    isRecord(value) &&
    Object.values(value).every((member) => member === undefined || typeof member === "function")
  );
}
function isState(value: unknown): value is State {
  return (
    isRecord(value) &&
    Array.isArray(value.max) &&
    value.max.every(isLayers) &&
    Array.isArray(value.min) &&
    value.min.every(isLayers)
  );
}
function windowOf(scope: Scope): Record<string, unknown> {
  const contexts: unknown = Reflect.get(scope, "contexts");
  if (isRecord(contexts)) {
    return contexts;
  }
  throw new Error("Unsupported Effection scope internals");
}
function collect(scope: Scope): Layers[] {
  const max: Layers[] = [];
  const min: Layers[] = [];
  let window: Record<string, unknown> | null = windowOf(scope);
  while (window !== null) {
    if (Object.prototype.hasOwnProperty.call(window, context.name)) {
      const state: unknown = window[context.name];
      if (!isState(state)) {
        throw new Error("Invalid Files middleware composition");
      }
      max.unshift(...state.max);
      min.push(...state.min);
    }
    window = Object.getPrototypeOf(window);
  }
  return [...max, ...min];
}

// Composition follows context-api 0.6.0 and middleware 0.1.1; see files-api.LICENSE.
function combine<A extends unknown[], T>(layers: Middleware<A, T>[]): Middleware<A, T> {
  if (layers.length === 0) {
    return (args, next) => next(...args);
  }
  return layers.reduceRight(
    (inner, layer) => (args, next) => layer(args, (...values) => inner(values, next)),
  );
}
function isOperation<T>(value: Operation<T> | T): value is Operation<T> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    !(value instanceof Map) &&
    !(value instanceof Set) &&
    typeof Reflect.get(value, Symbol.iterator) === "function"
  );
}

export interface FileRecorderHandle {
  assemble<K extends keyof FilesHandler>(method: K): FilesHandler[K];
}
export interface FilesApi extends Api<FilesHandler> {
  /** Check for transformed reads without listing files or touching a target. */
  supportsTextTransform(): Operation<boolean>;
  installTextTransformProvider(layers: Layers): Operation<void>;
  register(boundary: Layers): Operation<FileRecorderHandle>;
}

export function createFilesApi(
  terminal: FilesHandler,
  unsupportedTransform: () => Result<string>,
): FilesApi {
  const recorders = new WeakSet<Layers>();
  const providers = new WeakSet<Layers>();
  function supportsTransform(layers: Layers[]): boolean {
    // An opted-in host provider terminates the read. Only recorder layers may precede it.
    const reader = layers.find(
      (layer) => layer.readTextFile !== undefined && !recorders.has(layer),
    );
    return reader !== undefined && providers.has(reader);
  }
  function* around(
    layers: Layers,
    options: { at: "min" | "max" } = { at: "max" },
  ): Operation<void> {
    const scope = yield* useScope();
    const current = scope.hasOwn(context) ? scope.expect(context) : { max: [], min: [] };
    scope.set(
      context,
      options.at === "min"
        ? { max: [...current.max], min: [layers, ...current.min] }
        : { max: [...current.max, layers], min: [...current.min] },
    );
  }
  function operations(exclude?: Layers, active: () => boolean = () => true): FilesHandler {
    function call<A extends unknown[], T>(
      terminal: (...args: A) => Operation<T>,
      select: (layer: Layers) => Middleware<A, Operation<T>> | undefined,
      wrap?: (layers: Layers[], args: A, invoke: () => Operation<T>) => Operation<T>,
    ): (...args: A) => Operation<T> {
      return (...args) => ({
        *[Symbol.iterator]() {
          if (!active()) {
            throw new Error("Files recorder has closed");
          }
          const layers = collect(yield* useScope());
          if (exclude !== undefined && layers.filter((layer) => layer === exclude).length !== 1) {
            throw new Error("Files recorder is not attached exactly once");
          }
          const handlers = layers
            .filter((layer) => layer !== exclude)
            .flatMap((layer) => {
              const handler = select(layer);
              return handler === undefined ? [] : [handler];
            });
          const invoke = function* () {
            const result = combine(handlers)(args, terminal);
            return isOperation(result) ? yield* result : result;
          };
          return yield* wrap === undefined ? invoke() : wrap(layers, args, invoke);
        },
      });
    }
    return {
      checkFilePath: call(terminal.checkFilePath, (layer) => layer.checkFilePath),
      readTextFile: call(
        terminal.readTextFile,
        (layer) => layer.readTextFile,
        function* (layers, [input], invoke) {
          if (input.transform !== undefined && !supportsTransform(layers)) {
            return unsupportedTransform();
          }
          return yield* invoke();
        },
      ),
      writeTextFile: call(terminal.writeTextFile, (layer) => layer.writeTextFile),
      copyFile: call(terminal.copyFile, (layer) => layer.copyFile),
      deleteFile: call(terminal.deleteFile, (layer) => layer.deleteFile),
      ensureDirectory: call(terminal.ensureDirectory, (layer) => layer.ensureDirectory),
      globFiles: call(terminal.globFiles, (layer) => layer.globFiles),
      temporaryDirectory: call(terminal.temporaryDirectory, (layer) => layer.temporaryDirectory),
    };
  }
  return {
    operations: operations(),
    around,
    *supportsTextTransform() {
      return supportsTransform(collect(yield* useScope()));
    },
    *installTextTransformProvider(layers) {
      const provider = Object.freeze({ ...layers });
      providers.add(provider);
      yield* around(provider, { at: "min" });
    },
    *register(boundary): Operation<FileRecorderHandle> {
      let live = true;
      yield* ensure(() => {
        live = false;
      });
      recorders.add(boundary);
      yield* around(boundary);
      const selected = operations(boundary, () => live);
      return Object.freeze({
        assemble: <K extends keyof FilesHandler>(method: K) => selected[method],
      });
    },
  };
}
