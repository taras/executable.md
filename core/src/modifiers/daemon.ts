/**
 * The `daemon` terminal modifier factory (spec §3).
 *
 * Forks a long-running subprocess into the component's eval scope.
 * The process is alive for the duration of component expansion and
 * killed when the component scope closes. Unlike `exec`, it produces
 * no journal entry and never waits for the process to exit.
 *
 * Detection rule: daemon blocks are written as `bash daemon exec` —
 * `exec` satisfies the §3.2 detection rule but is never invoked since
 * `daemon` is the outermost terminal modifier and ignores `next`.
 */

import { ephemeral } from "@executablemd/durable-streams";
import { daemon } from "@effectionx/process";
import type { ModifierFactory } from "../modifiers.ts";
import { useCodeBlock } from "../modifiers.ts";
import { evalScope } from "../component-api.ts";

/**
 * Terminal modifier factory for long-running background processes.
 *
 * Ignores `next` — this is the terminal handler (like `exec` and `eval`).
 * Reads code block metadata via useCodeBlock() and the eval scope via
 * the contextual `evalScope` value.
 *
 * The block's content (already interpolated with eval bindings by the
 * expansion engine) is used to build the subprocess command. The command
 * is forked into the eval scope via `evalScope.eval()` — the subprocess
 * lives for the duration of component expansion.
 *
 * If the process exits prematurely, `daemon()` throws `DaemonExitError`,
 * which propagates through the eval scope to the document expansion.
 *
 * Daemon blocks produce no rendered output and no journal entry.
 */
export const daemonFactory: ModifierFactory = (_params) => (_args, _next) =>
  (function* () {
    const ctx = yield* useCodeBlock();

    // Bridge from Workflow (durable) to Operation (ephemeral) —
    // daemon produces no journal entry, so all its effects are ephemeral.
    const launchDaemon = {
      *[Symbol.iterator]() {
        const scope = yield* evalScope;
        if (!scope) {
          throw new Error("daemon requires a component eval scope; none is in scope.");
        }

        // The block content is a raw shell command (e.g. the body of a
        // ```bash daemon exec``` block). Pass it directly to daemon()
        // with shell:true so @effectionx/process invokes the system
        // shell instead of splitting with shellwords — which would
        // mangle commands containing nested quotes.
        yield* scope.eval(function* () {
          yield* daemon(ctx.content, { shell: true });
        });
      },
    };
    yield* ephemeral(launchDaemon);

    // Control returns here immediately after the fork.
    return { output: "", exitCode: 0, stderr: "" };
  })();
