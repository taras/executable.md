/**
 * Session continuation across agent CLI releases (#891).
 *
 * The production provider, installed the way a host installs it, over a
 * controlled ACP runtime and the host's own executable selection. What these
 * rows read is what an invocation actually asked the agent to do, and what it
 * wrote to standard error: the retained conversation continues on today's
 * selected executable under the provider's live confirmation of its native
 * identity, quietly. Nothing about an executable's version admits, refuses or
 * reports.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { Stdio } from "@effectionx/process";
import { scoped, until } from "effection";
import type { Operation } from "effection";
import { Agent } from "@executablemd/agent/api";
import type { AcpxProvider, AcpxProviderDependencies } from "@executablemd/acp";
import { embeddedAdapterDependencies } from "@executablemd/acp/embedded-adapters";
import { useAcpxProvider } from "../../acp/src/provider.ts";
import { createMemorySessionRouteStore } from "../../acp/src/session-route.ts";
import type { AgentSessionRouteStore } from "../../acp/src/session-route.ts";
import {
  createFakeRuntime,
  createFakeSelection,
  makeCoordinator,
  makeRegistry,
  makeStore,
  useFlatWorld,
} from "../../acp/tests/helpers.ts";
import type {
  CoordinatorHarness,
  FakeRuntimeHarness,
  FakeSelectionHarness,
} from "../../acp/tests/helpers.ts";
import { ADAPTERS } from "./support/plan-harness.ts";

const CWD = "/work";

/** The selector variable and registered command for each supported product. */
const PRODUCTS = {
  codex: { variable: "CODEX_PATH", command: "codex-cmd" },
  claude: { variable: "CLAUDE_CODE_EXECUTABLE", command: "claude-cmd" },
} as const;

type Product = keyof typeof PRODUCTS;

/** The provider state one host keeps across its invocations. */
interface Machine {
  readonly store: ReturnType<typeof makeStore>;
  readonly routes: AgentSessionRouteStore;
  readonly ownership: CoordinatorHarness;
  readonly selection: FakeSelectionHarness;
}

function machine(product: Product): Machine {
  return {
    store: makeStore(),
    routes: createMemorySessionRouteStore(),
    ownership: makeCoordinator(),
    selection: createFakeSelection(`/selected/${product}-0.167.1`),
  };
}

/** Every line this scope's operations wrote to standard error. */
function* stderr(): Operation<string[]> {
  const lines: string[] = [];
  const decoder = new TextDecoder();
  yield* Stdio.around({
    // deno-lint-ignore require-yield
    *stderr([bytes]) {
      lines.push(
        ...decoder
          .decode(bytes)
          .split("\n")
          .filter((line) => line.length > 0),
      );
    },
  });
  return lines;
}

let provider: AcpxProvider | undefined;

/**
 * Install one provider for `product` over this host's state, as the CLI does:
 * the built-in adapter and the host's own selection.
 */
function* install(
  product: Product,
  host: Machine,
  harness: FakeRuntimeHarness,
  extra: Partial<AcpxProviderDependencies> = {},
): Operation<void> {
  // The agent a Prompt that names none means, as the installed chain answers it.
  yield* Agent.around(
    {
      // deno-lint-ignore require-yield
      *agent([name]) {
        return name ?? product;
      },
    },
    { at: "min" },
  );
  provider = yield* useAcpxProvider(
    { defaultAgent: product, permissionMode: "deny-all" },
    {
      createRuntime: harness.create,
      sessionStore: host.store,
      agentRegistry: makeRegistry({ [product]: PRODUCTS[product].command }),
      coordinator: host.ownership.coordinator,
      routeStore: host.routes,
      advertiseNativeLaunch: [product],
      advertiseClientNativeAttachment: product === "claude" ? ["claude"] : [],
      agentProcessEnv: host.selection.agentProcessEnv(),
      ...extra,
    },
  );
}

/** Run one Prompt to completion and return its text. */
function* prompt(text: string, session = "review"): Operation<string> {
  return yield* scoped(function* () {
    if (provider === undefined) {
      throw new Error("no provider is installed");
    }
    const subscription = yield* provider.promptStream(text, { session });
    let next = yield* subscription.next();
    while (!next.done) {
      next = yield* subscription.next();
    }
    return next.value;
  });
}

/** Establish a session in one invocation. */
function* establish(product: Product, host: Machine, session = "review"): Operation<void> {
  yield* scoped(function* () {
    yield* useFlatWorld(CWD);
    const lines = yield* stderr();
    yield* install(product, host, createFakeRuntime());
    yield* prompt("seed", session);
    expect(lines).toEqual([]);
  });
}

