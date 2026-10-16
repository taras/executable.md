/**
 * Tier SP — who settles a session setup, and for how long (issue #828).
 *
 * A configured `<Session>` seals what it asks into its request, and the
 * installed provider settles that request into a conversation. The owner of
 * that settlement is an ordinary closure inside one provider installation: it
 * decides once, it knows which exact sessions that provider registered, and it
 * stops existing when the provider does.
 *
 * These rows are about that ownership rather than about configuration itself.
 * They drive the owner directly, the way a provider holding its delivered
 * coordinator would, because what is under test is the boundary — not what an
 * ACP agent does on the other side of it.
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { Err, Ok, sleep, spawn, withResolvers } from "effection";
import type { Operation, Result } from "effection";
import type { Session, SessionConfiguration } from "../src/agent/agent-api.ts";
import { createSessionSetupOwner } from "../src/agent/session-setup.ts";
import type { AgentSessionSetup, SessionSetupOwner } from "../src/agent/session-setup.ts";
import { configureSessionRequest, openSessionRequest } from "../src/agent/session-request.ts";
import type { AgentSessionRequest } from "../src/agent/session-request.ts";
import type { ProviderSessionConfiguration } from "../src/agent/provider-configuration.ts";
import { configurationOf, isSessionUse, sessionOf } from "../src/agent/session-use.ts";

const SESSION: Session = { sessionKey: "stub:review", cwd: "/repo" };

/** What a provider says it is, and what it resolved, when it asks to work. */
const PROVIDER = "stub";
const AGENT_COMMAND = "stub-cmd";

/** A complete configuration, as a constrained host supplies one. */
const CONFIGURATION: ProviderSessionConfiguration = Object.freeze({
  providerTools: Object.freeze([]),
  mcpServers: Object.freeze([]),
  permissions: Object.freeze({ permissionMode: "deny-all", routing: "strict" }),
  systemPrompt: null,
});

/**
 * One setup, authorized the way an installed provider authorizes one.
 *
 * Every provider asks before it reattaches, creates or prompts anything, so
 * these rows ask too: what they are about is what the owner does with a setup
 * it has authorized, and one it has not authorizes nothing at all.
 */
function* activated(
  owner: SessionSetupOwner,
  request: AgentSessionRequest,
): Operation<AgentSessionSetup> {
  const setup = owner.setup(request);
  const authorized = yield* setup.activate(PROVIDER, AGENT_COMMAND);
  expect(authorized.ok).toBe(true);
  return setup;
}

/** What an existing conversation's provider answers with: exactly what it was asked. */
function applying(
  log: SessionConfiguration[],
): (configuration: SessionConfiguration) => Operation<SessionConfiguration> {
  // deno-lint-ignore require-yield
  return function* (configuration) {
    log.push(configuration);
    return configuration;
  };
}

