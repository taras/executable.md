/**
 * Tier LP — a provider and a Core copy that are not the same copy (issue #828).
 *
 * A provider is a package. It imports `@executablemd/core`, and the host that
 * installs it may have loaded a different copy of core than the one the
 * provider resolved — a bundled plugin, a vendored build, two specifiers that
 * do not dedupe. Both copies agree about the public data a `Session` carries.
 * Neither can recognize the other's private values.
 *
 * That is what makes a placement dangerous to classify locally. A provider that
 * asked its own copy "is this a placement?" would be told no about a perfectly
 * genuine one, treat it as an ordinary session, and run the conversation
 * unconfigured — quietly, because nothing about that path fails. So the
 * provider classifies only what every copy agrees about: a resolved `Session`
 * has a `sessionKey` and a `cwd`. Everything else goes to the coordinator it
 * was delivered, which is the only thing that can say whose placement it is.
 *
 * The situation is symmetric, so these cases stage it the way round that can
 * actually be built: the provider is this repository's, and the placements and
 * the coordinator come from a second, separately bundled copy of core. To the
 * provider's own copy every one of those values is foreign — exactly as a
 * canonical placement is to a provider loaded with another copy.
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, resource, scoped, until } from "effection";
import type { Operation } from "effection";
import { rm, writeTextFile } from "@effectionx/fs";
import { exec } from "@effectionx/process";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { Agent } from "@executablemd/core";
import type {
  AgentLaunchCoordinator,
  AgentSessionPlacement,
  AgentSessionRequest,
  Session,
  SessionConfiguration,
} from "@executablemd/core";
import { createAcpxProvider } from "../src/provider.ts";
// This run's own copy, for the case that needs a canonical owner to refuse a
// foreign placement.
import { createSessionPlacementOwner } from "../../core/src/agent/session-placement.ts";
import {
  createFakeRuntime,
  makeRegistry,
  makeStore,
  selector,
  choice,
  useFlatWorld,
} from "./helpers.ts";
import type { FakeRuntimeHarness } from "./helpers.ts";

const CWD = "/work";
const REPOSITORY = fileURLToPath(new URL("../../..", import.meta.url));
const CORE_AGENT = fileURLToPath(new URL("../../core/src/agent/", import.meta.url));

/**
 * What this suite asks of the other copy, and what it will accept as an answer.
 *
 * Every value that crosses back from a separately bundled module is read the
 * way core reads what a provider installation delivered: by its members, with a
 * refusal when they are not there. Nothing is asserted into place, because the
 * whole subject here is two copies that cannot recognize each other's values.
 */
interface ForeignIssuance {
  readonly request: AgentSessionRequest;
  configure(configuration: SessionConfiguration | undefined): void;
  close(): void;
}

interface ForeignOwner {
  placement(request: AgentSessionRequest): AgentSessionPlacement;
  read(routed: unknown): ReadPlacementUse | undefined;
  close(): void;
}

/** What an owner says a routed value's conversation is, and runs under. */
interface ReadPlacementUse {
  readonly session: Session;
  readonly configuration?: SessionConfiguration;
}

interface ForeignCore {
  sessionPlacement(sessionIdentity: string | undefined, name: string | undefined): ForeignIssuance;
  createSessionPlacementOwner(): ForeignOwner;
}

/**
 * `value`'s `name` method, as something this file can call.
 *
 * A wrapper bound to the receiver it was read from, rather than the function
 * itself: `typeof member === "function"` says only that it is callable, so what
 * comes back is a closure that calls it through `Reflect.apply`. `T` is the
 * caller's stated expectation of the answer, and every caller here checks what
 * actually arrives before using it.
 */
function methodOf<T = unknown>(
  value: unknown,
  name: string,
): ((...args: unknown[]) => T) | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const member = Reflect.get(value, name);
  if (typeof member !== "function") {
    return undefined;
  }
  return (...args) => Reflect.apply(member, value, args);
}

/**
 * Whether `value` has the public shape of a routed placement.
 *
 * Classification, and only that: it says this is the kind of value a placement
 * is, never that it is a live one. Whose placement it is stays the owner's to
 * decide, and every case below routes it there.
 */
function isRequestShaped(value: unknown): value is AgentSessionRequest {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const name = Reflect.get(value, "name");
  return (
    (name === undefined || typeof name === "string") &&
    typeof Reflect.get(value, "with") === "function"
  );
}