describe("SC — a changed executable continues the same conversation, quietly", () => {
  for (const product of ["codex", "claude"] as const) {
    it(`SC1 (${product}): today's selected executable continues the retained conversation`, function* () {
      const host = machine(product);
      yield* establish(product, host);
      const established = yield* until(host.store.load([...host.store.records.keys()][0]!));
      expect(established?.agentSessionId).toBeDefined();
      const tuple = {
        provider: "acpx",
        agent: PRODUCTS[product].command,
        sessionKey: established!.acpxRecordId,
      };
      // A fresh route records how the session was constructed and nothing about
      // the executable that constructed it.
      const route = yield* host.routes.read(tuple);
      expect(route).toEqual({ schema: "session-route.v1", route: "acp-first", ...tuple });

      host.selection.path = `/selected/${product}-0.169.1`;
      const harness = createFakeRuntime();
      yield* scoped(function* () {
        yield* useFlatWorld(CWD);
        const lines = yield* stderr();
        yield* install(product, host, harness);

        yield* prompt("first after the upgrade");
        yield* prompt("second after the upgrade");

        expect(lines).toEqual([]);
      });
      // Each operation reopened the exact retained conversation and required
      // the provider's live confirmation of its native identity first.
      expect(harness.ensureCalls.length).toBeGreaterThan(0);
      for (const call of harness.ensureCalls) {
        expect(call.resumeSessionId).toBe(established?.acpSessionId);
        expect(call.expectedAgentSessionId).toBe(established?.agentSessionId);
        expect(call.materialization).toBe(undefined);
      }
      expect(harness.turns.map((turn) => turn.input.text)).toEqual([
        "first after the upgrade",
        "second after the upgrade",
      ]);
      // Through the executable the current environment selected.
      expect(harness.createdOptions[0]?.agentProcessEnv).toEqual({
        [PRODUCTS[product].variable]: `/selected/${product}-0.169.1`,
      });
      // Nothing was written to say today's executable made this session.
      expect(yield* host.routes.read(tuple)).toEqual(route);
    });
  }
});

describe("SV — what selection can and cannot decide", () => {
  it("SV1: a replaced file at the same selected path continues without a word", function* () {
    const host = machine("codex");
    yield* establish("codex", host);
    // The same path, other bytes: nothing about the file is read.
    const harness = createFakeRuntime();
    yield* scoped(function* () {
      yield* useFlatWorld(CWD);
      const lines = yield* stderr();
      yield* install("codex", host, harness);
      expect(yield* prompt("continue")).toBe("hello world");
      expect(lines).toEqual([]);
    });
    expect(harness.turns).toHaveLength(1);
    expect(harness.ensureCalls[0]?.expectedAgentSessionId).toBeDefined();
  });

  it("SV2: a fresh session under a release no evidence names works, quietly", function* () {
    const host = machine("claude");
    host.selection.path = "/selected/claude-9.0.0";
    const harness = createFakeRuntime();
    yield* scoped(function* () {
      yield* useFlatWorld(CWD);
      const lines = yield* stderr();
      yield* install("claude", host, harness);
      expect(yield* prompt("first")).toBe("hello world");
      expect(lines).toEqual([]);
    });
    expect(harness.createdOptions[0]?.agentProcessEnv).toEqual({
      CLAUDE_CODE_EXECUTABLE: "/selected/claude-9.0.0",
    });
  });

  it("SV3: an earlier release's bound route continues, unchanged and unrewritten", function* () {
    const host = machine("codex");
    yield* establish("codex", host);
    const key = [...host.store.records.keys()][0]!;
    const tuple = { provider: "acpx", agent: PRODUCTS.codex.command, sessionKey: key };
    // The route an earlier release published, carrying the executable history
    // it recorded then. It is original evidence, read and left as it was.
    const earlier = createMemorySessionRouteStore();
    yield* earlier.publish({
      schema: "session-route.v3",
      route: "acp-first",
      ...tuple,
      executableBinding: {
        schema: "executable-build.v1",
        reportedVersion: "codex-cli 0.153.2",
        executableDigest: { algorithm: "sha256", value: "a".repeat(64) },
      },
    });
    const before = yield* earlier.read(tuple);
    host.selection.path = "/selected/codex-0.169.1";
    const harness = createFakeRuntime();
    yield* scoped(function* () {
      yield* useFlatWorld(CWD);
      const lines = yield* stderr();
      yield* install("codex", { ...host, routes: earlier }, harness);
      expect(yield* prompt("continue")).toBe("hello world");
      expect(lines).toEqual([]);
    });
    expect(harness.ensureCalls[0]?.expectedAgentSessionId).toBeDefined();
    expect(yield* earlier.read(tuple)).toEqual(before);
  });

  it("SV4: a custom command named codex keeps its own command and selects nothing", function* () {
    const host = machine("codex");
    const { agentProcessEnv } = embeddedAdapterDependencies(ADAPTERS);
    const harness = createFakeRuntime();
    yield* scoped(function* () {
      yield* useFlatWorld(CWD);
      const lines = yield* stderr();
      yield* install("codex", host, harness, {
        agentRegistry: makeRegistry({ codex: "my-wrapper --acp" }),
        ...(agentProcessEnv === undefined ? {} : { agentProcessEnv }),
      });
      expect(yield* prompt("through the wrapper")).toBe("hello world");
      // The wrapper's backend is not guessed at, and nothing is said about it.
      expect(lines).toEqual([]);
    });
    const options = harness.createdOptions.at(-1);
    expect(options?.agentRegistry.resolve("codex")).toBe("my-wrapper --acp");
    expect(options?.agentProcessEnv ?? {}).toEqual({});
    expect(harness.turns).toHaveLength(1);
  });

  it("SV5: a selection that cannot run is an availability failure, in the selector's words", function* () {
    const host = machine("codex");
    host.selection.failure = new Error(
      "Host Codex is unavailable. Install codex on the host PATH or correct CODEX_PATH to " +
        "select a launchable host executable.",
    );
    const harness = createFakeRuntime();
    let raised: Error | undefined;
    yield* scoped(function* () {
      yield* useFlatWorld(CWD);
      yield* install("codex", host, harness);
      try {
        yield* prompt("first");
      } catch (error) {
        raised = error as Error;
      }
    });
    expect(raised?.message).toContain("Host Codex is unavailable");
    expect(raised?.message).toContain("CODEX_PATH");
    expect(harness.ensureCalls).toEqual([]);
    expect(harness.turns).toEqual([]);
  });
});
