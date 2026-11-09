/**
 * Tier CR — an explicit Claude selection across cold reconnects (#1177).
 *
 * The provider gives up its handle after every owned operation, so the next one
 * reconnects: a fresh adapter child resumes the same conversation. Two layers
 * used to act on that resume before any prompt — the adapter reasserted the
 * global model preference, and ACPX replayed the saved selection back — so each
 * prompt cost a switch away and a switch back.
 *
 * Everything here runs the production artifacts: the real ACPX runtime, the
 * packaged Claude adapter this build prepared, spawned as a real child, over the
 * stateful fake CLI. The fake persists each conversation's model and effort the
 * way a transcript does, logs every model write by name and records the model
 * each prompt actually ran under, so what is asserted is the work the backend
 * received — not which records were hidden.
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, scoped, until } from "effection";
import type { Operation } from "effection";
import { ensureDir, readTextFile, rm, writeTextFile } from "@effectionx/fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAcpRuntime, createSharedAcpRuntime } from "../src/acpx-runtime.ts";
import type {
  AcpRuntimeEnsureInput,
  AcpRuntimeHandle,
  AcpSessionRecord,
} from "../src/acpx-runtime.ts";
import { createEmbeddedAdapters } from "../src/adapter-snapshots.ts";
import type { EmbeddedAdapters } from "../src/adapter-snapshots.ts";
import { Agent, sessionOf } from "@executablemd/core";
import type { AgentLaunchCoordinator, Session, SessionConfiguration } from "@executablemd/core";
import { openSessionRequest } from "../../core/src/agent/session-request.ts";
import { createSessionSetupOwner } from "../../core/src/agent/session-setup.ts";
import { createAcpxProvider } from "../src/provider.ts";
import { makeCoordinator, makeRegistry, useFlatWorld } from "./helpers.ts";

const FAKE_CLAUDE = fileURLToPath(new URL("./fixtures/fake-claude-cli.cjs", import.meta.url));

/** The exact offered id a Sidekick selects, distinct from the global alias. */
const EXPLICIT = "claude-fable-5";
const ANOTHER = "claude-sonnet-5-5";

/** One entry the fake CLI logged. */
interface Logged {
  readonly event?: string;
  readonly control?: string;
  readonly session?: string;
  readonly model?: string;
  readonly effort?: string | null;
  readonly resumed?: boolean;
  readonly argv?: string[];
}

interface World {
  readonly root: string;
  readonly state: string;
  readonly log: string;
  readonly adapters: EmbeddedAdapters;
  readonly records: Map<string, AcpSessionRecord>;
}

/**
 * A private Claude home, conversation state and adapter install.
 *
 * `CLAUDE_CONFIG_DIR` points at this world's own settings, so the global model
 * a case configures is this one's and never the user's.
 */
function* useWorld(globalModel?: string): Operation<World> {
  const root = yield* until(mkdtemp(join(tmpdir(), "xmd-cr-")));
  yield* ensure(() => rm(root, { recursive: true, force: true }));
  const config = join(root, "config");
  const state = join(root, "state");
  yield* ensureDir(config);
  yield* ensureDir(state);
  yield* writeTextFile(
    join(config, "settings.json"),
    JSON.stringify(globalModel === undefined ? {} : { model: globalModel }),
  );
  const adapters = createEmbeddedAdapters(join(root, "adapters"));
  yield* adapters.materialize("claude");
  return { root, state, log: join(root, "cli.log"), adapters, records: new Map() };
}

function runtimeFor(world: World, env: Record<string, string> = {}) {
  return createAcpRuntime({
    cwd: world.root,
    sessionStore: {
      load: (id) => Promise.resolve(structuredClone(world.records.get(id))),
      save: (record) => {
        world.records.set(record.acpxRecordId, structuredClone(record));
        return Promise.resolve();
      },
    },
    agentRegistry: { resolve: () => world.adapters.command("claude"), list: () => ["claude"] },
    permissionMode: "approve-all",
    nonInteractivePermissions: "deny",
    agentProcessEnv: {
      CLAUDE_CODE_EXECUTABLE: FAKE_CLAUDE,
      CLAUDE_CONFIG_DIR: join(world.root, "config"),
      FAKE_CLAUDE_LOG: world.log,
      FAKE_CLAUDE_STATE_DIR: world.state,
      ANTHROPIC_MODEL: "",
      ...env,
    },
  });
}

