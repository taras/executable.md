/**
 * Tier SU — one authentic use of a conversation (issue #828).
 *
 * A configured `<Session>` says what a conversation runs under, and that fact
 * travels to the provider on the value that names the conversation. Every such
 * value travels the public Agent chain, where middleware may read it, copy it
 * and route something else — so what these rows establish is which values carry
 * an answer and which are refused for claiming to.
 *
 * The refusal is the point. A value that presents itself as configured and is
 * not one must not be read as an ordinary session and run unconfigured: that is
 * the same conversation running under settings nobody chose.
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import type { Session } from "../src/agent/agent-api.ts";
import {
  AgentSessionUseError,
  claimsConfiguration,
  configurationOf,
  isSessionUse,
  issueSessionUse,
  readSessionUse,
  sessionOf,
} from "../src/agent/session-use.ts";

const SESSION: Session = { sessionKey: "xmd:v1:a", cwd: "/repo", agentSessionId: "agent-1" };

function refusalOf(read: () => unknown): string {
  try {
    read();
    return "";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

describe("Tier SU — an authentic session use", () => {
  it("SU1: a use is the session it was issued for", function* () {
    const installation = {};
    const use = issueSessionUse(SESSION, { model: "gpt-5.4" }, installation);

    // Every public measure of the session, so a consumer written against
    // `string | Session` needs to know nothing about this.
    expect(use.sessionKey).toBe(SESSION.sessionKey);
    expect(use.cwd).toBe(SESSION.cwd);
    expect(use.agentSessionId).toBe(SESSION.agentSessionId);
    // And the exact value the provider issued comes back out, because a
    // provider compares sessions by identity rather than by key.
    expect(readSessionUse(use, installation)?.session).toBe(SESSION);
  });

  it("SU2: the use and the configuration it carries are frozen", function* () {
    const installation = {};
    const supplied = { model: "gpt-5.4", effort: "high" };
    const use = issueSessionUse(SESSION, supplied, installation);
    const carried = readSessionUse(use, installation)?.configuration;

    expect(Object.isFrozen(use)).toBe(true);
    expect(Object.isFrozen(carried)).toBe(true);
    // Copied at issue, so editing what was handed in changes nothing about the
    // use the provider will be given.
    supplied.model = "gpt-5.4-mini";
    expect(carried).toEqual({ model: "gpt-5.4", effort: "high" });
  });

  it("SU3: an ordinary session answers with itself and no configuration", function* () {
    const read = readSessionUse(SESSION, {});
    expect(read?.session).toBe(SESSION);
    expect(read?.configuration).toBe(undefined);
    expect(readSessionUse("review", {})).toBe(undefined);
    expect(readSessionUse(undefined, {})).toBe(undefined);
    expect(claimsConfiguration(SESSION)).toBe(false);
  });

  it("SU4: every value that claims to be a use and is not one refuses", function* () {
    const installation = {};
    const use = issueSessionUse(SESSION, { model: "gpt-5.4" }, installation);

    const forgeries: Record<string, unknown> = {
      // Everything a spread carries: the marker is copied, the authority is not.
      spread: { ...use },
      // The closest copy reflection can make of the object itself.
      descriptors: Object.create(Object.getPrototypeOf(use), Object.getOwnPropertyDescriptors(use)),
      // Delegating to a live use for everything a reader can see.
      delegating: Object.create(use),
      // The real session, presented as configured by whoever built this.
      substituted: {
        ...SESSION,
        ...{ [Symbol.for("executablemd.agent.session.configured")]: true },
      },
    };

    for (const [shape, forged] of Object.entries(forgeries)) {
      expect([shape, claimsConfiguration(forged)]).toEqual([shape, true]);
      expect([shape, refusalOf(() => readSessionUse(forged, installation))]).toEqual([
        shape,
        expect.stringContaining("not a configured session this run issued"),
      ]);
    }
  });

  it("SU6: the public accessors inspect an authentic value and refuse a claim", function* () {
    const use = issueSessionUse(SESSION, { model: "gpt-5.4", effort: "high" }, {});

    expect(isSessionUse(use)).toBe(true);
    expect(isSessionUse(SESSION)).toBe(false);
    // Unwrapping gives back what the provider issued, not the wrapper.
    expect(sessionOf(use)).toBe(SESSION);
    expect(sessionOf(SESSION)).toBe(SESSION);
    expect(sessionOf("review")).toBe(undefined);
    expect(configurationOf(use)).toEqual({ model: "gpt-5.4", effort: "high" });
    expect(configurationOf(SESSION)).toBe(undefined);
    expect(configurationOf("review")).toBe(undefined);
    // A claim this build did not issue is refused rather than read as an
    // ordinary session, which would run the conversation unconfigured.
    expect(refusalOf(() => configurationOf({ ...use }))).toContain(
      "not a configured session this build issued",
    );
  });

  it("SU5: a use from another installation is not this one's to act on", function* () {
    // Another document execution in this same copy: the value is authentic and
    // the authority is readable, and it still says nothing this installation
    // may act on. A use minted by a second loaded copy is a different question
    // and is asked by SU7, against an actual second copy.
    const use = issueSessionUse(SESSION, { effort: "high" }, {});
    const refused = refusalOf(() => readSessionUse(use, {}));
    expect(refused).toContain("belongs to a different agent provider installation");
    expect(new AgentSessionUseError("x").name).toBe("AgentSessionUseError");
  });
});
