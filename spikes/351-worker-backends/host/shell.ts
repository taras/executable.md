// Worker Shell over the in-process DOFS workspace.
//
// This is upstream's execution model with the Cloudflare transport removed.
// Upstream runs the same interpreter inside a Dynamic Worker that reaches the
// host Durable Object over Workers RPC for every filesystem call
// (entrypoint.ts). Locally the filesystem is in-process, so `WorkerEntrypoint`,
// `env.HOST.getWorkspace()`, and the loader glue all disappear; what remains is
// the vendored adapter plus just-bash.
//
// The exit-code contract is upstream's: timeout 124, cancellation 130,
// interpreter failure 1.

import { type Operation, until } from "effection";
import { Bash } from "just-bash";
import { WorkspaceFsAdapter } from "../vendor/worker-shell/adapter.ts";
import type { WorkspaceFsShim } from "./workspace-fs.ts";

const MAX_OUTPUT_BYTES = 1024 * 1024;

export interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ShellOptions {
  cwd?: string;
  env?: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export function* execShell(
  fs: WorkspaceFsShim,
  command: string,
  options: ShellOptions = {},
): Operation<ShellResult> {
  const cwd = options.cwd ?? "/workspace";
  const controller = new AbortController();
  options.signal?.addEventListener("abort", () => {
    controller.abort(new Error("Execution cancelled"));
  });

  let timedOut = false;
  const timer = options.timeoutMs === undefined ? undefined : setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("Execution timed out"));
  }, options.timeoutMs);

  const bash = new Bash({
    fs: new WorkspaceFsAdapter(fs) as unknown as NonNullable<
      ConstructorParameters<typeof Bash>[0]
    >["fs"],
    cwd,
    // just-bash's own DefenseInDepthBox registers ESM loader hooks through
    // node:module. Upstream disables it because workerd throws on that call and
    // the Dynamic Worker is the real boundary; the spike's evidence records
    // what it does under Deno, where there is no Dynamic Worker.
    defenseInDepth: { enabled: false },
    executionLimits: { maxOutputSize: MAX_OUTPUT_BYTES },
  });

  try {
    return yield* until(
      bash.exec(command, {
        cwd,
        env: options.env,
        signal: controller.signal,
      }),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      stdout: "",
      stderr: `${timedOut ? "Execution timed out" : message}\n`,
      exitCode: timedOut ? 124 : controller.signal.aborted ? 130 : 1,
    };
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
