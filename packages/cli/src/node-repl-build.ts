import { exec, Stdio } from "@effectionx/process";
import { scoped } from "effection";
import { dirname, relative } from "node:path";
import process from "node:process";

export function readSourceCheckout(entrypoint: string | undefined) {
  return scoped(function* () {
    yield* Stdio.around({
      *stdout() {
        // The joined result owns probe output.
      },
      *stderr() {
        // Unavailable Git metadata is reported as unknown.
      },
    });
    return yield* inspectCheckout(entrypoint);
  });
}

function* inspectCheckout(entrypoint: string | undefined) {
  if (entrypoint === undefined) {
    return {};
  }

  const directory = dirname(entrypoint);
  // Git overrides inherited from the launch project can name a different checkout.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => !entry[0].startsWith("GIT_") && entry[1] !== undefined,
    ),
  );
  env["GIT_OPTIONAL_LOCKS"] = "0";

  try {
    const rootResult = yield* exec("git", {
      cwd: directory,
      env,
      arguments: ["rev-parse", "--show-toplevel"],
    }).join();
    const root = rootResult.stdout.trimEnd();
    if (rootResult.code !== 0 || root === "") {
      return {};
    }
    const tracked = yield* exec("git", {
      cwd: root,
      env,
      arguments: [
        "--literal-pathspecs",
        "ls-files",
        "--error-unmatch",
        "--",
        relative(root, entrypoint),
      ],
    }).join();
    if (tracked.code !== 0) {
      return {};
    }
    const head = yield* exec("git", {
      cwd: root,
      env,
      arguments: ["rev-parse", "--verify", "HEAD"],
    }).join();
    const status = yield* exec("git", {
      cwd: root,
      env,
      arguments: ["status", "--porcelain=v1", "--untracked-files=normal"],
    }).join();
    return {
      root,
      ...(head.code === 0 ? { revision: head.stdout.trim() } : {}),
      ...(status.code === 0
        ? { changes: status.stdout === "" ? "none reported by Git" : "present" }
        : {}),
    };
  } catch {
    return {};
  }
}
