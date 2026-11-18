/**
 * Session compatibility across agent CLI releases (#891).
 *
 * The production provider, installed the way a host installs it, over a
 * controlled ACP runtime and executable observer. What these rows read is what
 * an invocation would actually show on standard error and what it actually
 * asked the agent to do: a version change warns once per logical session in one
 * invocation and the retained conversation continues under the provider's live
 * confirmation; nothing about a version admits or refuses.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { Stdio } from "@effectionx/process";
import { all, scoped, until } from "effection";
import type { Operation } from "effection";
import { Agent } from "@executablemd/agent/api";
import type { AcpxProvider, AcpxProviderDependencies } from "@executablemd/acp";
import { embeddedAdapterDependencies } from "@executablemd/acp/embedded-adapters";
import { useAcpxProvider } from "../../acp/src/provider.ts";
import { createMemorySessionRouteStore } from "../../acp/src/session-route.ts";
import type { AgentSessionRouteStore } from "../../acp/src/session-route.ts";
import {
  createFakeObserver,
  createFakeRuntime,
  makeCoordinator,
  makeRegistry,
  makeStore,
  useFlatWorld,
} from "../../acp/tests/helpers.ts";
import type {
  CoordinatorHarness,
  FakeObserverHarness,
  FakeRuntimeHarness,
} from "../../acp/tests/helpers.ts";
import { ADAPTERS } from "./support/plan-harness.ts";

const CWD = "/work";

/** What one product reports at two releases, and the selector it is chosen by. */
const PRODUCTS = {
  codex: {
    name: "Codex",
    before: "codex-cli 0.167.1\n",
    after: "codex-cli 0.169.1\n",
    variable: "CODEX_PATH",
    command: "codex-cmd",
  },
  claude: {
    name: "Claude",
    before: "2.1.241 (Claude Code)\n",
    after: "2.1.250 (Claude Code)\n",
    variable: "CLAUDE_CODE_EXECUTABLE",
    command: "claude-cmd",
  },
} as const;

type Product = keyof typeof PRODUCTS;

/** The provider state one host keeps across its invocations. */
interface Machine {
  readonly store: ReturnType<typeof makeStore>;
  readonly routes: AgentSessionRouteStore;
  readonly ownership: CoordinatorHarness;
  readonly observer: FakeObserverHarness;
}

function machine(product: Product): Machine {
  return {
    store: makeStore(),
    routes: createMemorySessionRouteStore(),
    ownership: makeCoordinator(),
    observer: createFakeObserver({
      path: `/selected/${product}`,
      versionOutput: PRODUCTS[product].before,
    }),
  };
}

/** Every line this scope's operations wrote to standard error. */
function* stderr(fail?: Error): Operation<string[]> {
  const lines: string[] = [];
  const decoder = new TextDecoder();
  yield* Stdio.around({
    // deno-lint-ignore require-yield
    *stderr([bytes]) {
      if (fail !== undefined) {
        throw fail;
      }
      lines.push(
        ...decoder
          .decode(bytes)
          .split("\n")
          .filter((line) => line.length > 0),
      );
    },
    // deno-lint-ignore require-yield
    *stdout() {
      throw new Error("a compatibility diagnostic reached standard output");
    },
  });
  return lines;
}

/**
 * Install one provider for `product` over this host's state, as the CLI does:
 * the built-in adapter, the host's own selection, and the invocation's set.
 */
let provider: AcpxProvider | undefined;

