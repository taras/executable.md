/**
 * Tier SP — who settles a placement, and for how long (issue #828).
 *
 * A configured `<Session>` seals what it asks into its placement, and the
 * installed provider settles that placement into a conversation. The owner of
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
import type { Operation } from "effection";
import type { Session, SessionConfiguration } from "../src/agent/agent-api.ts";
import { createSessionPlacementOwner } from "../src/agent/session-placement.ts";
import { configurePlacement, sessionPlacement } from "../src/agent/session-request.ts";
import { configurationOf, isSessionUse, sessionOf } from "../src/agent/session-use.ts";

const SESSION: Session = { sessionKey: "stub:review", cwd: "/repo" };

/** What an established provider answers with: exactly what it was asked. */
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

describe("Tier SP — placement ownership", () => {
  it("SP1: a configured established placement applies once and seals what was verified", function* () {
    const owner = createSessionPlacementOwner();
    const issuance = sessionPlacement("expansion:1", "review");
    issuance.configure({ model: "gpt-5.4", effort: "high" });
    const applied: SessionConfiguration[] = [];

    const placement = owner.placement(issuance.request);
    expect(placement.sessionIdentity).toBe("expansion:1");
    const settled = yield* placement.complete(SESSION, {
      kind: "established",
      configure: applying(applied),
    });

    expect(applied).toEqual([{ model: "gpt-5.4", effort: "high" }]);
    expect(isSessionUse(settled)).toBe(true);
    // The use is the session the provider resolved, and carries what that
    // provider reported it had actually put the conversation under.
    expect(sessionOf(settled)).toBe(SESSION);
    expect(configurationOf(settled)).toEqual({ model: "gpt-5.4", effort: "high" });
  });

  it("SP2: a configured fresh placement applies nothing at all", function* () {
    const owner = createSessionPlacementOwner();
    const issuance = sessionPlacement("expansion:1", "review");
    issuance.configure({ model: "gpt-5.4" });

    const settled = yield* owner.placement(issuance.request).complete(SESSION, { kind: "fresh" });

    // There is no conversation yet, so there was nothing to put under anything.
    // The use still says what was asked; the first consumer is what applies it.
    expect(isSessionUse(settled)).toBe(true);
    expect(configurationOf(settled)).toEqual({ model: "gpt-5.4" });
  });

  it("SP3: an unconfigured placement answers with the exact session", function* () {
    const owner = createSessionPlacementOwner();
    const issuance = sessionPlacement("expansion:1", "review");

    const settled = yield* owner.placement(issuance.request).complete(SESSION, { kind: "fresh" });

    expect(settled).toBe(SESSION);
    expect(isSessionUse(settled)).toBe(false);
  });

  it("SP4: one placement settles one conversation", function* () {
    const owner = createSessionPlacementOwner();
    const issuance = sessionPlacement("expansion:1", "review");
    const placement = owner.placement(issuance.request);
    yield* placement.complete(SESSION, { kind: "fresh" });

    const refused = yield* refusalOfOperation(() => placement.complete(SESSION, { kind: "fresh" }));
    expect(refused).toContain("has already been settled");
    // And the placement itself is spent, so it cannot be accepted again either.
    expect(refusalOf(() => owner.placement(issuance.request))).toContain("already been used");
  });

  it("SP5: one session has one way of being configured", function* () {
    const owner = createSessionPlacementOwner();
    const applied: SessionConfiguration[] = [];
    const configure = applying(applied);

    for (const _ of [1, 2]) {
      const issuance = sessionPlacement("expansion:1", "review");
      yield* owner
        .placement(issuance.request)
        .complete(SESSION, { kind: "established", configure });
    }

    // The same operation twice is the same statement twice, which is nothing
    // new to reconcile.
    const other = sessionPlacement("expansion:1", "review");
    const refused = yield* refusalOfOperation(() =>
      owner
        .placement(other.request)
        .complete(SESSION, { kind: "established", configure: applying([]) }),
    );
    expect(refused).toContain("two different ways of configuring it");
  });

  it("SP6: a dismantled installation settles nothing and answers for nothing", function* () {
    const owner = createSessionPlacementOwner();
    const before = sessionPlacement("expansion:1", "review");
    const placement = owner.placement(before.request);
    // A real use, minted while the provider was still there and kept — which is
    // exactly what a prompt holds when a document tears down around it.
    const issued = sessionPlacement("expansion:0", "review");
    issued.configure({ model: "gpt-5.4" });
    const use = yield* owner.placement(issued.request).complete(SESSION, { kind: "fresh" });
    expect(owner.read(use)?.configuration).toEqual({ model: "gpt-5.4" });

    owner.close();

    // A handle taken before teardown is as dead as one asked for after it: the
    // provider that would answer is gone, so neither reaches one.
    const refusedComplete = yield* refusalOfOperation(() =>
      placement.complete(SESSION, { kind: "fresh" }),
    );
    expect(refusedComplete).toContain("has been dismantled");
    const after = sessionPlacement("expansion:2", "review");
    expect(refusalOf(() => owner.placement(after.request))).toContain("has been dismantled");
    // And the use it minted is no longer something it can answer for: what a
    // conversation runs under is a live provider's statement about it.
    expect(refusalOf(() => owner.read(use))).toContain("no longer something it can answer for");
  });

  it("SP7: sibling owners in one document cannot read each other's uses", function* () {
    // One document, two installed providers. They share the installation and
    // nothing else: a conversation one of them configured is one only it knows
    // how to configure, so only it can say what that use means.
    const first = createSessionPlacementOwner();
    const second = createSessionPlacementOwner();

    const mine = sessionPlacement("expansion:1", "review");
    mine.configure({ effort: "high" });
    const use = yield* first.placement(mine.request).complete(SESSION, { kind: "fresh" });

    expect(first.read(use)?.configuration).toEqual({ effort: "high" });
    // Not this owner's to act on, even inside the same document run.
    expect(refusalOf(() => second.read(use))).toContain(
      "belongs to a different agent provider installation",
    );

    // And one placement is spent by whichever owner accepts it, so the other
    // finds nothing left to settle.
    const shared = sessionPlacement("expansion:2", "review");
    yield* first.placement(shared.request).complete(SESSION, { kind: "fresh" });
    expect(refusalOf(() => second.placement(shared.request))).toContain("already been used");
  });

  it("SP8: a provider that reports something else is not recorded as if it had complied", function* () {
    const owner = createSessionPlacementOwner();
    const cases: Record<string, [SessionConfiguration | undefined, string]> = {
      // Silent about what it did.
      absent: [undefined, "did not say what it put the conversation under"],
      // Landed somewhere else.
      substituted: [{ model: "gpt-5.4-mini" }, "not running under what was asked"],
      // Reported a setting nobody asked about.
      extra: [{ model: "gpt-5.4", effort: "high" }, "asked for none"],
    };

    for (const [shape, [verified, says]] of Object.entries(cases)) {
      const issuance = sessionPlacement("expansion:1", "review");
      issuance.configure({ model: "gpt-5.4" });
      // A conversation of its own per case: registering one Session twice with
      // two different operations is a different refusal, asked by SP5.
      const session: Session = { sessionKey: `stub:${shape}`, cwd: "/repo" };
      const refused = yield* refusalOfOperation(() =>
        owner.placement(issuance.request).complete(session, {
          kind: "established",
          // deno-lint-ignore require-yield
          *configure() {
            return verified as SessionConfiguration;
          },
        }),
      );
      expect([shape, refused]).toEqual([shape, expect.stringContaining(says)]);
    }
  });

  it("SP9: a request nothing issued settles nothing", function* () {
    const owner = createSessionPlacementOwner();
    const issuance = sessionPlacement("expansion:1", "review");
    // Everything a handler can build: the public members, copied.
    const rebuilt = { name: issuance.request.name, with: issuance.request.with };

    expect(refusalOf(() => owner.placement(rebuilt))).toContain("not a live session placement");
  });

  it("SP11: what a placement asks is settled before it routes, and once", function* () {
    // The element says what it asks — or that it asks nothing — before any
    // handler holds the request. What a handler receives is therefore already
    // settled, so there is nothing to overwrite and no unconfigured placement
    // left to attach settings to.
    const configured = sessionPlacement("expansion:1", "review");
    configured.configure({ model: "gpt-5.4" });
    expect(
      refusalOf(() => configurePlacement(configured.request, { model: "gpt-5.4-mini" })),
    ).toContain("already says what it asks of its conversation");

    const unconfigured = sessionPlacement("expansion:2", "review");
    unconfigured.configure(undefined);
    expect(
      refusalOf(() => configurePlacement(unconfigured.request, { model: "gpt-5.4-mini" })),
    ).toContain("already says what it asks of its conversation");

    // Renaming is still a handler's to do, and changes nothing about this.
    expect(
      refusalOf(() =>
        configurePlacement(configured.request.with({ name: "elsewhere" }), { effort: "high" }),
      ),
    ).toContain("already says what it asks of its conversation");
  });

  it("SP10: renaming a placement keeps what it asks for", function* () {
    const owner = createSessionPlacementOwner();
    const issuance = sessionPlacement("expansion:1", "review");
    issuance.configure({ model: "gpt-5.4" });

    // What middleware is for: the descriptive name is a handler's to change,
    // and doing so is still routing this element's placement.
    const renamed = issuance.request.with({ name: "elsewhere" });
    const placement = owner.placement(renamed);

    expect(placement.sessionIdentity).toBe("expansion:1");
    const settled = yield* placement.complete(SESSION, { kind: "fresh" });
    expect(configurationOf(settled)).toEqual({ model: "gpt-5.4" });
  });
});
