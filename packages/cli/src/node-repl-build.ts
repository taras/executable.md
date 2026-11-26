import { exec, Stdio } from "@effectionx/process";
import { scoped, until } from "effection";
import { isBuiltin } from "node:module";
import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative } from "node:path";
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

  // Git overrides inherited from the launch project can name a different checkout.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => !entry[0].startsWith("GIT_") && entry[1] !== undefined,
    ),
  );
  env["GIT_OPTIONAL_LOCKS"] = "0";

  try {
    const source = yield* until(realpath(entrypoint));
    const rootResult = yield* exec("git", {
      cwd: dirname(source),
      env,
      arguments: ["rev-parse", "--show-toplevel"],
    }).join();
    const root = rootResult.stdout.replace(/\n$/, "");
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
        relative(root, source),
      ],
    }).join();
    if (tracked.code !== 0) {
      return {};
    }
    const status = yield* exec("git", {
      cwd: root,
      env,
      arguments: ["status", "--porcelain=v2", "--branch", "--untracked-files=normal"],
    }).join();
    if (status.code !== 0) {
      return { root };
    }
    const lines = status.stdout.split("\n");
    const revision = /^# branch\.oid ([a-f0-9]{40}|[a-f0-9]{64})$/.exec(lines[0] ?? "")?.[1];
    return {
      root,
      ...(revision === undefined ? {} : { revision }),
      changes: lines.some((line) => line !== "" && !line.startsWith("# "))
        ? "present"
        : "none reported by Git",
    };
  } catch {
    return {};
  }
}

const moduleOptions = new Set([
  "-r",
  "--require",
  "--import",
  "--loader",
  "--experimental-loader",
  "--preload",
]);

const fileOptions = new Set([
  "--experimental-config-file",
  "--config",
  "--env-file",
  "--env-file-if-exists",
]);

export function requiredRuntimeDirectory(options: readonly string[], directory: string) {
  for (let index = 0; index < options.length; index++) {
    const option = options[index] ?? "";
    const equals = option.indexOf("=");
    const name = equals === -1 ? option : option.slice(0, equals);
    const takesModule = moduleOptions.has(name);
    if (!takesModule && !fileOptions.has(name)) {
      continue;
    }
    const value = equals === -1 ? options[++index] : option.slice(equals + 1);
    if (
      value !== undefined &&
      !isAbsolute(value) &&
      !(takesModule && (isBuiltin(value) || URL.canParse(value)))
    ) {
      return directory;
    }
  }
  return undefined;
}
