import { resource, spawn, withResolvers } from "effection";
import type { Operation } from "effection";
import { runReplProgram } from "../../src/repl/program.ts";
import type { HeadlessReplRoot } from "../../src/repl/program.ts";
import { useReplLiveScreen } from "../../src/repl/live-screen.ts";
import { useMountedHost } from "./mounted-repl.ts";
import type { MountedHost } from "./mounted-repl.ts";

type LiveRoot = Parameters<HeadlessReplRoot["ready"]>[0];

/** Open the real program with the existing scripted host, without a terminal. */
export function* usePluginProgram(
  options: Parameters<typeof useMountedHost>[0] = {},
): Operation<{ host: MountedHost; root: LiveRoot }> {
  const host = yield* useMountedHost(options);
  return yield* resource(function* (provide) {
    const view = yield* useReplLiveScreen();
    const ready = withResolvers<LiveRoot>();
    yield* spawn(function* () {
      try {
        const outcome = yield* runReplProgram({
          profile: host.profile,
          root: host.root,
          headless: {
            view,
            // deno-lint-ignore require-yield
            *ready(root) {
              ready.resolve(root);
            },
          },
        });
        ready.reject(outcome.ok ? new Error("Program ended before readiness") : outcome.error);
      } catch (error) {
        ready.reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    yield* provide({ host, root: yield* ready.operation });
  });
}
