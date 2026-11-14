import { createAcpxProvider } from "@executablemd/acp";
import type { AcpxProviderDependencies } from "@executablemd/acp";
import type { EmbeddedAdapters } from "@executablemd/acp/embedded-adapters";
import type { AgentProviderFactory } from "@executablemd/core";
import { scoped } from "effection";
import { cwd, exec, platform, realpath, useQuietProcessOutput } from "@executablemd/runtime";

export function diagnosticAgent(
  dependencies: AcpxProviderDependencies,
  adapters: EmbeddedAdapters,
): AgentProviderFactory {
  return function* (options, launch) {
    const repository = yield* cwd();
    const os = (yield* platform()).os;
    const metadata = yield* scoped(function* () {
      yield* useQuietProcessOutput();
      return yield* exec({
        command: [
          "git",
          "rev-parse",
          "--path-format=absolute",
          "--show-toplevel",
          "--git-dir",
          "--git-common-dir",
        ],
        cwd: repository,
      });
    });
    const directories = metadata.stdout.trimEnd().split("\n");
    if (
      metadata.exitCode !== 0 ||
      directories.length !== 3 ||
      directories.some((path) => !path.startsWith("/"))
    ) {
      throw new Error("Diagnosis requires a checkout with identifiable Git directories.");
    }
    const paths = new Set<string>();
    for (const path of directories) {
      const resolved = yield* realpath(path);
      if (resolved === undefined) {
        throw new Error("Diagnosis could not resolve a protected checkout path.");
      }
      paths.add(resolved);
    }
    const prefix = diagnosticSandbox(os, [...paths]);
    const probe = yield* exec({ command: [...prefix, "/usr/bin/true"], cwd: repository });
    if (probe.exitCode !== 0) {
      throw new Error("Diagnosis could not start the read-only checkout sandbox.");
    }
    yield* createAcpxProvider({
      ...dependencies,
      coordinator: undefined,
      routeStore: undefined,
      executableObserver: undefined,
      advertiseNativeLaunch: [],
      advertiseClientNativeAttachment: [],
      adapterBuild(agent) {
        return dependencies.adapterBuild?.(agent, adapters.command(agent));
      },
      agentRegistry: {
        resolve(agent) {
          return [...prefix, "node", adapters.executablePath(agent)];
        },
        list() {
          return ["claude", "codex"];
        },
      },
      *agentProcessEnv(agent) {
        const environment =
          dependencies.agentProcessEnv === undefined
            ? undefined
            : yield* dependencies.agentProcessEnv(agent, adapters.command(agent));
        if (agent === "codex") {
          // The outer diagnostic sandbox owns the checkout restriction.
          return { ...environment, INITIAL_AGENT_MODE: "agent-full-access" };
        }
        return { ...environment, CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1" };
      },
      mcpServers: [],
      permissions: "strict",
    })({ ...options, permissionMode: "deny-all" }, launch);
  };
}

function diagnosticSandbox(os: string, paths: readonly string[]): string[] {
  if (os === "darwin") {
    const protectedPaths = paths.map((path) => `(subpath ${JSON.stringify(path)})`).join(" ");
    return [
      "/usr/bin/sandbox-exec",
      "-p",
      `(version 1)(allow default)(deny file-write* ${protectedPaths})`,
    ];
  }
  if (os === "linux") {
    return [
      "bwrap",
      "--unshare-user",
      "--unshare-pid",
      "--disable-userns",
      "--die-with-parent",
      "--bind",
      "/",
      "/",
      "--dev",
      "/dev",
      ...paths.flatMap((path) => ["--ro-bind", path, path]),
      "--proc",
      "/proc",
      "--",
    ];
  }
  throw new Error("Diagnosis requires macOS sandbox-exec or Linux bubblewrap.");
}
