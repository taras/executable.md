/**
 * Tier CL — which hosts can own a native agent session, and what the rest do
 * (specs/native-agent-session-launch-spec.md §Live ownership lease).
 *
 * The lease is host arrangement: a host that can take a kernel-released
 * advisory lock installs one, and a host that cannot installs nothing. This
 * runs under all three runtimes on purpose — the whole claim is that the
 * answer differs by host, and a suite that only ever ran on Deno would be
 * describing one half of it.
 *
 * What must not differ is everything else. Node and Bun keep ordinary ACP work
 * exactly as it is; only the paths that would act on a session a native UI may
 * be sitting in are closed to them.
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { useTempDirectory } from "@executablemd/test-support/temp";
import { scoped, until } from "effection";
import type { Operation } from "effection";
import { chmod, mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import * as nodePath from "node:path";
import { Agent, AgentLaunchJournal } from "@executablemd/core";
import type { LaunchRecord } from "@executablemd/core";
import {
  API,
  hasDenoSessionLease,
  installControlledLauncher,
  installDenoSessionLease,
  SessionLease,
} from "@executablemd/runtime";
import { createAcpxProvider } from "@executablemd/acp";
import {
  createFakeRuntime,
  makeRegistry,
  makeStore,
  useFlatWorld,
} from "../../acp/tests/helpers.ts";
import type { FakeRuntimeHarness } from "../../acp/tests/helpers.ts";
import { createSessionRouteStore } from "../../acp/src/native-session-store.ts";
import { sessionCoordinatorRoot } from "../src/session-coordinator.ts";
import { homedir } from "node:os";

const CWD = "/work";
const AGENT_COMMAND = "claude-cmd";
const CLAUDE_VERSION = "2.1.235 (Claude Code)";
const INSTRUCTIONS = "You are the repository implementor.";
const ENTRYPOINTS = new URL("../src/", import.meta.url);

interface Stack {
  harness: FakeRuntimeHarness;
  records: LaunchRecord[];
  routes: string;
}

function* writeClaude(at: string): Operation<void> {
  yield* until(mkdir(nodePath.dirname(at), { recursive: true }));
  yield* until(writeFile(at, `#!/bin/sh\necho "${CLAUDE_VERSION}"\n`));
  yield* until(chmod(at, 0o755));
}

/**
 * A Claude-bound provider whose only host-dependent input is the lease.
 *
 * Everything else is fixed — one fake runtime, one fake executable, one route
 * store — so a difference between runtimes is the difference under test rather
 * than a difference in what was set up.
 */
function* useStack(routes: string, executable: string): Operation<Stack> {
  const harness = createFakeRuntime();
  const records: LaunchRecord[] = [];
  yield* useFlatWorld(CWD);
  yield* API.Env.around({
    *env([name], next) {
      return name === "PATH" ? nodePath.dirname(executable) : yield* next(name);
    },
  });
  yield* installControlledLauncher({ outcome: () => ({ exitCode: 0 }) });
  yield* AgentLaunchJournal.around(
    {
      *recordPreparation([live]) {
        const record = yield* live();
        records.push(record);
        if (record.failure) {
          throw new Error(record.failure.message);
        }
        return record;
      },
      *recordDetach([live]) {
        const record = yield* live();
        records.push(record);
        if (record.failure) {
          throw new Error(record.failure.message);
        }
        return record;
      },
      *recordExit([live]) {
        const record = yield* live();
        records.push(record);
        if (record.failure) {
          throw new Error(record.failure.message);
        }
        return record;
      },
    },
    { at: "min" },
  );
  const factory = createAcpxProvider({
    createRuntime: harness.create,
    sessionStore: makeStore(),
    agentRegistry: makeRegistry({ claude: AGENT_COMMAND }),
    advertiseNativeLaunch: ["claude"],
    nativeSessionStore: createSessionRouteStore(routes),
  });
  yield* factory({ defaultAgent: "claude", permissionMode: "approve-reads" });
  return { harness, records, routes };
}

