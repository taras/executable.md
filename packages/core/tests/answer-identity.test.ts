/**
 * Tier CIV — what a stated identity is bound to, and when it stops meaning
 * anything.
 *
 * A generated fragment's admission is a decision about which implementation may
 * run. A function carries no identity a run can retain — comparing one compares
 * how somebody wrote their code — so a provider states one. Everything here is
 * about the ways a stated identity could be weaker than it looks: outliving the
 * execution that minted it, outliving the *invocation* that made it, surviving
 * the answer being replaced or edited, or being overwritten by a second
 * provider.
 *
 * The shape under test is the split between two authorities. A provider
 * installation is the right to be asked, and it is deliberately reusable: one
 * installation answers several admitted names and the same name resolved more
 * than once. A request is the right to answer one asking, and it is closed the
 * moment that handler invocation ends. Only a request claims, which is what
 * makes a statement provable — an installation handle can prove "some provider
 * this host installed" and nothing about which invocation is speaking.
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
import type {
  AnswerIdentity,
  ComponentAnswerRequest,
  ImportedDefinition,
  ProviderInstallation,
  ResolutionWindow,
} from "../src/components/import-authority.ts";
import type { Json } from "../src/types.ts";

const ORIGIN = "test://provider";
const IDENTITY: AnswerIdentity = { origin: ORIGIN, key: "Open", revision: "1" };
const OPEN = { key: "Open", revision: "1" } as const;
const OTHER = { key: "Other", revision: "1" } as const;

/** One owner, activated the way canonical execution activates it. */
function owner(): CanonicalImports {
  const imports = new CanonicalImports();
  imports.activate();
  return imports;
}

/**
 * Run one resolution of `name`, the way canonical execution runs one.
 *
 * The window is handed to the body, because that is the value identification
 * takes: a caller proves which import it is asking about by holding the object
 * it opened.
 */
function resolving<T>(
  imports: CanonicalImports,
  name: string,
  work: (resolution: ResolutionWindow) => T,
): T {
  const resolution = imports.beginResolution(name);
  try {
    return work(resolution);
  } finally {
    resolution.close();
  }
}

/**
 * Run one handler invocation of this installation, asked for `name`.
 *
 * The request is closed when the body returns, which is what the registrar does
 * around a real handler. A row that keeps the request is keeping exactly what a
 * provider could keep.
 */