type Runtime = ReturnType<typeof runtimeFor>;

function* logged(world: World): Operation<Logged[]> {
  let text = "";
  try {
    text = yield* readTextFile(world.log);
  } catch {
    return [];
  }
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

/** What a span of the log says, in the terms the acceptance is stated in. */
function observed(entries: Logged[]) {
  return {
    modelWrites: entries.filter((entry) => entry.control === "set_model").map((e) => e.model),
    prompts: entries
      .filter((entry) => entry.event === "prompt")
      .map((entry) => ({ session: entry.session, model: entry.model, effort: entry.effort })),
  };
}

const KEY = "cr";

function input(world: World, hasExplicitModel?: boolean): AcpRuntimeEnsureInput {
  return {
    sessionKey: KEY,
    agent: "claude",
    mode: "persistent",
    cwd: world.root,
    ...(hasExplicitModel === undefined ? {} : { hasExplicitModel }),
  };
}

/** One owned prompt the way the provider runs it: ensure, turn, release. */
function* ownedTurn(
  world: World,
  runtime: Runtime,
  text: string,
  hasExplicitModel?: boolean,
): Operation<{ status: string }> {
  return yield* scoped(function* () {
    const handle = yield* until(runtime.ensureSession(input(world, hasExplicitModel)));
    yield* ensure(() =>
      until(runtime.close({ handle, reason: "released after the owned prompt" })),
    );
    const turn = runtime.startTurn({
      handle,
      text,
      mode: "prompt",
      requestId: text,
      ...(hasExplicitModel === undefined ? {} : { hasExplicitModel }),
    });
    const result = yield* until(turn.result);
    return { status: result.status };
  });
}

/** One owned configuration write: ensure, write, release. */
function* ownedWrite(
  world: World,
  runtime: Runtime,
  key: string,
  value: string,
  hasExplicitModel?: boolean,
): Operation<AcpRuntimeHandle> {
  return yield* scoped(function* () {
    const handle = yield* until(runtime.ensureSession(input(world, hasExplicitModel)));
    yield* ensure(() => until(runtime.close({ handle, reason: "released after the owned write" })));
    yield* until(
      runtime.setConfigOption({
        handle,
        key,
        value,
        ...(hasExplicitModel === undefined ? {} : { hasExplicitModel }),
      }),
    );
    return handle;
  });
}

/** A conversation that exists, has run under `model` (and `effort`), and is released. */
function* established(
  world: World,
  runtime: Runtime,
  model: string,
  effort?: string,
): Operation<void> {
  yield* ownedWrite(world, runtime, "model", model, true);
  if (effort !== undefined) {
    yield* ownedWrite(world, runtime, "effort", effort, true);
  }
  yield* ownedTurn(world, runtime, "first", true);
}

describe(
  "Tier CR — explicit Claude selection across cold reconnects",
  {
    sanitizeOps: false,
    sanitizeResources: false,
  },
  () => {
    it("CR1: conflicting global settings cause no model write over repeated cold prompts", function* () {
      const world = yield* useWorld("fable");
      yield* scoped(function* () {
        const runtime = runtimeFor(world);
        yield* ensure(() => until(runtime.shutdown()));
        yield* established(world, runtime, EXPLICIT, "high");
        const before = (yield* logged(world)).length;
        // The one necessary write is the initial selection.
        expect(observed(yield* logged(world)).modelWrites).toEqual([EXPLICIT]);

        for (const text of ["second", "third", "fourth"]) {
          expect(yield* ownedTurn(world, runtime, text, true)).toEqual({ status: "completed" });
        }

        const entries = (yield* logged(world)).slice(before);
        const { modelWrites, prompts } = observed(entries);
        // Neither the global alias nor the saved selection is written back.
        expect(modelWrites).toEqual([]);
        const session = prompts[0]?.session;
        expect(session).toBeDefined();
        // The same conversation, model and effort on every prompt.
        expect(prompts).toEqual([
          { session, model: EXPLICIT, effort: "high" },
          { session, model: EXPLICIT, effort: "high" },
          { session, model: EXPLICIT, effort: "high" },
        ]);
        // Every prompt was a cold reconnect: a fresh child resumed the same
        // conversation, and each child closed before the next began.
        const starts = entries.filter((entry) => entry.event === "started");
        expect(starts.map((entry) => [entry.session, entry.resumed])).toEqual([
          [session, true],
          [session, true],
          [session, true],
        ]);
        expect(entries.filter((entry) => entry.event === "exit").length).toBe(3);
      });
    });

    it("CR2: a cold non-model write and a genuine change keep exactly the necessary writes", function* () {
      const world = yield* useWorld("fable");
      yield* scoped(function* () {
        const runtime = runtimeFor(world);
        yield* ensure(() => until(runtime.shutdown()));
        yield* established(world, runtime, EXPLICIT);
        yield* ownedWrite(world, runtime, "effort", "high", true);
        const before = (yield* logged(world)).length;

        // A cold control reconnect for another setting writes no model.
        yield* ownedWrite(world, runtime, "effort", "low", true);
        expect(observed((yield* logged(world)).slice(before)).modelWrites).toEqual([]);

        // A genuine change is written once, exactly, and verified in status
        // before the next prompt — which then runs under it with no write.
        const changed = yield* ownedWrite(world, runtime, "model", ANOTHER, true);
        const status = yield* until(runtime.getStatus({ handle: changed }));
        expect(status.models?.currentModelId).toBe(ANOTHER);
        // The new model's effort choices are refreshed, so the configured
        // effort is written for it, as session configuration does.
        yield* ownedWrite(world, runtime, "effort", "low", true);
        yield* ownedTurn(world, runtime, "after the change", true);
        const after = observed((yield* logged(world)).slice(before));
        expect(after.modelWrites).toEqual([ANOTHER]);
        expect(after.prompts.map((prompt) => [prompt.model, prompt.effort])).toEqual([
          [ANOTHER, "low"],
        ]);
      });
    });

    it("CR3: an unflagged use keeps the provider-default behavior, even after a flagged one", function* () {
      const world = yield* useWorld("fable");
      yield* scoped(function* () {
        const runtime = runtimeFor(world);
        yield* ensure(() => until(runtime.shutdown()));
        // Never configured: the global preference governs, as it always has,
        // and each resume reasserts it.
        yield* ownedTurn(world, runtime, "first");
        yield* ownedTurn(world, runtime, "second");
        const unconfigured = observed(yield* logged(world));
        expect(unconfigured.prompts.map((prompt) => prompt.model)).toEqual([
          "claude-fable-5-1",
          "claude-fable-5-1",
        ]);
        expect(unconfigured.modelWrites).toEqual(["fable"]);
      });

      const flagged = yield* useWorld("fable");
      yield* scoped(function* () {
        const runtime = runtimeFor(flagged);
        yield* ensure(() => until(runtime.shutdown()));
        // A flagged use leaves nothing behind for a later unflagged one: that
        // reconnect reasserts the global preference and the saved selection is
        // replayed over it, exactly as before.
        yield* established(flagged, runtime, EXPLICIT);
        const before = (yield* logged(flagged)).length;
        yield* ownedTurn(flagged, runtime, "unflagged");
        const after = observed((yield* logged(flagged)).slice(before));
        expect(after.modelWrites).toEqual(["fable", EXPLICIT]);
        expect(after.prompts.map((prompt) => prompt.model)).toEqual([EXPLICIT]);
      });
    });

    it("CR4: the presence fact reaches only the reconnect and is never retained", function* () {
      const world = yield* useWorld("fable");
      yield* scoped(function* () {
        const runtime = runtimeFor(world);
        yield* ensure(() => until(runtime.shutdown()));
        yield* established(world, runtime, EXPLICIT);
        yield* ownedTurn(world, runtime, "again", true);
        const durable = JSON.stringify([...world.records.values()]);
        expect(durable).not.toContain("has-explicit-model");
        expect(durable).not.toContain("hasExplicitModel");
        // It never reaches Claude Code's own options or arguments either.
        const launches = (yield* logged(world)).filter((entry) => entry.argv !== undefined);
        expect(JSON.stringify(launches)).not.toContain("has-explicit-model");
        const handle = yield* until(runtime.ensureSession(input(world, true)));
        expect(JSON.stringify(handle)).not.toContain("xplicit");
        yield* until(runtime.close({ handle, reason: "inspected" }));

        // A malformed fact refuses before any effect.
        const starts = (yield* logged(world)).length;
        const malformed = { ...input(world), hasExplicitModel: "yes" as unknown as boolean };
        const refusal = yield* until(
          runtime.ensureSession(malformed).then(
            () => "",
            (error: Error) => error.message,
          ),
        );
        expect(refusal).toContain("hasExplicitModel must be a boolean");
        expect((yield* logged(world)).length).toBe(starts);
      });
    });

    it("CR5: an external change while released is observed and the exact selection applied", function* () {
      const world = yield* useWorld("fable");
      yield* scoped(function* () {
        const runtime = runtimeFor(world);
        yield* ensure(() => until(runtime.shutdown()));
        yield* established(world, runtime, EXPLICIT);
        const session = observed(yield* logged(world)).prompts[0]?.session;
        // A native owner changed the model while ACP held nothing.
        const conversation = join(world.state, `${encodeURIComponent(session ?? "")}.json`);
        const persisted = JSON.parse(yield* readTextFile(conversation));
        yield* writeTextFile(conversation, JSON.stringify({ ...persisted, model: ANOTHER }));

        const before = (yield* logged(world)).length;
        yield* ownedTurn(world, runtime, "after native", true);
        const after = observed((yield* logged(world)).slice(before));
        // The reconnect saw the real change, so the selection is written back
        // once — exactly — and the prompt runs under it in the same conversation.
        expect(after.modelWrites).toEqual([EXPLICIT]);
        expect(after.prompts).toEqual([{ session, model: EXPLICIT, effort: null }]);
      });
    });

    it("CR6: an unrepresentable or unreadable resumed model refuses before any prompt", function* () {
      const world = yield* useWorld();
      const aliasOnly = JSON.stringify([
        {
          value: "default",
          resolvedModel: "claude-fable-5-1",
          displayName: "Default",
          description: "",
        },
        {
          value: "fable",
          resolvedModel: "claude-fable-5-1",
          displayName: "Fable",
          description: "",
        },
      ]);
      yield* scoped(function* () {
        const runtime = runtimeFor(world, { FAKE_CLAUDE_MODELS: aliasOnly });
        yield* ensure(() => until(runtime.shutdown()));
        yield* ownedWrite(world, runtime, "model", "fable", true);
        // The backend reports the concrete model behind the alias. Nothing offered
        // names it exactly, so a use naming its own model refuses rather than
        // inventing that row or reading it as the alias.
        const refused = yield* refusalOfTurn(world, runtime, "flagged", true);
        expect(refused).toContain("claude-fable-5-1");
        expect(observed(yield* logged(world)).prompts).toEqual([]);
        // Without the fact, the existing behavior stands.
        expect(yield* ownedTurn(world, runtime, "unflagged")).toEqual({ status: "completed" });
      });

      const unreadable = yield* useWorld();
      yield* scoped(function* () {
        const runtime = runtimeFor(unreadable);
        yield* ensure(() => until(runtime.shutdown()));
        yield* established(unreadable, runtime, EXPLICIT);
        const failing = runtimeFor(unreadable, { FAKE_CLAUDE_CONTEXT_USAGE: "fail" });
        yield* ensure(() => until(failing.shutdown()));
        const prompts = observed(yield* logged(unreadable)).prompts.length;
        const refused = yield* refusalOfTurn(unreadable, failing, "flagged", true);
        expect(refused).toContain("could not report the model it runs");
        expect(observed(yield* logged(unreadable)).prompts.length).toBe(prompts);
      });
    });
  },
);

const WIRE_AGENT = fileURLToPath(
  new URL("./fixtures/wire-recording-acp-agent.cjs", import.meta.url),
);

describe(
  "Tier CR — the continuation marker on the wire",
  {
    sanitizeOps: false,
    sanitizeResources: false,
  },
  () => {
    it("CR8: only a Claude load or resume for a flagged call carries the marker", function* () {
      const root = yield* until(mkdtemp(join(tmpdir(), "xmd-cr-wire-")));
      yield* ensure(() => rm(root, { recursive: true, force: true }));
      // The same recording agent under a path ACPX recognizes as Claude's
      // adapter, and under one it does not.
      const claudeDirectory = join(root, "claude-agent-acp");
      yield* ensureDir(claudeDirectory);
      const claudeAgent = join(claudeDirectory, "agent.cjs");
      yield* writeTextFile(claudeAgent, yield* readTextFile(WIRE_AGENT));
      const wire = join(root, "wire.log");

      function* journey(command: string): Operation<Array<{ method: string; meta: unknown }>> {
        yield* rm(wire, { force: true });
        const records = new Map<string, AcpSessionRecord>();
        const runtime = createAcpRuntime({
          cwd: root,
          sessionStore: {
            load: (id) => Promise.resolve(structuredClone(records.get(id))),
            save: (record) => {
              records.set(record.acpxRecordId, structuredClone(record));
              return Promise.resolve();
            },
          },
          agentRegistry: { resolve: () => command, list: () => ["agent"] },
          permissionMode: "approve-all",
          nonInteractivePermissions: "deny",
          agentProcessEnv: { WIRE_LOG: wire },
        });
        yield* ensure(() => until(runtime.shutdown()));
        const ensureInput = (hasExplicitModel?: boolean): AcpRuntimeEnsureInput => ({
          sessionKey: "wire",
          agent: "agent",
          mode: "persistent",
          cwd: root,
          ...(hasExplicitModel === undefined ? {} : { hasExplicitModel }),
        });
        // Created under a flagged call: session/new never carries it.
        const created = yield* until(runtime.ensureSession(ensureInput(true)));
        yield* until(runtime.close({ handle: created, reason: "release" }));
        for (const hasExplicitModel of [true, false, undefined, true]) {
          const handle = yield* until(runtime.ensureSession(ensureInput(hasExplicitModel)));
          const turn = runtime.startTurn({
            handle,
            text: "hello",
            mode: "prompt",
            requestId: `turn-${String(hasExplicitModel)}`,
            ...(hasExplicitModel === undefined ? {} : { hasExplicitModel }),
          });
          yield* until(turn.result);
          yield* until(runtime.close({ handle, reason: "release" }));
        }
        return (yield* readTextFile(wire))
          .split("\n")
          .filter((line) => line.length > 0)
          .map((line) => JSON.parse(line))
          .filter((entry) =>
            ["session/new", "session/load", "session/resume"].includes(entry.method),
          )
          .map((entry) => ({
            method: entry.method,
            meta: entry.params?._meta?.["executablemd.has-explicit-model/v1"],
          }));
      }

      expect(yield* journey(`node ${JSON.stringify(claudeAgent)}`)).toEqual([
        { method: "session/new", meta: undefined },
        { method: "session/load", meta: true },
        { method: "session/load", meta: undefined },
        { method: "session/load", meta: undefined },
        { method: "session/load", meta: true },
      ]);
      // Another adapter never hears it.
      expect(
        (yield* journey(`node ${JSON.stringify(WIRE_AGENT)}`)).map((entry) => entry.meta),
      ).toEqual([undefined, undefined, undefined, undefined, undefined]);
    });

    it("CR9: a shared runtime refuses a flagged call before any effect", function* () {
      const shared = createSharedAcpRuntime({ cwd: tmpdir(), permissionMode: "deny-all" });
      const refusal = (body: () => unknown) => {
        try {
          body();
          return "";
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      };
      const handle: AcpRuntimeHandle = {
        sessionKey: "shared",
        backend: "acpx",
        runtimeSessionName: "shared",
      };
      expect(
        refusal(() =>
          shared.ensureSession({
            sessionKey: "shared",
            agent: "claude",
            mode: "persistent",
            hasExplicitModel: true,
          }),
        ),
      ).toContain("not supported by shared sessions");
      expect(
        refusal(() =>
          shared.startTurn({
            handle,
            text: "x",
            mode: "prompt",
            requestId: "x",
            hasExplicitModel: true,
          }),
        ),
      ).toContain("not supported by shared sessions");
      const write = yield* until(
        shared.setConfigOption({ handle, key: "model", value: "m", hasExplicitModel: true }).then(
          () => "",
          (error: Error) => error.message,
        ),
      );
      expect(write).toContain("not supported by shared sessions");
    });
  },
);

/**
 * The coordinator core delivers, reduced to what a configured prompt reaches:
 * the genuine setup owner settles and reads uses, and nothing is launched.
 */
function deliveredCoordinator(): AgentLaunchCoordinator {
  const owner = createSessionSetupOwner();
  return {
    sessionSetup: (request) => owner.setup(request),
    sessionUse: (routed) => owner.read(routed),
    checkpoint: () => {},
    // deno-lint-ignore require-yield
    *perform(): Operation<never> {
      throw new Error("this journey performs no launch");
    },
    // deno-lint-ignore require-yield
    *refuse(): Operation<never> {
      throw new Error("this journey refuses no launch");
    },
  };
}

/** One configured `<Session>` use and one prompt in it, through the provider. */
function* configuredPrompt(
  configuration: SessionConfiguration | undefined,
  text: string,
): Operation<Session> {
  const issuance = openSessionRequest(undefined, "sidekick");
  issuance.configure(configuration);
  try {
    const use = yield* Agent.operations.session(issuance.request);
    yield* scoped(function* () {
      const subscription = yield* yield* Agent.operations.prompt(text, { session: use });
      let next = yield* subscription.next();
      while (!next.done) {
        next = yield* subscription.next();
      }
    });
    return use;
  } finally {
    issuance.close();
  }
}

describe(
  "Tier CR — the production provider journey",
  {
    sanitizeOps: false,
    sanitizeResources: false,
  },
  () => {
    it("CR7: configured Sidekick prompts reconnect under the exact model with no model writes", function* () {
      const world = yield* useWorld("fable");
      const ownership = makeCoordinator();
      yield* scoped(function* () {
        yield* useFlatWorld(world.root);
        const runtimes: Runtime[] = [];
        yield* ensure(function* () {
          for (const runtime of runtimes) {
            yield* until(runtime.shutdown());
          }
        });
        const factory = createAcpxProvider({
          createRuntime: () => {
            const runtime = runtimeFor(world);
            runtimes.push(runtime);
            return runtime;
          },
          sessionStore: {
            load: (id) => Promise.resolve(structuredClone(world.records.get(id))),
            save: (record) => {
              world.records.set(record.acpxRecordId, structuredClone(record));
              return Promise.resolve();
            },
          },
          agentRegistry: makeRegistry({ claude: world.adapters.command("claude") }),
          advertiseNativeLaunch: ["claude"],
          advertiseClientNativeAttachment: [],
          nativeAdapters: {
            claude: {
              launcher: "claude",
              identity: "provider-returned",
              resume: (nativeSessionId) => ["claude", "--resume", nativeSessionId],
            },
          },
          coordinator: ownership.coordinator,
        });
        yield* factory(
          { defaultAgent: "claude", permissionMode: "deny-all" },
          deliveredCoordinator(),
        );

        const selection = { model: EXPLICIT, effort: "high" };
        const first = yield* configuredPrompt(selection, "first");
        const before = (yield* logged(world)).length;
        for (const text of ["second", "third", "fourth"]) {
          const use = yield* configuredPrompt(selection, text);
          expect(sessionOf(use)).toBe(sessionOf(first));
        }
        const repeated = (yield* logged(world)).slice(before);
        const { modelWrites, prompts } = observed(repeated);
        expect(modelWrites).toEqual([]);
        const session = prompts[0]?.session;
        expect(prompts).toEqual([
          { session, model: EXPLICIT, effort: "high" },
          { session, model: EXPLICIT, effort: "high" },
          { session, model: EXPLICIT, effort: "high" },
        ]);
        // Each use reconnected through a fresh child and released it: the
        // eager resolution and the prompt each own one, and every one closed.
        const starts = repeated.filter((entry) => entry.event === "started").length;
        expect(starts).toBeGreaterThanOrEqual(3);
        expect(repeated.filter((entry) => entry.event === "exit").length).toBe(starts);
        expect(ownership.events.filter((event) => event === "released-active")).toEqual([]);

        // A genuine change is written once and is what the next prompt runs.
        const change = (yield* logged(world)).length;
        yield* configuredPrompt({ model: ANOTHER, effort: "high" }, "changed");
        const changed = observed((yield* logged(world)).slice(change));
        expect(changed.modelWrites).toEqual([ANOTHER]);
        expect(changed.prompts).toEqual([{ session, model: ANOTHER, effort: "high" }]);
      });
    });
  },
);

/** A flagged turn's refusal, with nothing prompted and the handle released. */
function* refusalOfTurn(
  world: World,
  runtime: Runtime,
  text: string,
  hasExplicitModel: boolean,
): Operation<string> {
  return yield* scoped(function* () {
    const handle = yield* until(runtime.ensureSession(input(world, hasExplicitModel)));
    yield* ensure(() => until(runtime.close({ handle, reason: "refused" })));
    try {
      const turn = runtime.startTurn({
        handle,
        text,
        mode: "prompt",
        requestId: text,
        hasExplicitModel,
      });
      const result = yield* until(turn.result);
      return result.status === "completed" ? "" : JSON.stringify(result);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  });
}