function* attempt(session: string): Operation<Error | undefined> {
  try {
    yield* Agent.operations.launch(INSTRUCTIONS, { session });
    return undefined;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

function* ask(session: string): Operation<Error | undefined> {
  try {
    yield* scoped(function* () {
      const stream = yield* Agent.operations.prompt("what changed?", { session });
      const subscription = yield* stream;
      let next = yield* subscription.next();
      while (!next.done) {
        next = yield* subscription.next();
      }
    });
    return undefined;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

function* entrypoint(name: string): Operation<string> {
  return yield* until(readFile(fileURLToPath(new URL(name, ENTRYPOINTS)), "utf8"));
}

describe("Tier CL — host ownership of a native agent session", () => {
  it("CL1: with nothing installed, no host claims it can own a session", function* () {
    // Not "free". A host that installs no lease cannot tell whether a native
    // UI is in the session right now, and answering on its behalf is how two
    // owners happen.
    expect(yield* SessionLease.operations.acquire("a".repeat(64))).toBe("unavailable");
  });

  it("CL2: the adapter grants ownership exactly where the host can back it", function* () {
    // A directory of this test's own. The coordinator root the entrypoints
    // pass is a real one belonging to the person running xmd, and a suite that
    // wrote sidecars into it would be coordinating with their sessions.
    const root = yield* useTempDirectory("xmd-cl-");
    const key = "b".repeat(64);

    const answer = yield* scoped(function* () {
      yield* installDenoSessionLease(root);
      return yield* SessionLease.operations.acquire(key);
    });

    if (hasDenoSessionLease()) {
      // Deno source and the compiled binary: a real advisory lock, so a second
      // holder is refused rather than admitted beside the first — and the
      // first scope closing is what freed it for this one.
      expect(answer).toBe("acquired");
      yield* scoped(function* () {
        yield* installDenoSessionLease(root);
        expect(yield* SessionLease.operations.acquire(key)).toBe("acquired");
        yield* scoped(function* () {
          yield* installDenoSessionLease(root);
          expect(yield* SessionLease.operations.acquire(key)).toBe("busy");
        });
      });
    } else {
      // Node and Bun install nothing, so the answer stays the one that refuses
      // rather than one that guesses.
      expect(answer).toBe("unavailable");
    }

    // Wherever it is installed, it coordinates through one location every
    // process on the host derives the same way.
    expect(sessionCoordinatorRoot().startsWith(homedir())).toBe(true);
    expect(sessionCoordinatorRoot()).toBe(sessionCoordinatorRoot());
  });

  it("CL3: only the entrypoints that can back a lease install one", function* () {
    // Which host installs the lease is the one fact no runtime can observe
    // about the others, and each entrypoint runs only on its own. So it is
    // read where it is written: the shared installer, and who calls it.
    const installer = yield* entrypoint("session-coordinator.ts");
    expect(installer).toContain("installDenoSessionLease(sessionCoordinatorRoot())");

    const installs: Record<string, boolean> = {};
    for (const name of ["deno.ts", "compiled.ts", "node.ts", "bun.ts"]) {
      installs[name] = (yield* entrypoint(name)).includes("yield* useSessionCoordination()");
    }

    expect(installs).toEqual({
      "deno.ts": true,
      "compiled.ts": true,
      "node.ts": false,
      "bun.ts": false,
    });
  });

  it("CL4: ordinary ACP work is available on every host, lease or no lease", function* () {
    const root = yield* useTempDirectory("xmd-cl-");
    const executable = nodePath.join(root, "bin", "claude");
    yield* writeClaude(executable);

    yield* scoped(function* () {
      const stack = yield* useStack(
        nodePath.join(root, "routes"),
        yield* until(realpath(executable)),
      );

      expect(yield* ask("implementor")).toBeUndefined();

      // A session was established and a turn ran. Nothing about the missing
      // lease reaches the path that never needed one.
      expect(stack.harness.ensureCalls).toHaveLength(1);
      expect(stack.harness.turns).toHaveLength(1);
    });
  });

  it("CL5: a host with no lease refuses a fresh native launch before provider work", function* () {
    const root = yield* useTempDirectory("xmd-cl-");
    const executable = nodePath.join(root, "bin", "claude");
    yield* writeClaude(executable);
    const routes = nodePath.join(root, "routes");

    yield* scoped(function* () {
      const stack = yield* useStack(routes, yield* until(realpath(executable)));

      const refused = yield* attempt("implementor");

      expect(refused?.message).toContain("no way to take exclusive ownership");
      expect(stack.records.at(-1)?.failure?.class).toBe("unsupported-capability");
      // Before an identity was published, before ACPX was contacted, and
      // before any child: refusing costs nothing here, which is the point.
      expect(yield* routeFiles(routes)).toEqual([]);
      expect(stack.harness.ensureCalls).toEqual([]);
    });
  });

  it("CL6: a host with no lease refuses attaching to a retained client-native session", function* () {
    const root = yield* useTempDirectory("xmd-cl-");
    const executable = nodePath.join(root, "bin", "claude");
    yield* writeClaude(executable);
    const canonical = yield* until(realpath(executable));
    const routes = nodePath.join(root, "routes");

    // A session some supported host launched, retained where every host can
    // read it. Ownership is granted only for this setup scope.
    yield* scoped(function* () {
      yield* SessionLease.around({
        // deno-lint-ignore require-yield
        *acquire() {
          return "acquired";
        },
      });
      yield* useStack(routes, canonical);
      yield* Agent.operations.launch(INSTRUCTIONS, { session: "implementor" });
    });
    expect(yield* routeFiles(routes)).toEqual(["client-native"]);

    yield* scoped(function* () {
      const stack = yield* useStack(routes, canonical);

      const refused = yield* ask("implementor");

      expect(refused?.message).toContain("no way to take exclusive ownership");
      // Refused before ACPX was asked for a session and before a turn: this
      // host cannot tell whether the native UI is still in the conversation.
      expect(stack.harness.ensureCalls).toEqual([]);
      expect(stack.harness.turns).toEqual([]);
    });

    // And the route is exactly as it was: nothing converted, nothing replaced.
    expect(yield* routeFiles(routes)).toEqual(["client-native"]);
  });
});

/** Which construction each retained route claims, read as another host would. */
function* routeFiles(root: string): Operation<string[]> {
  const entries = yield* until(readdir(root).catch(() => [] as string[]));
  const claims: string[] = [];
  for (const entry of entries.filter((name) => name.endsWith(".json")).sort()) {
    const text = yield* until(readFile(nodePath.join(root, entry), "utf8"));
    claims.push(String(JSON.parse(text).route ?? JSON.parse(text).schema));
  }
  return claims;
}