function asking<T>(
  installation: ProviderInstallation,
  name: string,
  work: (request: ComponentAnswerRequest) => T,
): T {
  const asked = installation.open(name);
  try {
    return work(asked.request);
  } finally {
    asked.close();
  }
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

describe("Tier CIV — an identity belongs to one answer of one import", () => {
  it("CIV23: an identity is stated on the exact answer and read back", function* () {
    const imports = owner();
    const provider = imports.provider(ORIGIN);

    const { resolution, supplied } = resolving(imports, "Open", (resolution) => ({
      resolution,
      supplied: asking(provider, "Open", (request) => request.claim(answer(), OPEN)),
    }));

    expect(imports.identify(resolution, supplied)?.identity).toEqual(IDENTITY);
    expect(identityRecord(IDENTITY)).toBe("test://provider#Open@1");
  });

  it("CIV24: identification answers with the claim-time copy, not the answer", function* () {
    const imports = owner();
    const provider = imports.provider(ORIGIN);
    const supplied = answer();

    const resolution = resolving(imports, "Open", (resolution) => {
      asking(provider, "Open", (request) => request.claim(supplied, OPEN));
      return resolution;
    });

    // One call answers both halves. The definition is core's own copy, taken
    // when the claim was recorded — so a caller that keeps what identification
    // gave it has kept the object the check was made about, and never has to
    // read the chain's object a second time to obtain one.
    const identified = imports.identify(resolution, supplied);
    expect(identified?.identity).toEqual(IDENTITY);
    expect(identified?.definition).not.toBe(supplied);
    expect(identified?.definition.name).toBe("Open");
    // The implementation crosses by reference, because a function is not
    // copyable and is the one thing a fragment must invoke as itself.
    expect(implementationOf(identified?.definition)).toBe(implementationOf(supplied));
  });

  it("CIV24: an alternating answer cannot launder a copy through a second read", function* () {
    const imports = owner();
    const provider = imports.provider(ORIGIN);
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

    const resolution = resolving(imports, "Open", (resolution) => {
      asking(provider, "Open", (request) => request.claim(alternating, OPEN));
      return resolution;
    });
    const identified = imports.identify(resolution, alternating);

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

  it("CIV23: restating exactly the same claim is idempotent", function* () {
    const imports = owner();
    const provider = imports.provider(ORIGIN);
    const supplied = answer();

    const resolution = resolving(imports, "Open", (resolution) => {
      asking(provider, "Open", (request) => {
        request.claim(supplied, OPEN);
        // A provider installed twice states the same thing twice. That is not
        // two providers disagreeing, and it is not a conflict.
        expect(refusalOf(() => request.claim(supplied, OPEN))).toBe(undefined);
      });
      return resolution;
    });
    expect(imports.identify(resolution, supplied)?.identity).toEqual(IDENTITY);
  });

  it("CIV23: a competing claim refuses and never overwrites the first", function* () {
    const imports = owner();
    const first = imports.provider(ORIGIN);
    const second = imports.provider("test://other");
    const held = answer();

    const resolution = resolving(imports, "Open", (resolution) => {
      asking(first, "Open", (request) => request.claim(held, OPEN));
      // Another installation, asked in the same live resolution, cannot rename
      // what the first stated. An overwrite would let a second provider take
      // the first's implementation.
      asking(second, "Open", (request) => {
        expect(refusalOf(() => request.claim(held, OPEN))).toBeInstanceOf(AnswerIdentityError);
      });
      // And the first installation's *next* invocation cannot restate it
      // differently either.
      asking(first, "Open", (request) => {
        expect(
          refusalOf(() => request.claim(held, { key: "Other", revision: "1" })),
        ).toBeInstanceOf(AnswerIdentityError);
        expect(refusalOf(() => request.claim(held, { key: "Open", revision: "2" }))).toBeInstanceOf(
          AnswerIdentityError,
        );
      });
      return resolution;
    });

    expect(imports.identify(resolution, held)?.identity).toEqual(IDENTITY);
  });

  it("CIV25: a request whose handler has returned states nothing", function* () {
    const imports = owner();
    const provider = imports.provider(ORIGIN);
    const late = answer();
    let stale: ComponentAnswerRequest | undefined;

    // The losing-handler case, inside one live resolution. The handler keeps
    // the request it was given and returns; the resolution is still open, and
    // the execution is still very much alive. What has ended is this
    // invocation, and an invocation that has returned is not supplying an
    // answer.
    const resolution = resolving(imports, "Open", (resolution) => {
      asking(provider, "Open", (request) => {
        stale = request;
      });
      expect(refusalOf(() => stale?.claim(late, OPEN))).toBeInstanceOf(AnswerIdentityError);
      // The positive control in the same still-open window: a fresh invocation
      // of the same installation claims, so the refusal above is about the
      // handler lease rather than about the window or the provider.
      asking(provider, "Open", (request) => request.claim(answer(), OPEN));
      return resolution;
    });

    expect(imports.identify(resolution, late)).toBe(undefined);
    expect(imports.identifying).toBe(true);
  });

  it("CIV25: a stale request cannot answer the next resolution of its own name", function* () {
    const imports = owner();
    const provider = imports.provider(ORIGIN);
    const fresh = answer();
    const requests: ComponentAnswerRequest[] = [];
    let stale: ComponentAnswerRequest | undefined;

    // Resolution N of `Open`, whose handler keeps its request.
    resolving(imports, "Open", () => {
      asking(provider, "Open", (request) => {
        requests.push(request);
        stale = request;
      });
    });

    // Resolution N+1 of the same name. The stale request names the right
    // component and belongs to an import that is over.
    const { resolution, claimed } = resolving(imports, "Open", (resolution) => {
      expect(refusalOf(() => stale?.claim(fresh, OPEN))).toBeInstanceOf(AnswerIdentityError);
      // The same installation is asked again and answers this resolution: the
      // installation is reusable, the request is not.
      return {
        resolution,
        claimed: asking(provider, "Open", (request) => {
          requests.push(request);
          return request.claim(answer(), OPEN);
        }),
      };
    });

    expect(requests).toHaveLength(2);
    expect(requests[0]).not.toBe(requests[1]);
    expect(imports.identify(resolution, fresh)).toBe(undefined);
    expect(imports.identify(resolution, claimed)?.identity).toEqual(IDENTITY);
  });

  it("CIV25: a stale request cannot retag while another name is being decided", function* () {
    const imports = owner();
    const provider = imports.provider(ORIGIN);
    const substitute = answer("Other");
    let stale: ComponentAnswerRequest | undefined;

    resolving(imports, "Open", () => {
      asking(provider, "Open", (request) => {
        stale = request;
      });
    });

    // `claim` takes no name, so the stale request cannot even ask about the
    // name being decided: it is fixed to `Open`, which this resolution is not.
    const { resolution, claimed } = resolving(imports, "Other", (resolution) => {
      expect(stale?.name).toBe("Open");
      expect(refusalOf(() => stale?.claim(substitute, OTHER))).toBeInstanceOf(AnswerIdentityError);
      return {
        resolution,
        claimed: asking(provider, "Other", (request) => request.claim(answer("Other"), OTHER)),
      };
    });

    expect(imports.identify(resolution, substitute)).toBe(undefined);
    expect(imports.identify(resolution, claimed)?.identity.key).toBe("Other");
  });

  it("CIV25: one installation answers two names through two distinct requests", function* () {
    const imports = owner();
    // One installation owns one origin and may answer more than one admitted
    // name. Spending the installation on its first answer would break exactly
    // this, so what settles is the request rather than the provider.
    const provider = imports.provider(ORIGIN);
    const seen: ComponentAnswerRequest[] = [];

    const open = resolving(imports, "Open", (resolution) => ({
      resolution,
      claimed: asking(provider, "Open", (request) => {
        seen.push(request);
        return request.claim(answer(), OPEN);
      }),
    }));
    const other = resolving(imports, "Other", (resolution) => ({
      resolution,
      claimed: asking(provider, "Other", (request) => {
        seen.push(request);
        return request.claim(answer("Other"), OTHER);
      }),
    }));

    // Two invocations, two requests, each fixed to what it was asked.
    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe(seen[1]);
    expect(seen.map((request) => request.name)).toEqual(["Open", "Other"]);
    expect(imports.identify(open.resolution, open.claimed)?.identity.key).toBe("Open");
    expect(imports.identify(other.resolution, other.claimed)?.identity.key).toBe("Other");
  });

  it("CIV25: identification takes the window it was asked about", function* () {
    const imports = owner();
    const provider = imports.provider(ORIGIN);
    const requests: ComponentAnswerRequest[] = [];

    const first = resolving(imports, "Open", (resolution) => ({
      resolution,
      claimed: asking(provider, "Open", (request) => {
        requests.push(request);
        return request.claim(answer(), OPEN);
      }),
    }));
    const second = resolving(imports, "Open", (resolution) => ({
      resolution,
      claimed: asking(provider, "Open", (request) => {
        requests.push(request);
        return request.claim(answer(), OPEN);
      }),
    }));

    // Each answer belongs to the import it answered, and to no other. Nothing
    // here reads whichever window is current: the caller presents the one it
    // opened, which is why the answer does not change with when it is asked.
    expect(requests).toHaveLength(2);
    expect(requests[0]).not.toBe(requests[1]);
    expect(imports.identify(first.resolution, first.claimed)?.identity).toEqual(IDENTITY);
    expect(imports.identify(second.resolution, second.claimed)?.identity).toEqual(IDENTITY);
    expect(imports.identify(first.resolution, second.claimed)).toBe(undefined);
    expect(imports.identify(second.resolution, first.claimed)).toBe(undefined);
  });

  it("CIV25: a request shows the asked position by value", function* () {
    const imports = owner();
    const provider = imports.provider(ORIGIN);
    // The engine's own object, which it reads again after any handler has seen
    // it. A provider is shown a copy, like everything else it is shown.
    const scanned = { path: "doc.md", offset: 12, line: 3, column: 5 };

    resolving(imports, "Open", () => {
      const asked = provider.open("Open", scanned);
      try {
        const shown = asked.request.position;
        expect(shown).toEqual(scanned);
        expect(shown).not.toBe(scanned);
        // Editing what the handler was given reaches nothing, and the request
        // itself cannot be re-pointed at another element.
        expect(() => {
          (shown as { line: number }).line = 99;
        }).toThrow();
        expect(() => {
          (asked.request as { name: string }).name = "Other";
        }).toThrow();
      } finally {
        asked.close();
      }
      // And the engine's own object is untouched by having been shown.
      expect(scanned).toEqual({ path: "doc.md", offset: 12, line: 3, column: 5 });
    });
  });

  it("CIV23: a different object carries no claim, however alike", function* () {
    const imports = owner();
    const provider = imports.provider(ORIGIN);

    const { resolution, claimed } = resolving(imports, "Open", (resolution) => ({
      resolution,
      claimed: asking(provider, "Open", (request) => request.claim(answer(), OPEN)),
    }));

    expect(imports.identify(resolution, claimed)?.identity).toEqual(IDENTITY);
    // The outer-replacement case: a handler further out returns its own object,
    // so an intermediate claim does not travel with the name.
    expect(imports.identify(resolution, answer())).toBe(undefined);
    // A copy of the claimed object is a different object too.
    expect(imports.identify(resolution, { ...claimed })).toBe(undefined);
  });

  it("CIV23: editing the claimed answer invalidates the claim", function* () {
    const imports = owner();
    const provider = imports.provider(ORIGIN);

    const { resolution, claimed } = resolving(imports, "Open", (resolution) => ({
      resolution,
      claimed: asking(provider, "Open", (request) => request.claim(answer(), OPEN)),
    }));
    expect(imports.identify(resolution, claimed)?.identity).toEqual(IDENTITY);

    // The same object, edited after the claim by a handler further out. What
    // was claimed is no longer what is there.
    (claimed as { name: string }).name = "Substituted";

    expect(imports.identify(resolution, claimed)).toBe(undefined);
  });

  it("CIV25: an installation retained past its execution opens nothing", function* () {
    const imports = owner();
    const provider = imports.provider(ORIGIN);
    const { resolution, before } = resolving(imports, "Open", (resolution) => ({
      resolution,
      before: asking(provider, "Open", (request) => request.claim(answer(), OPEN)),
    }));
    expect(imports.identify(resolution, before)?.identity).toEqual(IDENTITY);

    imports.revoke();

    // The installation is the object a provider kept. The window it would need
    // cannot be opened, and a request minted from it states nothing.
    expect(refusalOf(() => imports.beginResolution("Open"))).toBeInstanceOf(AnswerIdentityError);
    expect(
      refusalOf(() => asking(provider, "Open", (request) => request.claim(answer(), OPEN))),
    ).toBeInstanceOf(AnswerIdentityError);
    // And what it stated while the execution was live identifies nothing now:
    // an admission may not be reconciled against a run that is over.
    expect(imports.identify(resolution, before)).toBe(undefined);
    expect(imports.identifying).toBe(false);
  });

  it("CIV25: an owner starts inactive, so a claim before activation refuses", function* () {
    const imports = new CanonicalImports();
    // Canonical execution registers teardown, then activates, then installs
    // providers. A claim that landed before activation would be a claim with no
    // teardown behind it.
    expect(imports.identifying).toBe(false);
    expect(refusalOf(() => imports.beginResolution("Open"))).toBeInstanceOf(AnswerIdentityError);
    expect(
      refusalOf(() =>
        asking(imports.provider(ORIGIN), "Open", (request) => request.claim(answer(), OPEN)),
      ),
    ).toBeInstanceOf(AnswerIdentityError);
  });

  it("CIV25: overlapping executions are isolated", function* () {
    const first = owner();
    const second = owner();
    const shared = answer();

    const one = resolving(first, "Open", (resolution) => {
      asking(first.provider(ORIGIN), "Open", (request) => request.claim(shared, OPEN));
      return resolution;
    });
    // Live at the same time, and each answers only for what it recorded.
    const two = resolving(second, "Open", (resolution) => {
      expect(second.identify(resolution, shared)).toBe(undefined);
      asking(second.provider(ORIGIN), "Open", (request) =>
        request.claim(shared, { key: "Open", revision: "2" }),
      );
      return resolution;
    });

    expect(first.identify(one, shared)?.identity).toEqual(IDENTITY);
    expect(second.identify(two, shared)?.identity).toEqual({
      origin: ORIGIN,
      key: "Open",
      revision: "2",
    });

    // The positive control: tearing one down leaves the other working.
    first.revoke();
    expect(first.identify(one, shared)).toBe(undefined);
    expect(second.identify(two, shared)?.identity.revision).toBe("2");
  });

  it("CIV23: a provider cannot state an origin canonical execution did not give it", function* () {
    const imports = owner();
    // The installation carries the origin; the provider states only key and
    // revision. There is no member on the claim call to put another origin in.
    const { resolution, claimed } = resolving(imports, "Open", (resolution) => ({
      resolution,
      claimed: asking(imports.provider("test://assigned"), "Open", (request) =>
        request.claim(answer(), OPEN),
      ),
    }));

    expect(imports.identify(resolution, claimed)?.identity.origin).toBe("test://assigned");
  });

  it("CIV23: a partial identity is refused rather than recorded", function* () {
    const imports = owner();
    const provider = imports.provider(ORIGIN);
    const attempts = [
      { key: "", revision: "1" },
      { key: "Open", revision: "" },
    ];

    for (const attempt of attempts) {
      const supplied = answer();
      const resolution = resolving(imports, "Open", (resolution) => {
        asking(provider, "Open", (request) => {
          expect(refusalOf(() => request.claim(supplied, attempt))).toBeInstanceOf(
            AnswerIdentityError,
          );
        });
        return resolution;
      });
      // Refused rather than partially recorded: a half identity would compare
      // equal to a different half identity.
      expect(imports.identify(resolution, supplied)).toBe(undefined);
    }
  });

  it("CIV23: an answer nobody claimed identifies nothing", function* () {
    const imports = owner();
    // The ordinary case, and the reason this is not authority: an unidentified
    // answer is a perfectly good answer. What it cannot be is the thing a
    // fragment runs, because a continuation would have nothing to compare.
    resolving(imports, "Open", (resolution) => {
      expect(imports.identify(resolution, answer())).toBe(undefined);
      expect(imports.identify(resolution, undefined)).toBe(undefined);
      expect(imports.identify(resolution, null)).toBe(undefined);
      expect(imports.identify(resolution, "Open")).toBe(undefined);
    });
  });
});
