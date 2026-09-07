/**
 * Tier FE15 — what a stated identity is bound to, and when it stops meaning
 * anything.
 *
 * A generated fragment's admission is a decision about which implementation may
 * run. A function carries no identity a run can retain — comparing one compares
 * how somebody wrote their code — so a provider states one. Everything here is
 * about the ways a stated identity could be weaker than it looks: outliving the
 * execution that minted it, surviving the answer being replaced or edited, or
 * being overwritten by a second provider.
 *
 * The rows read what `identify()` answers rather than what a refusal says: a
 * claim that reported correctly while still identifying a substituted object
 * would satisfy an error-shape assertion and none of these.
 *
 * The owner is `CanonicalImports`, which already holds issuance and retention.
 * One owner asks one question about one table; a second registry would be a
 * second place an answer could be authorized from.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import type { Operation } from "effection";

import {
  AnswerIdentityError,
  CanonicalImports,
  identityRecord,
} from "../src/components/import-authority.ts";
import type { AnswerIdentity, ImportedDefinition } from "../src/components/import-authority.ts";
import type { Json } from "../src/types.ts";

const ORIGIN = "test://provider";
const IDENTITY: AnswerIdentity = { origin: ORIGIN, key: "Open", revision: "1" };

/** One owner, activated the way canonical execution activates it. */
function owner(): CanonicalImports {
  const imports = new CanonicalImports();
  imports.activate();
  return imports;
}

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

/** The implementation on a definition, whichever arm of the union it is. */
function implementationOf(definition: ImportedDefinition | undefined): unknown {
  return definition === undefined ? undefined : (definition as { fn?: unknown }).fn;
}

/** What a call refused with, or `undefined` when it did not refuse. */
function refusalOf(attempt: () => unknown): unknown {
  try {
    attempt();
    return undefined;
  } catch (error) {
    return error;
  }
}

