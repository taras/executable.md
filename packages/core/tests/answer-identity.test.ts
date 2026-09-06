/**
 * Tier FE15 — what a stated identity is bound to, and when it stops meaning
 * anything.
 *
 * A generated fragment's admission is a decision about which implementation may
 * run. A function carries no identity a run can retain, so a provider states
 * one — and everything here is about the two ways a stated identity could be
 * weaker than it looks: outliving the execution that minted it, or surviving
 * the answer it was stated about being replaced or edited.
 *
 * The rows count what `identify()` answers rather than what a refusal says,
 * because a claim that reported correctly while still identifying a substituted
 * object would satisfy an error-shape assertion and none of these.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import type { Operation } from "effection";

import {
  AnswerIdentities,
  AnswerIdentityError,
  identityRecord,
} from "../src/components/answer-identity.ts";
import type { AnswerIdentity } from "../src/components/answer-identity.ts";
import type { ImportedDefinition } from "../src/components/import-authority.ts";
import type { Json } from "../src/types.ts";

const IDENTITY: AnswerIdentity = { origin: "test://provider", key: "Open", revision: "1" };
const OTHER: AnswerIdentity = { origin: "test://provider", key: "Open", revision: "2" };

/** One answer a provider might return, fresh each time. */
function answer(name = "Open"): ImportedDefinition {
  return {
    kind: "function",
    name,
    props: { type: "object", properties: {}, additionalProperties: false },
    // deno-lint-ignore require-yield
    *fn(): Operation<Json> {
      return "";
    },
  };
}

describe("Tier FE15 — an identity belongs to one object in one execution", () => {
  it("FE15: an identity is stated on the exact answer and read back", function* () {
    const execution = new AnswerIdentities();
    const supplied = execution.claimant().claim(answer(), IDENTITY);

    expect(execution.identify(supplied)).toEqual(IDENTITY);
    expect(identityRecord(IDENTITY)).toBe("test://provider#Open@1");
  });

  it("FE15: a different object carries no claim, however alike", function* () {
    const execution = new AnswerIdentities();
    const claimed = execution.claimant().claim(answer(), IDENTITY);
    // Structurally identical, and not the thing that was claimed. This is the
    // outer-replacement case: a handler further out returns its own object, so
    // an intermediate claim does not travel with the name.
    const replacement = answer();

    expect(execution.identify(claimed)).toEqual(IDENTITY);
    expect(execution.identify(replacement)).toBe(undefined);
    // A copy of the claimed object is a different object too.
    expect(execution.identify({ ...claimed })).toBe(undefined);
  });

  it("FE15: editing the claimed answer invalidates the claim", function* () {
    const execution = new AnswerIdentities();
    const claimed = execution.claimant().claim(answer(), IDENTITY);
    expect(execution.identify(claimed)).toEqual(IDENTITY);

    // The same object, edited after the claim by a handler further out. What
    // was claimed is no longer what is there.
    (claimed as { name: string }).name = "Substituted";

    expect(execution.identify(claimed)).toBe(undefined);
  });

  it("FE15: a claimant retained past its execution states nothing", function* () {
    const execution = new AnswerIdentities();
    const claimant = execution.claimant();
    const before = claimant.claim(answer(), IDENTITY);
    expect(execution.identify(before)).toEqual(IDENTITY);

    execution.revoke();

    // The claimant is the object a provider kept. It refuses rather than
    // silently recording into an execution that has ended.
    let refused: unknown;
    try {
      claimant.claim(answer(), IDENTITY);
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(AnswerIdentityError);
    // And what it stated while the execution was live identifies nothing now:
    // an admission may not be reconciled against a run that is over.
    expect(execution.identify(before)).toBe(undefined);
    expect(execution.active).toBe(false);
  });

  it("FE15: two executions are independent", function* () {
    const first = new AnswerIdentities();
    const second = new AnswerIdentities();
    const shared = answer();

    first.claimant().claim(shared, IDENTITY);
    // The positive control: a later execution is unaffected by the first's
    // teardown, and states its own identity for the same object.
    first.revoke();
    second.claimant().claim(shared, OTHER);

    expect(first.identify(shared)).toBe(undefined);
    expect(second.identify(shared)).toEqual(OTHER);
  });

  it("FE15: a second claim on one object replaces the first", function* () {
    const execution = new AnswerIdentities();
    const claimant = execution.claimant();
    const supplied = answer();

    claimant.claim(supplied, IDENTITY);
    // Two handlers competing over one object. The last statement is what the
    // object is: an identity is a claim about the answer, and the chain's final
    // word about it is the one a continuation is held to.
    claimant.claim(supplied, OTHER);

    expect(execution.identify(supplied)).toEqual(OTHER);
  });

  it("FE15: a partial identity is refused rather than recorded", function* () {
    const execution = new AnswerIdentities();
    const claimant = execution.claimant();
    const attempts: AnswerIdentity[] = [
      { origin: "", key: "Open", revision: "1" },
      { origin: "test://provider", key: "", revision: "1" },
      { origin: "test://provider", key: "Open", revision: "" },
    ];

    for (const attempt of attempts) {
      const supplied = answer();
      let refused: unknown;
      try {
        claimant.claim(supplied, attempt);
      } catch (error) {
        refused = error;
      }
      expect(refused).toBeInstanceOf(AnswerIdentityError);
      // Refused rather than partially recorded: a half identity would compare
      // equal to a different half identity.
      expect(execution.identify(supplied)).toBe(undefined);
    }
  });

  it("FE15: an answer nobody claimed identifies nothing", function* () {
    const execution = new AnswerIdentities();
    // The ordinary case, and the reason this is not authority: an unidentified
    // answer is a perfectly good answer. What it cannot be is the thing a
    // fragment runs, because a continuation would have nothing to compare.
    expect(execution.identify(answer())).toBe(undefined);
    expect(execution.identify(undefined)).toBe(undefined);
    expect(execution.identify(null)).toBe(undefined);
    expect(execution.identify("Open")).toBe(undefined);
  });
});