/** Whether `value` carries what every session a provider issues carries. */
function isSession(value: unknown): value is Session {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  return (
    typeof Reflect.get(value, "sessionKey") === "string" &&
    typeof Reflect.get(value, "cwd") === "string"
  );
}

function placementOf(value: unknown): AgentSessionPlacement {
  const complete = methodOf<Operation<unknown>>(value, "complete");
  if (complete === undefined || typeof value !== "object" || value === null) {
    throw new Error("the other copy answered a placement with nothing that could settle it");
  }
  const identity = Reflect.get(value, "sessionIdentity");
  return {
    ...(typeof identity === "string" ? { sessionIdentity: identity } : {}),
    *complete(session, state) {
      // Delegated rather than run here: the bundle carries no Effection of its
      // own — every effect it yields came from the operation this copy handed
      // it — so what crosses back is this run's own work to finish.
      const settled = yield* complete(session, state);
      if (!isSession(settled)) {
        throw new Error("the other copy settled a placement with something that is not a session");
      }
      return settled;
    },
  };
}

function readUseOf(value: unknown): ReadPlacementUse | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "object" || value === null) {
    throw new Error("the other copy answered a routed value with something unreadable");
  }
  const session = Reflect.get(value, "session");
  if (!isSession(session)) {
    throw new Error("the other copy named no session for this routed value");
  }
  const configuration = Reflect.get(value, "configuration");
  if (configuration === undefined) {
    return { session };
  }
  if (typeof configuration !== "object" || configuration === null) {
    throw new Error("the other copy answered with a configuration that is not one");
  }
  const model = Reflect.get(configuration, "model");
  const effort = Reflect.get(configuration, "effort");
  return {
    session,
    configuration: {
      ...(typeof model === "string" ? { model } : {}),
      ...(typeof effort === "string" ? { effort } : {}),
    },
  };
}

function ownerOf(value: unknown): ForeignOwner {
  const placement = methodOf(value, "placement");
  const read = methodOf(value, "read");
  const close = methodOf(value, "close");
  if (placement === undefined || read === undefined || close === undefined) {
    throw new Error("the bundled copy does not expose a placement owner");
  }
  return {
    placement: (request) => placementOf(placement(request)),
    read: (routed) => readUseOf(read(routed)),
    close: () => {
      close();
    },
  };
}

function issuanceOf(value: unknown): ForeignIssuance {
  const configure = methodOf(value, "configure");
  const close = methodOf(value, "close");
  const request =
    typeof value === "object" && value !== null ? Reflect.get(value, "request") : undefined;
  if (configure === undefined || close === undefined || !isRequestShaped(request)) {
    throw new Error("the bundled copy does not expose a placement issuance");
  }
  return {
    request,
    configure: (configuration) => {
      configure(configuration);
    },
    close: () => {
      close();
    },
  };
}

function foreignCore(value: unknown): ForeignCore | undefined {
  const place = methodOf(value, "sessionPlacement");
  const own = methodOf(value, "createSessionPlacementOwner");
  if (place === undefined || own === undefined) {
    return undefined;
  }
  return {
    sessionPlacement: (identity, name) => issuanceOf(Reflect.apply(place, value, [identity, name])),
    createSessionPlacementOwner: () => ownerOf(Reflect.apply(own, value, [])),
  };
}

/**
 * Core's placement machinery, bundled and evaluated as its own module.
 *
 * One entry pulling in both halves, because they are one graph: a placement and
 * the owner that settles it recognize each other through private fields, and
 * bundling them apart would make two copies that cannot.
 */
function useForeignCore(): Operation<ForeignCore> {
  return resource(function* (provide) {
    const directory = yield* until(mkdtemp(join(tmpdir(), "lp-core-")));
    yield* ensure(() => rm(directory, { recursive: true, force: true }));
    const entry = join(directory, "entry.ts");
    const bundle = join(directory, "core.js");
    yield* writeTextFile(
      entry,
      [
        `export { sessionPlacement } from ${JSON.stringify(join(CORE_AGENT, "session-request.ts"))};`,
        `export { createSessionPlacementOwner } from ${JSON.stringify(
          join(CORE_AGENT, "session-placement.ts"),
        )};`,
        "",
      ].join("\n"),
    );

    // `process.execPath` under Deno is the deno binary, so the driver stays
    // typed against node:process rather than a runtime global.
    const built = yield* exec(process.execPath, {
      arguments: ["bundle", "--frozen", "--node-modules-dir=none", entry, "--output", bundle],
      cwd: REPOSITORY,
    }).join();
    if (built.code !== 0) {
      throw new Error(`could not bundle a second core copy:\n${built.stdout}${built.stderr}`);
    }

    const loaded = foreignCore(yield* until(import(`file://${bundle}`)));
    if (loaded === undefined) {
      throw new Error("the bundled copy does not expose the placement surface");
    }
    yield* provide(loaded);
  });
}