function* install(
  product: Product,
  host: Machine,
  harness: FakeRuntimeHarness,
  extra: Partial<AcpxProviderDependencies> = {},
): Operation<void> {
  const { variable, command } = PRODUCTS[product];
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
      agentRegistry: makeRegistry({ [product]: command }),
      coordinator: host.ownership.coordinator,
      routeStore: host.routes,
      executableObserver: host.observer.observer,
      advertiseNativeLaunch: [product],
      advertiseClientNativeAttachment: product === "claude" ? ["claude"] : [],
      // deno-lint-ignore require-yield
      *agentProcessEnv() {
        return { [variable]: `/selected/${product}` };
      },
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

/** Establish a session in one invocation, under the release recorded as its history. */
function* establish(product: Product, host: Machine, session = "review"): Operation<void> {
  yield* scoped(function* () {
    yield* useFlatWorld(CWD);
    const lines = yield* stderr();
    yield* install(product, host, createFakeRuntime(), {
      compatibilityWarnings: new Set<string>(),
    });
    yield* prompt("seed", session);
    expect(lines).toEqual([]);
  });
}

function changed(product: Product): string {
  const { name } = PRODUCTS[product];
  const [from, to] =
    product === "codex" ? ["0.167.1", "0.169.1"] : (["2.1.241", "2.1.250"] as const);
  return (
    `${name} has changed from ${from} to ${to} since this session was established. ` +
    `Continuing the existing conversation.`
  );
}

describe("SC — a CLI release change warns and continues", () => {
  for (const product of ["codex", "claude"] as const) {
    it(`SC1 (${product}): an upgraded executable continues the retained conversation and warns once`, function* () {
      const host = machine(product);
      yield* establish(product, host);
      const established = yield* until(host.store.load([...host.store.records.keys()][0]!));
      expect(established?.agentSessionId).toBeDefined();
      const route = yield* host.routes.read({
        provider: "acpx",
        agent: PRODUCTS[product].command,
        sessionKey: established!.acpxRecordId,
      });
      expect(route?.schema).toBe("session-route.v3");

      host.observer.observation.versionOutput = PRODUCTS[product].after;
      host.observer.observation.digest = "b".repeat(64);
      const harness = createFakeRuntime();
      yield* scoped(function* () {
        yield* useFlatWorld(CWD);
        const lines = yield* stderr();
        yield* install(product, host, harness, {
          compatibilityWarnings: new Set<string>(),
        });

        yield* prompt("first after the upgrade");
        yield* prompt("second after the upgrade");

        // One warning, before the live work it concerns, and no repetition.
        expect(lines).toEqual([changed(product)]);
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
        [PRODUCTS[product].variable]: `/selected/${product}`,
      });
      // History is not rewritten to claim today's executable made it.
      expect(
        yield* host.routes.read({
          provider: "acpx",
          agent: PRODUCTS[product].command,
          sessionKey: established!.acpxRecordId,
        }),
      ).toEqual(route);
    });
  }

  it("SC2: one invocation set spans installations; a second session and a new invocation each warn", function* () {
    const host = machine("codex");
    yield* establish("codex", host, "review");
    yield* establish("codex", host, "build");
    host.observer.observation.versionOutput = PRODUCTS.codex.after;

    const invocation = new Set<string>();
    const runs: string[][] = [];
    for (const installation of ["root", "nested"]) {
      yield* scoped(function* () {
        yield* useFlatWorld(CWD);
        const lines = yield* stderr();
        yield* install("codex", host, createFakeRuntime(), {
          compatibilityWarnings: invocation,
        });
        yield* prompt(`${installation} review`, "review");
        if (installation === "nested") {
          yield* prompt("nested build", "build");
        }
        runs.push(lines);
      });
    }
    // The nested installation shares the invocation's set: the reviewed session
    // is not repeated, and the second session gets its own warning.
    expect(runs).toEqual([[changed("codex")], [changed("codex")]]);
    expect(invocation.size).toBe(2);

    // A new invocation starts with nothing and may warn again.
    yield* scoped(function* () {
      yield* useFlatWorld(CWD);
      const lines = yield* stderr();
      yield* install("codex", host, createFakeRuntime(), {
        compatibilityWarnings: new Set(),
      });
      yield* prompt("next invocation", "review");
      expect(lines).toEqual([changed("codex")]);
    });
  });

  it("SC3: distinct placements of one session name warn separately", function* () {
    const host = machine("codex");
    for (const cwd of ["/work/a", "/work/b"]) {
      yield* scoped(function* () {
        yield* useFlatWorld(cwd);
        yield* install("codex", host, createFakeRuntime(), {
          compatibilityWarnings: new Set(),
        });
        yield* prompt("seed", "review");
      });
    }
    host.observer.observation.versionOutput = PRODUCTS.codex.after;
    const invocation = new Set<string>();
    const shown: string[] = [];
    for (const cwd of ["/work/a", "/work/b"]) {
      yield* scoped(function* () {
        yield* useFlatWorld(cwd);
        const lines = yield* stderr();
        yield* install("codex", host, createFakeRuntime(), {
          compatibilityWarnings: invocation,
        });
        yield* prompt("continue", "review");
        shown.push(...lines);
      });
    }
    expect(shown).toEqual([changed("codex"), changed("codex")]);
  });

  it("SC4: an embedding host that omits the set gets one per installation", function* () {
    const host = machine("codex");
    yield* establish("codex", host);
    host.observer.observation.versionOutput = PRODUCTS.codex.after;
    const shown: string[] = [];
    for (const _ of [1, 2]) {
      yield* scoped(function* () {
        yield* useFlatWorld(CWD);
        const lines = yield* stderr();
        yield* install("codex", host, createFakeRuntime());
        yield* prompt("continue");
        yield* prompt("again");
        shown.push(...lines);
      });
    }
    expect(shown).toEqual([changed("codex"), changed("codex")]);
  });

  it("SC5: concurrent first uses of one session deliver one warning", function* () {
    const host = machine("codex");
    yield* establish("codex", host, "review");
    yield* establish("codex", host, "build");
    host.observer.observation.versionOutput = PRODUCTS.codex.after;
    const invocation = new Set<string>();
    const shown: string[] = [];
    yield* scoped(function* () {
      yield* useFlatWorld(CWD);
      const lines = yield* stderr();
      yield* install("codex", host, createFakeRuntime(), {
        compatibilityWarnings: invocation,
      });
      yield* all([prompt("one", "review"), prompt("two", "review"), prompt("three", "build")]);
      shown.push(...lines);
    });
    expect(shown).toEqual([changed("codex"), changed("codex")]);
    expect(invocation.size).toBe(2);
  });

  it("SC6: a diagnostic that cannot be written is a host I/O failure, never model work", function* () {
    const host = machine("codex");
    yield* establish("codex", host);
    host.observer.observation.versionOutput = PRODUCTS.codex.after;
    const harness = createFakeRuntime();
    let raised: Error | undefined;
    yield* scoped(function* () {
      yield* useFlatWorld(CWD);
      yield* stderr(new Error("standard error is closed"));
      yield* install("codex", host, harness, {
        compatibilityWarnings: new Set(),
      });
      try {
        yield* prompt("continue");
      } catch (error) {
        raised = error as Error;
      }
    });
    expect(raised?.message).toBe("standard error is closed");
    // Nothing was reopened, replaced or retried on its account.
    expect(harness.ensureCalls).toEqual([]);
    expect(harness.turns).toEqual([]);
  });
});

describe("SV — what a version observation can and cannot say", () => {
  it("SV1: unrecognized or private version output says only that it is undetermined", function* () {
    const host = machine("codex");
    yield* establish("codex", host);
    host.observer.observation.versionOutput = "codex-cli 0.169.1 built at /home/private/secret\n";
    const harness = createFakeRuntime();
    yield* scoped(function* () {
      yield* useFlatWorld(CWD);
      const lines = yield* stderr();
      yield* install("codex", host, harness, {
        compatibilityWarnings: new Set(),
      });
      expect(yield* prompt("continue")).toBe("hello world");
      expect(lines).toEqual(["The Codex version could not be determined. Continuing."]);
      expect(lines.join("\n")).not.toContain("/home/private");
      expect(lines.join("\n")).not.toContain("/selected");
    });
    expect(harness.turns).toHaveLength(1);
  });

  it("SV2: a fresh session under a release no evidence names works, with no warning", function* () {
    const host = machine("claude");
    host.observer.observation.versionOutput = "9.0.0 (Claude Code)\n";
    const harness = createFakeRuntime();
    yield* scoped(function* () {
      yield* useFlatWorld(CWD);
      const lines = yield* stderr();
      yield* install("claude", host, harness, {
        compatibilityWarnings: new Set(),
      });
      expect(yield* prompt("first")).toBe("hello world");
      expect(lines).toEqual([]);
    });
  });

  it("SV3: history without a recorded version continues without a difference warning", function* () {
    const host = machine("codex");
    yield* establish("codex", host);
    // Rewritten here only to stand for a session established before XMD kept
    // executable history: the released unbound form of the same route.
    const key = [...host.store.records.keys()][0]!;
    const tuple = {
      provider: "acpx",
      agent: PRODUCTS.codex.command,
      sessionKey: key,
    };
    const legacy = createMemorySessionRouteStore();
    yield* legacy.publish({
      schema: "session-route.v1",
      route: "acp-first",
      ...tuple,
    });
    const before = yield* legacy.read(tuple);
    host.observer.observation.versionOutput = PRODUCTS.codex.after;
    const harness = createFakeRuntime();
    yield* scoped(function* () {
      yield* useFlatWorld(CWD);
      const lines = yield* stderr();
      yield* install("codex", { ...host, routes: legacy }, harness, {
        compatibilityWarnings: new Set(),
      });
      expect(yield* prompt("continue")).toBe("hello world");
      expect(lines).toEqual([]);
    });
    expect(harness.ensureCalls[0]?.expectedAgentSessionId).toBeDefined();
    expect(yield* legacy.read(tuple)).toEqual(before);
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
        compatibilityWarnings: new Set(),
      });
      expect(yield* prompt("through the wrapper")).toBe("hello world");
      // The wrapper's backend is not guessed at: its version is undetermined.
      expect(lines).toEqual(["The Codex version could not be determined. Continuing."]);
    });
    expect(host.observer.observed).toEqual([]);
    const options = harness.createdOptions.at(-1);
    expect(options?.agentRegistry.resolve("codex")).toBe("my-wrapper --acp");
    expect(options?.agentProcessEnv ?? {}).toEqual({});
    expect(harness.turns).toHaveLength(1);
  });

  it("SV5: a selected executable that cannot run is an availability failure", function* () {
    const host = machine("codex");
    host.observer.failure = "not-found";
    const harness = createFakeRuntime();
    let raised: Error | undefined;
    yield* scoped(function* () {
      yield* useFlatWorld(CWD);
      const lines = yield* stderr();
      yield* install("codex", host, harness, {
        compatibilityWarnings: new Set(),
      });
      try {
        yield* prompt("first");
      } catch (error) {
        raised = error as Error;
      }
      expect(lines).toEqual([]);
    });
    expect(raised?.message).toContain("is unavailable");
    expect(harness.ensureCalls).toEqual([]);
  });
});