describe("Tier FE15 — an identity belongs to one object in one execution", () => {
  it("FE15: an identity is stated on the exact answer and read back", function* () {
    const imports = owner();
    const supplied = imports.claimant(ORIGIN).claim("Open", answer(), {
      key: "Open",
      revision: "1",
    });

    expect(imports.identify("Open", supplied)?.identity).toEqual(IDENTITY);
    expect(identityRecord(IDENTITY)).toBe("test://provider#Open@1");
  });

  it("FE15: identification answers with the claim-time copy, not the answer", function* () {
    const imports = owner();
    const supplied = answer();
    imports.claimant(ORIGIN).claim("Open", supplied, { key: "Open", revision: "1" });

    // One call answers both halves. The definition is core's own copy, taken
    // when the claim was recorded — so a caller that keeps what identification
    // gave it has kept the object the check was made about, and never has to
    // read the chain's object a second time to obtain one.
    const identified = imports.identify("Open", supplied);
    expect(identified?.identity).toEqual(IDENTITY);
    expect(identified?.definition).not.toBe(supplied);
    expect(identified?.definition.name).toBe("Open");
    // The implementation crosses by reference, because a function is not
    // copyable and is the one thing a fragment must invoke as itself.
    expect(implementationOf(identified?.definition)).toBe(implementationOf(supplied));
  });

  it("FE15: an alternating answer cannot launder a copy through a second read", function* () {
    const imports = owner();
    const honest = answer();
    const reads: string[] = [];
    // The check/use gap, planted. Reading a member through `[[Get]]` alternates
    // between what was claimed and a substitution; comparing descriptors, which
    // is how the claim is checked, does not run this at all. So a caller that
    // checked the descriptors and then *read* the object again to keep a copy
    // would keep the substitution, and this row is what says nothing does.
    const alternating = new Proxy(honest, {
      get(target, key, receiver) {
        if (key !== "name") {
          return Reflect.get(target, key, receiver);
        }
        reads.push(key);
        return reads.length % 2 === 1 ? "Open" : "Substituted";
      },
    }) as ImportedDefinition;

    imports.claimant(ORIGIN).claim("Open", alternating, { key: "Open", revision: "1" });
    const identified = imports.identify("Open", alternating);

    // The claim itself was recorded from the first reading, and identification
    // answers with that recording.
    expect(identified?.identity).toEqual(IDENTITY);
    expect(identified?.definition.name).toBe("Open");
    // The plant is live rather than inert: the very next read of the object the
    // chain returned says something else, which is what a second read would
    // have kept.
    expect((alternating as { name: string }).name).toBe("Substituted");
    expect(identified?.definition.name).toBe("Open");
  });

  it("FE15: restating exactly the same claim is idempotent", function* () {
    const imports = owner();
    const claimant = imports.claimant(ORIGIN);
    const supplied = answer();

    claimant.claim("Open", supplied, { key: "Open", revision: "1" });
    // A provider installed twice states the same thing twice. That is not two
    // providers disagreeing, and it is not a conflict.
    expect(refusalOf(() => claimant.claim("Open", supplied, { key: "Open", revision: "1" }))).toBe(
      undefined,
    );
    expect(imports.identify("Open", supplied)?.identity).toEqual(IDENTITY);
  });

  it("FE15: a competing claim refuses and never overwrites the first", function* () {
    const imports = owner();
    const first = imports.claimant(ORIGIN);
    const second = imports.claimant("test://other");

    const cases: Array<[string, () => unknown]> = [
      ["another claimant", () => second.claim("Open", held, { key: "Open", revision: "1" })],
      ["another name", () => first.claim("Elsewhere", held, { key: "Open", revision: "1" })],
      ["another key", () => first.claim("Open", held, { key: "Other", revision: "1" })],
      ["another revision", () => first.claim("Open", held, { key: "Open", revision: "2" })],
    ];

    const held = answer();
    first.claim("Open", held, { key: "Open", revision: "1" });

    for (const [, attempt] of cases) {
      expect(refusalOf(attempt)).toBeInstanceOf(AnswerIdentityError);
      // The first statement stands after every one of them. An overwrite would
      // let a second provider rename the first's implementation.
      expect(imports.identify("Open", held)?.identity).toEqual(IDENTITY);
    }
  });

  it("FE15: a different object carries no claim, however alike", function* () {
    const imports = owner();
    const claimed = imports.claimant(ORIGIN).claim("Open", answer(), {
      key: "Open",
      revision: "1",
    });

    expect(imports.identify("Open", claimed)?.identity).toEqual(IDENTITY);
    // The outer-replacement case: a handler further out returns its own object,
    // so an intermediate claim does not travel with the name.
    expect(imports.identify("Open", answer())).toBe(undefined);
    // A copy of the claimed object is a different object too.
    expect(imports.identify("Open", { ...claimed })).toBe(undefined);
  });

  it("FE15: an identity is read under the name it was claimed for", function* () {
    const imports = owner();
    const claimed = imports.claimant(ORIGIN).claim("Open", answer(), {
      key: "Open",
      revision: "1",
    });

    // The same object asked about under another name identifies nothing: a
    // claim is about one implementation of one component.
    expect(imports.identify("Elsewhere", claimed)).toBe(undefined);
  });

  it("FE15: editing the claimed answer invalidates the claim", function* () {
    const imports = owner();
    const claimed = imports.claimant(ORIGIN).claim("Open", answer(), {
      key: "Open",
      revision: "1",
    });
    expect(imports.identify("Open", claimed)?.identity).toEqual(IDENTITY);

    // The same object, edited after the claim by a handler further out. What
    // was claimed is no longer what is there.
    (claimed as { name: string }).name = "Substituted";

    expect(imports.identify("Open", claimed)).toBe(undefined);
  });

  it("FE15: a claimant retained past its execution states nothing", function* () {
    const imports = owner();
    const claimant = imports.claimant(ORIGIN);
    const before = claimant.claim("Open", answer(), { key: "Open", revision: "1" });
    expect(imports.identify("Open", before)?.identity).toEqual(IDENTITY);

    imports.revoke();

    // The claimant is the object a provider kept. It refuses rather than
    // recording into an execution that has ended.
    expect(
      refusalOf(() => claimant.claim("Open", answer(), { key: "Open", revision: "1" })),
    ).toBeInstanceOf(AnswerIdentityError);
    // And what it stated while the execution was live identifies nothing now:
    // an admission may not be reconciled against a run that is over.
    expect(imports.identify("Open", before)).toBe(undefined);
    expect(imports.identifying).toBe(false);
  });

  it("FE15: an owner starts inactive, so a claim before activation refuses", function* () {
    const imports = new CanonicalImports();
    // Canonical execution registers teardown, then activates, then mints
    // claimants. A claim that landed before activation would be a claim with no
    // teardown behind it.
    expect(imports.identifying).toBe(false);
    expect(
      refusalOf(() =>
        imports.claimant(ORIGIN).claim("Open", answer(), {
          key: "Open",
          revision: "1",
        }),
      ),
    ).toBeInstanceOf(AnswerIdentityError);
  });

  it("FE15: overlapping executions are isolated", function* () {
    const first = owner();
    const second = owner();
    const shared = answer();

    first.claimant(ORIGIN).claim("Open", shared, { key: "Open", revision: "1" });
    // Live at the same time, and each answers only for what it recorded.
    expect(second.identify("Open", shared)).toBe(undefined);
    second.claimant(ORIGIN).claim("Open", shared, { key: "Open", revision: "2" });

    expect(first.identify("Open", shared)?.identity).toEqual(IDENTITY);
    expect(second.identify("Open", shared)?.identity).toEqual({
      origin: ORIGIN,
      key: "Open",
      revision: "2",
    });

    // The positive control: tearing one down leaves the other working.
    first.revoke();
    expect(first.identify("Open", shared)).toBe(undefined);
    expect(second.identify("Open", shared)?.identity.revision).toBe("2");
  });

  it("FE15: a provider cannot state an origin canonical execution did not give it", function* () {
    const imports = owner();
    // The claimant carries the origin; the provider states only key and
    // revision. There is no member on the claim call to put another origin in.
    const claimed = imports.claimant("test://assigned").claim("Open", answer(), {
      key: "Open",
      revision: "1",
    });

    expect(imports.identify("Open", claimed)?.identity.origin).toBe("test://assigned");
  });

  it("FE15: a partial identity is refused rather than recorded", function* () {
    const imports = owner();
    const claimant = imports.claimant(ORIGIN);
    const attempts = [
      { key: "", revision: "1" },
      { key: "Open", revision: "" },
    ];

    for (const attempt of attempts) {
      const supplied = answer();
      expect(refusalOf(() => claimant.claim("Open", supplied, attempt))).toBeInstanceOf(
        AnswerIdentityError,
      );
      // Refused rather than partially recorded: a half identity would compare
      // equal to a different half identity.
      expect(imports.identify("Open", supplied)).toBe(undefined);
    }
  });

  it("FE15: an answer nobody claimed identifies nothing", function* () {
    const imports = owner();
    // The ordinary case, and the reason this is not authority: an unidentified
    // answer is a perfectly good answer. What it cannot be is the thing a
    // fragment runs, because a continuation would have nothing to compare.
    expect(imports.identify("Open", answer())).toBe(undefined);
    expect(imports.identify("Open", undefined)).toBe(undefined);
    expect(imports.identify("Open", null)).toBe(undefined);
    expect(imports.identify("Open", "Open")).toBe(undefined);
  });
});