/** Every placement the provider handed over, and what it read off each one. */
interface PlacementLog {
  /** One entry per `sessionPlacement()` call, in order. */
  handedOver: unknown[];
  /** Every `sessionIdentity` the provider actually read, in order. */
  identitiesRead: (string | undefined)[];
}

function newLog(): PlacementLog {
  return { handedOver: [], identitiesRead: [] };
}

/**
 * What the foreign copy's owner looks like to a provider: a coordinator.
 *
 * `sessionIdentity` is a getter so that reading it is observable. What LP2
 * needs is not that the handle carried the right identity, but that the
 * provider's placement integration consumed it — and only reading records that.
 */
function foreignCoordinator(owner: ForeignOwner, log: PlacementLog): AgentLaunchCoordinator {
  return {
    sessionPlacement: (request) => {
      log.handedOver.push(request);
      const placement = owner.placement(request);
      const identity = placement.sessionIdentity;
      const observed: AgentSessionPlacement = {
        complete: (session, state) => placement.complete(session, state),
      };
      Object.defineProperty(observed, "sessionIdentity", {
        enumerable: true,
        get: () => {
          log.identitiesRead.push(identity);
          return identity;
        },
      });
      return observed;
    },
    sessionUse: (routed) => owner.read(routed),
    checkpoint: () => {
      throw new Error("this suite names no provider turn");
    },
    *perform() {
      throw new Error("this suite routes no launch");
    },
    *refuse() {
      throw new Error("this suite routes no launch");
    },
  };
}

function configured(harness: FakeRuntimeHarness): FakeRuntimeHarness {
  harness.configOptions = [
    selector("model", "model", "gpt-5.4", [
      choice("gpt-5.4", "GPT-5.4"),
      choice("gpt-5.4-mini", "GPT-5.4 Mini"),
    ]),
    selector("effort", "thought_level", "medium", [
      choice("low", "Low"),
      choice("medium", "Medium"),
      choice("high", "High"),
    ]),
  ];
  return harness;
}

/** This repository's provider, installed with the foreign copy's coordinator. */
function* installProvider(
  harness: FakeRuntimeHarness,
  coordinator: AgentLaunchCoordinator,
): Operation<void> {
  yield* useFlatWorld(CWD);
  const factory = createAcpxProvider({
    createRuntime: harness.create,
    sessionStore: makeStore(),
    agentRegistry: makeRegistry({ scribe: "scribe-cmd" }),
  });
  yield* factory({ defaultAgent: "scribe", permissionMode: "deny-all" }, coordinator);
}

