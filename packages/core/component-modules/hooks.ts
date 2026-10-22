import { allSettled, ensure, until } from "effection";
import type { Operation } from "effection";
import type { RegisterHooksOptions, ModuleHooks } from "node:module";
import { componentSource } from "./transform.ts";

/** Keep one host's supplied-source hooks until the consuming invocation ends. */
export function* loadHookModule(
  source: string,
  origin: string,
  register: (hooks: RegisterHooksOptions) => ModuleHooks,
): Operation<unknown> {
  const digest = new Uint8Array(
    yield* until(crypto.subtle.digest("SHA-256", new TextEncoder().encode(source))),
  );
  const url = new URL(origin);
  url.searchParams.set(
    "xmd-component-source",
    Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(""),
  );
  const selected = url.href;
  const emitted = componentSource(source, origin);
  let hooks: ModuleHooks | undefined;
  const pending: Operation<unknown>[] = [];
  yield* ensure(function* () {
    try {
      yield* allSettled(pending);
    } finally {
      hooks?.deregister();
    }
  });
  hooks = register({
    resolve(specifier, context, next) {
      if (specifier === selected) {
        return { url: selected, format: "module", shortCircuit: true };
      }
      return next(
        specifier,
        context.parentURL === selected ? { ...context, parentURL: origin } : context,
      );
    },
    load(url, context, next) {
      return url === selected
        ? { source: emitted, format: "module", shortCircuit: true }
        : next(url, context);
    },
  });
  const imported = until(import(selected));
  pending.push(imported);
  return yield* imported;
}