function refusalOf(body: () => unknown): string {
  try {
    body();
    return "";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function* refusalOfOperation(body: () => Operation<unknown>): Operation<string> {
  try {
    yield* body();
    return "";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

describe("Tier SP — session setup ownership", () => {
  it("SP1: a configured existing session applies once and seals what was verified", function* () {
    const owner = createSessionSetupOwner();
    const issuance = openSessionRequest("expansion:1", "review");
    issuance.configure({ model: "gpt-5.4", effort: "high" });
    const applied: SessionConfiguration[] = [];

    const setup = yield* activated(owner, issuance.request);
    expect(setup.sessionIdentity).toBe("expansion:1");
    const settled = yield* setup.finish(SESSION, {
      kind: "existing",
      configure: applying(applied),
    });

    expect(applied).toEqual([{ model: "gpt-5.4", effort: "high" }]);
    expect(isSessionUse(settled)).toBe(true);
    // The use is the session the provider resolved, and carries what that
    // provider reported it had actually put the conversation under.
    expect(sessionOf(settled)).toBe(SESSION);
    expect(configurationOf(settled)).toEqual({ model: "gpt-5.4", effort: "high" });
  });

  it("SP2: a configured new session applies nothing at all", function* () {
    const owner = createSessionSetupOwner();
    const issuance = openSessionRequest("expansion:1", "review");
    issuance.configure({ model: "gpt-5.4" });

    const settled = yield* (yield* activated(owner, issuance.request)).finish(SESSION, {
      kind: "new",
    });

    // There is no conversation yet, so there was nothing to put under anything.
    // The use still says what was asked; the first consumer is what applies it.
    expect(isSessionUse(settled)).toBe(true);
    expect(configurationOf(settled)).toEqual({ model: "gpt-5.4" });
  });

  it("SP3: an unconfigured setup answers with the exact session", function* () {
    const owner = createSessionSetupOwner();
    const issuance = openSessionRequest("expansion:1", "review");

    const settled = yield* (yield* activated(owner, issuance.request)).finish(SESSION, {
      kind: "new",
    });

    expect(settled).toBe(SESSION);
    expect(isSessionUse(settled)).toBe(false);
  });

  it("SP4: one setup settles one conversation", function* () {
    const owner = createSessionSetupOwner();
    const issuance = openSessionRequest("expansion:1", "review");
    const setup = yield* activated(owner, issuance.request);
    yield* setup.finish(SESSION, { kind: "new" });

    const refused = yield* refusalOfOperation(() => setup.finish(SESSION, { kind: "new" }));
    expect(refused).toContain("has already been settled");
    // And the request itself is spent, so it cannot be accepted again either.
    expect(refusalOf(() => owner.setup(issuance.request))).toContain("already been used");
  });

  it("SP5: one session has one way of being configured", function* () {
    const owner = createSessionSetupOwner();
    const applied: SessionConfiguration[] = [];
    const configure = applying(applied);

    for (const _ of [1, 2]) {
      const issuance = openSessionRequest("expansion:1", "review");
      yield* (yield* activated(owner, issuance.request)).finish(SESSION, {
        kind: "existing",
        configure,
      });
    }

    // The same operation twice is the same statement twice, which is nothing
    // new to reconcile.
    const other = openSessionRequest("expansion:1", "review");
    const refused = yield* refusalOfOperation(() =>
      (function* () {
        const setup = yield* activated(owner, other.request);
        return yield* setup.finish(SESSION, { kind: "existing", configure: applying([]) });
      })(),
    );
    expect(refused).toContain("two different ways of configuring it");
  });

  it("SP6: a dismantled installation settles nothing and answers for nothing", function* () {
    const owner = createSessionSetupOwner();
    const before = openSessionRequest("expansion:1", "review");
    // Authorized while the provider was still live, so what refuses below is
    // the teardown rather than the authorization this handle never had.
    const setup = yield* activated(owner, before.request);
    // A real use, minted while the provider was still there and kept — which is
    // exactly what a prompt holds when a document tears down around it.
    const issued = openSessionRequest("expansion:0", "review");
    issued.configure({ model: "gpt-5.4" });
    const use = yield* (yield* activated(owner, issued.request)).finish(SESSION, { kind: "new" });
    expect(owner.read(use)?.configuration).toEqual({ model: "gpt-5.4" });

    owner.close();

    // A handle taken before teardown is as dead as one asked for after it: the
    // provider that would answer is gone, so neither reaches one.
    const refusedFinish = yield* refusalOfOperation(() => setup.finish(SESSION, { kind: "new" }));
    expect(refusedFinish).toContain("has been dismantled");
    const after = openSessionRequest("expansion:2", "review");
    expect(refusalOf(() => owner.setup(after.request))).toContain("has been dismantled");
    // And the use it minted is no longer something it can answer for: what a
    // conversation runs under is a live provider's statement about it.
    expect(refusalOf(() => owner.read(use))).toContain("no longer something it can answer for");
  });

  it("SP7: sibling owners in one document cannot read each other's uses", function* () {
    // One document, two installed providers. They share the installation and
    // nothing else: a conversation one of them configured is one only it knows
    // how to configure, so only it can say what that use means.
    const first = createSessionSetupOwner();
    const second = createSessionSetupOwner();

    const mine = openSessionRequest("expansion:1", "review");
    mine.configure({ effort: "high" });
    const use = yield* (yield* activated(first, mine.request)).finish(SESSION, { kind: "new" });

    expect(first.read(use)?.configuration).toEqual({ effort: "high" });
    // Not this owner's to act on, even inside the same document run.
    expect(refusalOf(() => second.read(use))).toContain(
      "belongs to a different agent provider installation",
    );

    // And one request is spent by whichever owner accepts it, so the other
    // finds nothing left to settle.
    const shared = openSessionRequest("expansion:2", "review");
    yield* (yield* activated(first, shared.request)).finish(SESSION, { kind: "new" });
    expect(refusalOf(() => second.setup(shared.request))).toContain("already been used");
  });

  it("SP8: a provider that reports something else is not recorded as if it had complied", function* () {
    const owner = createSessionSetupOwner();
    const cases: Record<string, [SessionConfiguration | undefined, string]> = {
      // Silent about what it did.
      absent: [undefined, "did not say what it put the conversation under"],
      // Landed somewhere else.
      substituted: [{ model: "gpt-5.4-mini" }, "not running under what was asked"],
      // Reported a setting nobody asked about.
      extra: [{ model: "gpt-5.4", effort: "high" }, "asked for none"],
    };

    for (const [shape, [verified, says]] of Object.entries(cases)) {
      const issuance = openSessionRequest("expansion:1", "review");
      issuance.configure({ model: "gpt-5.4" });
      // A conversation of its own per case: registering one Session twice with
      // two different operations is a different refusal, asked by SP5.
      const session: Session = { sessionKey: `stub:${shape}`, cwd: "/repo" };
      const refused = yield* refusalOfOperation(() =>
        (function* () {
          const setup = yield* activated(owner, issuance.request);
          return yield* setup.finish(session, {
            kind: "existing",
            // deno-lint-ignore require-yield
            *configure() {
              return verified as SessionConfiguration;
            },
          });
        })(),
      );
      expect([shape, refused]).toEqual([shape, expect.stringContaining(says)]);
    }
  });

  it("SP9: a request nothing issued settles nothing", function* () {
    const owner = createSessionSetupOwner();
    const issuance = openSessionRequest("expansion:1", "review");
    // Everything a handler can build: the public members, copied.
    const rebuilt = { name: issuance.request.name, with: issuance.request.with };

    expect(refusalOf(() => owner.setup(rebuilt))).toContain("not a live session request");
  });

  it("SP11: what a request asks is settled before it routes, and once", function* () {
    // The element says what it asks — or that it asks nothing — before any
    // handler holds the request. What a handler receives is therefore already
    // settled, so there is nothing to overwrite and no unconfigured request
    // left to attach settings to.
    const configured = openSessionRequest("expansion:1", "review");
    configured.configure({ model: "gpt-5.4" });
    expect(
      refusalOf(() => configureSessionRequest(configured.request, { model: "gpt-5.4-mini" })),
    ).toContain("already says what it asks of its conversation");

    const unconfigured = openSessionRequest("expansion:2", "review");
    unconfigured.configure(undefined);
    expect(
      refusalOf(() => configureSessionRequest(unconfigured.request, { model: "gpt-5.4-mini" })),
    ).toContain("already says what it asks of its conversation");

    // Renaming is still a handler's to do, and changes nothing about this.
    expect(
      refusalOf(() =>
        configureSessionRequest(configured.request.with({ name: "elsewhere" }), { effort: "high" }),
      ),
    ).toContain("already says what it asks of its conversation");
  });

  it("SC3: a setup authorizes nothing without the configuration its conversation requires", function* () {
    const owner = createSessionSetupOwner();
    const asked: (ProviderSessionConfiguration | undefined)[] = [];
    /** A retained conversation: it requires a complete configuration. */
    // deno-lint-ignore require-yield
    const requiring = function* (
      _provider: string,
      _agentCommand: string,
      configuration: ProviderSessionConfiguration | undefined,
    ): Operation<Result<void>> {
      asked.push(configuration);
      return configuration === undefined
        ? Err(new Error("this conversation is continued only under the configuration it has"))
        : Ok(undefined);
    };

    // Omitted where it is required: refused, and the handle settles nothing.
    const bare = openSessionRequest("expansion:1", "review", requiring);
    const refusing = owner.setup(bare.request);
    const refused = yield* refusing.activate(PROVIDER, AGENT_COMMAND);
    expect(refused.ok).toBe(false);
    expect(asked).toEqual([undefined]);
    expect(yield* refusalOfOperation(() => refusing.finish(SESSION, { kind: "new" }))).toContain(
      "has not been activated",
    );

    // And a setup nobody activated at all is the same: `finish` is not a way in.
    const never = openSessionRequest("expansion:2", "review", requiring);
    expect(
      yield* refusalOfOperation(() => owner.setup(never.request).finish(SESSION, { kind: "new" })),
    ).toContain("has not been activated");

    // Supplied where it is required: authorized, and the setup settles.
    const whole = openSessionRequest("expansion:3", "review", requiring);
    const supplied = owner.setup(whole.request);
    expect((yield* supplied.activate(PROVIDER, AGENT_COMMAND, CONFIGURATION)).ok).toBe(true);
    expect(yield* supplied.finish(SESSION, { kind: "new" })).toBe(SESSION);
    expect(asked[1]).toBe(CONFIGURATION);

    // An ordinary request requires none, saves none and is unchanged by any of
    // this: the exact raw session for an unconfigured one, and the use it
    // already minted for a configured one.
    const ordinary = openSessionRequest("expansion:4", "review");
    expect(
      yield* (yield* activated(owner, ordinary.request)).finish(SESSION, { kind: "new" }),
    ).toBe(SESSION);
    const configured = openSessionRequest("expansion:5", "review");
    configured.configure({ model: "gpt-5.4" });
    const use = yield* (yield* activated(owner, configured.request)).finish(SESSION, {
      kind: "new",
    });
    expect(configurationOf(use)).toEqual({ model: "gpt-5.4" });
    // Two asks reached the requirement — the refused one and the supplied one.
    // The setup nobody activated never reached it, and neither ordinary request
    // did: a conversation's requirement is that conversation's, not something
    // the owner applies to every request it settles.
    expect(asked).toHaveLength(2);
  });

  it("SC4: one setup authorizes one attempt, and closure ends both halves", function* () {
    const owner = createSessionSetupOwner();
    const holding = withResolvers<Result<void>>();
    let entered = 0;
    const held = function* (): Operation<Result<void>> {
      entered += 1;
      return yield* holding.operation;
    };

    const issuance = openSessionRequest("expansion:1", "review", held);
    const setup = owner.setup(issuance.request);
    const attempt = yield* spawn(() => setup.activate(PROVIDER, AGENT_COMMAND, CONFIGURATION));
    // Suspended inside the acknowledgement, which is where a cancellation has
    // to be survivable: nothing has been settled and nothing may be.
    yield* sleep(0);
    expect(entered).toBe(1);
    yield* attempt.halt();

    // The attempt was spent by being made. Cancelling it is not a way to get it
    // back, and the setup it belonged to settles nothing.
    expect(
      yield* refusalOfOperation(() => setup.activate(PROVIDER, AGENT_COMMAND, CONFIGURATION)),
    ).toContain("already been activated once");
    expect(yield* refusalOfOperation(() => setup.finish(SESSION, { kind: "new" }))).toContain(
      "has not been activated",
    );
    expect(entered).toBe(1);

    // A later explicit action is a new setup on a new issuance, and it works.
    const again = openSessionRequest("expansion:2", "review", function* (): Operation<
      Result<void>
    > {
      entered += 1;
      return Ok(undefined);
    });
    const fresh = owner.setup(again.request);
    expect((yield* fresh.activate(PROVIDER, AGENT_COMMAND, CONFIGURATION)).ok).toBe(true);
    expect(yield* fresh.finish(SESSION, { kind: "new" })).toBe(SESSION);
    expect(entered).toBe(2);

    // A handle kept past the element that opened it reaches nothing, and so
    // does one kept past the installation.
    const kept = openSessionRequest("expansion:3", "review");
    const past = owner.setup(kept.request);
    kept.close();
    expect(
      yield* refusalOfOperation(() => past.activate(PROVIDER, AGENT_COMMAND, CONFIGURATION)),
    ).toContain("already finished with its session");

    const live = openSessionRequest("expansion:4", "review");
    const dismantled = owner.setup(live.request);
    owner.close();
    expect(
      yield* refusalOfOperation(() => dismantled.activate(PROVIDER, AGENT_COMMAND, CONFIGURATION)),
    ).toContain("has been dismantled");
  });

  it("SP10: renaming a request keeps what it asks for", function* () {
    const owner = createSessionSetupOwner();
    const issuance = openSessionRequest("expansion:1", "review");
    issuance.configure({ model: "gpt-5.4" });

    // What middleware is for: the descriptive name is a handler's to change,
    // and doing so is still routing this element's request.
    const renamed = issuance.request.with({ name: "elsewhere" });
    const setup = yield* activated(owner, renamed);

    expect(setup.sessionIdentity).toBe("expansion:1");
    const settled = yield* setup.finish(SESSION, { kind: "new" });
    expect(configurationOf(settled)).toEqual({ model: "gpt-5.4" });
  });
});