function refusalOf(operation: () => Operation<unknown>): Operation<string> {
  return (function* () {
    try {
      yield* operation();
      return "";
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  })();
}

describe("Tier LP — a provider and a Core copy that are not the same copy", () => {
  it("LP1: an unconfigured placement from another copy resolves through the delivered coordinator", function* () {
    const core = yield* useForeignCore();
    const harness = configured(createFakeRuntime());
    const owner = core.createSessionPlacementOwner();
    const log = newLog();
    yield* scoped(function* () {
      yield* installProvider(harness, foreignCoordinator(owner, log));
      const issuance = core.sessionPlacement("expansion:1", "review");
      issuance.configure(undefined);

      const session = yield* Agent.operations.session(issuance.request);

      // Handed over exactly once, and it was this placement: not mistaken for a
      // session because this provider's own copy could not recognize it, and
      // not asked about twice.
      expect(log.handedOver).toEqual([issuance.request]);
      // It asked for nothing, so nothing was read or written about settings.
      expect(typeof session.sessionKey).toBe("string");
      expect(harness.configCalls).toEqual([]);
      expect(owner.read(session)?.configuration).toBe(undefined);
    });
  });

  it("LP2: a configured placement from another copy keeps its identity and its settings", function* () {
    const core = yield* useForeignCore();
    const harness = configured(createFakeRuntime());
    const owner = core.createSessionPlacementOwner();
    const log = newLog();
    yield* scoped(function* () {
      yield* installProvider(harness, foreignCoordinator(owner, log));
      // Established first, so the second placement meets a real conversation
      // and is configured in place rather than staying inert.
      const first = core.sessionPlacement("expansion:1", "review");
      first.configure(undefined);
      const plain = yield* Agent.operations.session(first.request);
      yield* startAndFinishOneTurn(plain);
      harness.configCalls = [];
      log.identitiesRead.length = 0;

      const issuance = core.sessionPlacement("expansion:2", "review");
      issuance.configure({ model: "gpt-5.4-mini", effort: "high" });
      const use = yield* Agent.operations.session(issuance.request);

      // The engine identity this placement carried is the one the provider's
      // placement integration actually read — not a value it recomputed, and
      // not one it took from the descriptive name.
      expect(log.identitiesRead).toEqual(["expansion:2"]);

      // The same conversation, put under exactly what the foreign placement
      // asked, and described by the owner that issued the use.
      expect(use.sessionKey).toBe(plain.sessionKey);
      expect(harness.configCalls).toEqual([
        "status",
        "set model=gpt-5.4-mini",
        "status",
        "set effort=high",
        "status",
      ]);
      expect(owner.read(use)?.configuration).toEqual({
        model: "gpt-5.4-mini",
        effort: "high",
      });
    });
  });

  it("LP3: a placement from another copy is refused by the installation that did not issue it", function* () {
    const core = yield* useForeignCore();
    const harness = configured(createFakeRuntime());
    // This run's own owner, and a placement minted by the other copy. The
    // provider hands it over rather than guessing, and the owner that did not
    // issue it says so — before anything is resolved or configured.
    const canonical = yield* useCanonicalOwner();
    yield* scoped(function* () {
      yield* installProvider(harness, canonical.coordinator);
      const foreign = core.sessionPlacement("expansion:1", "review");
      foreign.configure({ model: "gpt-5.4-mini" });

      const refused = yield* refusalOf(() => Agent.operations.session(foreign.request));

      expect(refused).toContain("not a live session placement");
      expect(harness.configCalls).toEqual([]);
      expect(harness.ensureCalls.length).toBe(0);
    });
  });

  it("LP4: a raw Session and an authentic use keep their accepted routing", function* () {
    const core = yield* useForeignCore();
    const harness = configured(createFakeRuntime());
    const owner = core.createSessionPlacementOwner();
    yield* scoped(function* () {
      yield* installProvider(harness, foreignCoordinator(owner, newLog()));
      const placed = core.sessionPlacement("expansion:1", "review");
      placed.configure({ model: "gpt-5.4-mini" });
      const use = yield* Agent.operations.session(placed.request);
      yield* startAndFinishOneTurn(use);
      const applied = [...harness.configCalls];

      // The raw conversation the use names, routed back in on its own. It is a
      // Session by the one thing every copy agrees about — a session key and a
      // working directory — so it is not handed to the coordinator as a
      // placement, and it carries no settings to apply.
      const read = owner.read(use);
      if (read === undefined) {
        throw new Error("this owner issued the use and should be able to read it");
      }
      harness.configCalls = [];
      yield* startAndFinishOneTurn(read.session);
      expect(harness.configCalls).toEqual([]);

      // And the use still carries what it was verified under.
      expect(applied.length).toBeGreaterThan(0);
      expect(owner.read(use)?.configuration).toEqual({ model: "gpt-5.4-mini" });
    });
  });
});

/** This run's own placement owner, wrapped as the coordinator a provider gets. */
function* useCanonicalOwner(): Operation<{ coordinator: AgentLaunchCoordinator }> {
  const owner = createSessionPlacementOwner();
  yield* ensure(() => owner.close());
  return {
    coordinator: foreignCoordinator(
      {
        placement: (request) => owner.placement(request),
        read: (routed) => readUseOf(owner.read(isSession(routed) ? routed : undefined)),
        close: () => owner.close(),
      },
      newLog(),
    ),
  };
}

/** Send one prompt and drain it, so the session is established. */
function* startAndFinishOneTurn(session: Session): Operation<void> {
  yield* scoped(function* () {
    const stream = yield* Agent.operations.prompt("hello", { session });
    const subscription = yield* stream;
    let next = yield* subscription.next();
    while (!next.done) {
      next = yield* subscription.next();
    }
  });
}
