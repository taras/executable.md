/**
 * Tier TL — what a launched TestAgent session leaves behind
 * (specs/native-agent-session-launch-spec.md §Testing).
 *
 * The authored journey moved to `../src/NativeSessionLaunch.test.md`, which is
 * where it belongs: `<TestAgent>`, `<Session>`, `<Session.Launch>` and a later
 * `<Prompt>` are Markdown, and the document proves what a document can see —
 * that the handoff completed, and that the scenario still had its turn
 * afterwards.
 *
 * What stays here is what Markdown cannot inspect: the metadata that crossed
 * the ACP wire, the argument vector and environment a native child was handed,
 * how a bad native exit lands on the test that launched, and what a replay
 * does not do. These execute that same document rather than assembling
 * Markdown out of strings, so there is one authored journey and these are
 * observations of it.
 */
import { beforeAll, describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { useTempFileCompiler } from "@executablemd/core";
import { scoped, until } from "effection";
import type { Operation, Result } from "effection";
import { chmod, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { execute, installAgentComponents } from "@executablemd/core";
import type { Json } from "@executablemd/core";
import { API, installControlledLauncher, SessionLease, useHostFiles } from "@executablemd/runtime";
import type { NativeLaunchRequest } from "@executablemd/runtime";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { DurableEvent } from "@executablemd/durable-streams";
import { installTestAgentComponents } from "../src/components.ts";
import { NativeLaunchObserver, NativeSessionObserver } from "../src/controller.ts";
import type { NativeSessionReport } from "../src/controller.ts";
import { useTesting } from "@executablemd/testing";
import type { TestResult } from "@executablemd/testing";
import { useCommand } from "./command.ts";
import { createAcpxProvider, createSessionRouteStore } from "@executablemd/acp";
import { parseSessionRoute } from "../../acp/src/native-session-store.ts";
import {
  createFakeRuntime,
  makeRegistry,
  makeStore,
  useFlatWorld,
} from "../../acp/tests/helpers.ts";
import { useTempDirectory } from "@executablemd/test-support/temp";
import { cliBase } from "@executablemd/test-support/launch";

const WORKER = cliBase();

/** The authored journey, and the one target these observe. */
const DOCUMENT = fileURLToPath(new URL("../src/NativeSessionLaunch.test.md", import.meta.url));
const TARGET = "Implementor";

interface Run {
  result: Result<Json>;
  output: string;
  results: readonly TestResult[];
  launches: NativeLaunchRequest[];
  sessions: NativeSessionReport[];
  events: DurableEvent[];
}

interface RunOptions {
  stream?: InMemoryStream;
  /** How the native child exits. Absent means cleanly. */
  exitCode?: number;
  /** Which target to execute. Absent means the launch journey. */
  target?: string;
}

function* runTarget(options: RunOptions = {}): Operation<Run> {
  const launches: NativeLaunchRequest[] = [];
  const sessions: NativeSessionReport[] = [];
  const stream = options.stream ?? new InMemoryStream();
  return yield* scoped(function* () {
    yield* API.Env.around({
      // The document reaches its scenario by a path relative to itself, so the
      // run happens where the document lives.
      // deno-lint-ignore require-yield
      *cwd() {
        return path.dirname(DOCUMENT);
      },
    });
    yield* useHostFiles();
    yield* NativeSessionObserver.set((report) => sessions.push(report));
    yield* NativeLaunchObserver.set({
      record: (request) => launches.push(request),
      ...(options.exitCode === undefined
        ? {}
        : { outcome: () => ({ exitCode: options.exitCode! }) }),
    });
    const testing = yield* useTesting();
    yield* useCommand(WORKER);
    yield* installTestAgentComponents();
    yield* installAgentComponents();

    const execution = yield* execute({
      path: DOCUMENT,
      target: options.target ?? TARGET,
      stream,
    });
    const subscription = yield* execution.output;
    let next = yield* subscription.next();
    while (!next.done) {
      next = yield* subscription.next();
    }
    return {
      result: yield* execution,
      output: next.value,
      results: yield* testing.results,
      launches,
      sessions,
      events: yield* stream.readAll(),
    };
  });
}

/** Which launch phases the journal retained, in order. */
function launchPhases(events: DurableEvent[]): string[] {
  return events.flatMap((event) => {
    if (event.type !== "yield" || event.description.type !== "agent_session_launch") {
      return [];
    }
    return [event.description.name.split("/").at(-1) ?? ""];
  });
}

function preparedRecords(events: DurableEvent[]): Record<string, Json>[] {
  return events.flatMap((event) => {
    if (
      event.type !== "yield" ||
      event.description.type !== "agent_session_launch" ||
      !event.description.name.endsWith("/prepared") ||
      event.result.status !== "ok" ||
      typeof event.result.value !== "object" ||
      event.result.value === null ||
      Array.isArray(event.result.value)
    ) {
      return [];
    }
    return [event.result.value];
  });
}

/**
 * The `Claimed` target's fixture: a real client-allocated provider.
 *
 * That target authors no `<TestAgent>`, because what it is about is a fact
 * about client-allocated agents — the TestAgent asserts its own identity and
 * would refuse for a different reason. So the provider here is the production
 * ACPX one carrying the real `claude` adapter, with the pieces that would
 * reach the host replaced: a scripted runtime, a fake executable of this
 * test's own, a lease that records what it was asked, and a route store in a
 * temporary directory rather than the reader's coordinator namespace.
 */

const CLAUDE_VERSION = "2.1.235 (Claude Code)";

interface ClaimedRun {
  results: readonly TestResult[];
  /** Every session key exclusive live ownership was asked for, in order. */
  leases: string[];
  launches: NativeLaunchRequest[];
  events: DurableEvent[];
  /** What each retained route claims, read as another process would. */
  routes: string[];
  /** Every identity any retained route names. */
  identities: string[];
  /** How many sessions ACP was asked to establish. */
  ensures: number;
}

function* runClaimedTarget(): Operation<ClaimedRun> {
  const root = yield* useTempDirectory("xmd-claimed-");
  const bin = path.join(root, "bin");
  const routeDir = path.join(root, "routes");
  const executable = path.join(bin, "claude");
  yield* until(mkdir(bin, { recursive: true }));
  yield* until(writeFile(executable, `#!/bin/sh\necho "${CLAUDE_VERSION}"\n`));
  yield* until(chmod(executable, 0o755));

  const leases: string[] = [];
  const launches: NativeLaunchRequest[] = [];
  const stream = new InMemoryStream();
  const harness = createFakeRuntime();

  const results = yield* scoped(function* () {
    // A flat world so session placement finds no Git root to walk to, with
    // PATH pointing at this test's claude rather than the host's.
    yield* useFlatWorld(path.dirname(DOCUMENT));
    yield* API.Env.around({
      *env([name], next) {
        return name === "PATH" ? bin : yield* next(name);
      },
    });
    yield* useHostFiles();
    yield* installControlledLauncher({
      record: (request) => launches.push(request),
      outcome: () => ({ exitCode: 0 }),
    });
    yield* SessionLease.around({
      // Recorded and granted. Granting is the harder case: a lease that
      // refused would refuse the launch for its own reason, and this target
      // is about a refusal that happens before ownership is ever asked for.
      // deno-lint-ignore require-yield
      *acquire([key]) {
        leases.push(key);
        return "acquired";
      },
    });

    const testing = yield* useTesting();
    yield* installAgentComponents({
      rootProvider: {
        factory: createAcpxProvider({
          createRuntime: harness.create,
          sessionStore: makeStore(),
          agentRegistry: makeRegistry({ claude: "claude-cmd" }),
          advertiseNativeLaunch: ["claude"],
          nativeSessionStore: createSessionRouteStore(routeDir),
        }),
        options: { defaultAgent: "claude", permissionMode: "deny-all" },
      },
    });

    const execution = yield* execute({ path: DOCUMENT, target: "Claimed", stream });
    const subscription = yield* execution.output;
    let next = yield* subscription.next();
    while (!next.done) {
      next = yield* subscription.next();
    }
    yield* execution;
    return yield* testing.results;
  });

  const entries = yield* until(readdir(routeDir).catch(() => [] as string[]));
  const routes: string[] = [];
  const identities: string[] = [];
  for (const entry of entries.filter((name) => name.endsWith(".json")).sort()) {
    const retained: unknown = JSON.parse(
      yield* until(readFile(path.join(routeDir, entry), "utf8")),
    );
    const parsed = parseSessionRoute(retained);
    routes.push(parsed?.route ?? "unreadable");
    if (parsed?.route === "client-native") {
      identities.push(parsed.nativeSessionId);
    }
  }

  return {
    results,
    leases,
    launches,
    events: yield* stream.readAll(),
    routes,
    identities,
    ensures: harness.ensureCalls.length,
  };
}

describe(
  "Tier TL — native launch through the TestAgent stack",
  {
    sanitizeOps: false,
    sanitizeResources: false,
  },
  () => {
    beforeAll(() => useTempFileCompiler());

    it("TL1: the rendered body installs as the agent's session instruction layer", function* () {
      const run = yield* runTarget();

      expect(run.result.ok ? "" : run.result.error.message).toBe("");
      // `<Session name>` establishes the session first, and the launch installs
      // its instruction layer on it — so exactly one of the agent's sessions
      // carries prepared text, and it is the one the launch prepared.
      const carrying = run.sessions.filter((report) => report.systemPrompt !== undefined);
      expect(carrying.length).toBe(1);
      const instructions = carrying[0]!.systemPrompt ?? "";
      // The agent received the launch body, and only the launch body.
      expect(instructions).toContain("You are the repository implementor.");
      expect(instructions).toContain("Follow the approved plan.");
      expect(instructions).not.toContain("TestAgent");
    });

    it("TL2: the native UI is started with the identity the agent asserted", function* () {
      const run = yield* runTarget();

      expect(run.launches.length).toBe(1);
      const nativeSessionId = run.sessions.at(-1)!.nativeSessionId;
      expect(nativeSessionId.startsWith("native-")).toBe(true);
      expect(run.launches[0]?.command).toEqual(["xmd-test-agent-ui", "--resume", nativeSessionId]);
      // And the retained record names that same identity.
      expect(preparedRecords(run.events)[0]?.nativeSessionId).toBe(nativeSessionId);
    });

    it("TL3: raw prepared instructions never reach argv or environment", function* () {
      const run = yield* runTarget();

      const request = run.launches[0]!;
      expect(request.command.join(" ")).not.toContain("repository implementor");
      expect(JSON.stringify(request.env ?? {})).not.toContain("repository implementor");
    });

    it("TL4: the retained record says XMD allocated nothing for this agent", function* () {
      const run = yield* runTarget();

      // The test agent asserts its own identity, so there is no build to bind
      // and nothing for XMD to allocate. A record claiming otherwise would not
      // survive a replay.
      expect(preparedRecords(run.events)[0]?.identityProvenance).toBe("provider-returned");
      expect(preparedRecords(run.events)[0]?.executableBinding).toBeUndefined();
    });

    it("TL5: a nonzero native exit fails the test that launched", function* () {
      const run = yield* runTarget({ exitCode: 4 });

      expect(run.results.some((result) => result.status === "fail")).toBe(true);
      // The provider session facts survive the failure.
      expect(preparedRecords(run.events)[0]?.nativeSessionId).toBeDefined();
    });

    it("TL7: an authored launch inside an enclosing <Session> refuses identity-unavailable", function* () {
      // The document's `Claimed` target, executed against a real
      // client-allocated provider. `<Session>` established the conversation
      // through ACP first, so the launch is asking to take over a session it
      // did not create — and a route never converts.
      const run = yield* runClaimedTarget();

      // The enclosing `<Session>` did establish its conversation through ACP.
      // Without this the refusal below could be a document that never got
      // that far, which is a different test passing for the wrong reason.
      expect(run.ensures).toBe(1);

      expect(run.results).toHaveLength(1);
      const failed = run.results.filter((result) => result.status === "fail");
      expect(failed).toHaveLength(1);
      expect(JSON.stringify(failed[0])).toContain("cannot take over a session it did not create");

      // Retained as a refusal at `prepared`, and the launch stopped there: no
      // detach phase was journaled, and no native child was started.
      const prepared = preparedRecords(run.events);
      expect(prepared).toHaveLength(1);
      expect(prepared[0]?.failure).toMatchObject({ class: "identity-unavailable" });
      expect(launchPhases(run.events)).toEqual(["prepared"]);
      expect(run.launches).toEqual([]);

      // One route, and it is the claim `<Session>` published. No native
      // mapping was written and no identity was allocated for a launch that
      // never happened.
      expect(run.routes).toEqual(["acp-first"]);
      expect(run.identities).toEqual([]);
      expect(prepared[0]?.nativeSessionId).toBe("");

      // And exclusive live ownership was never asked for: the route answered
      // before there was anything to own.
      expect(run.leases).toEqual([]);
    });

    it("TL8: an authored journey publishes no route into the reader's coordinator namespace", function* () {
      // A `<TestAgent>` boundary retains routes in memory, because its ACPX
      // records are in memory too and a scenario's sessions end with it. The
      // production default is a directory beneath the reader's home that real
      // `xmd` invocations coordinate through — so a journey that fell back to
      // it would be deciding how their sessions were constructed.
      const coordinator = path.join(homedir(), ".acpx", "xmd-native-sessions", "v1");
      const before = yield* until(readdir(coordinator).catch(() => [] as string[]));

      const run = yield* runTarget();

      // The journey really did establish a session, so a route was published
      // somewhere — which is what makes the unchanged directory below mean
      // "elsewhere" rather than "nothing happened".
      expect(run.result.ok).toBe(true);
      expect(run.sessions.length).toBeGreaterThan(0);

      const after = yield* until(readdir(coordinator).catch(() => [] as string[]));
      expect(after.sort()).toEqual(before.sort());
    });

    it("TL6: full replay contacts neither the agent nor the launcher", function* () {
      const stream = new InMemoryStream();
      const first = yield* runTarget({ stream });
      expect(first.result.ok).toBe(true);
      expect(first.launches.length).toBe(1);
      expect(first.sessions.length).toBeGreaterThan(0);

      const second = yield* runTarget({ stream });
      expect(second.result.ok).toBe(true);
      // No agent contacted, no executable observed, no child started.
      expect(second.launches.length).toBe(0);
      expect(second.sessions.length).toBe(0);
    });
  },
);
