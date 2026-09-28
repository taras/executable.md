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
 * The shape under test is the split between two separate rights. A provider
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
import { all, race, scoped, sleep, useScope, withResolvers } from "effection";
import type { Operation, Scope } from "effection";

import {
  AnswerIdentityError,
  CanonicalImports,
  identityRecord,
} from "../src/components/component-resolution.ts";
import type {
  AnswerIdentity,
  ComponentAnswerRequest,
  ImportedDefinition,
  ProviderInstallation,
  ResolutionWindow,
} from "../src/components/component-resolution.ts";
import type { Json } from "../src/types.ts";

const ORIGIN = "test://provider";
const IDENTITY: AnswerIdentity = { origin: ORIGIN, key: "Open", revision: "1" };
const OPEN = { key: "Open", revision: "1" } as const;
const OTHER = { key: "Other", revision: "1" } as const;

/**
 * Where two sibling spawns wait for each other.
 *
 * A window belongs to the engine scope that opened it, so the rows about two
 * spawns at once are written as two operations that each own their own scope and
 * read it from inside. Nothing hands a `Scope` out of the operation that owns
 * it, and a window never outlives the body that opened it.
 *
 * What is left is the coordination: both spawns have to be *open together*,
 * which is the whole point, and neither may run ahead. Each step is a counter
 * and one signal — the party that completes it releases everybody waiting on
 * it, and a step that never completes is reported as a deadlock rather than
 * waited on forever.
 */
function rendezvous(parties: number): (step: string) => Operation<void> {
  const steps = new Map<string, { arrived: number; reached: Signal }>();
  return function meet(step: string): Operation<void> {
    let slot = steps.get(step);
    if (slot === undefined) {
      slot = { arrived: 0, reached: signal() };
      steps.set(step, slot);
    }
    const waiting = slot;
    return (function* () {
      waiting.arrived += 1;
      if (waiting.arrived >= parties) {
        waiting.reached.publish();
      }
      yield* awaiting(`both spawns reaching "${step}"`, waiting.reached.published);
    })();
  };
}

/**
 * How long a step a correct engine completes immediately may go uncompleted
 * before the wait is called a deadlock.
 *
 * Never reached by a passing run: every step below is completed by the other
 * spawn. It bounds only the failure mode, so a defect that stops one spawn
 * says which step it stopped at instead of hanging the suite.
 */
const DEADLOCK_MS = 10_000;

interface Signal {
  publish(): void;
  readonly published: Operation<boolean>;
}

function signal(): Signal {
  const resolvers = withResolvers<boolean>();
  let settled = false;
  return {
    publish() {
      if (!settled) {
        settled = true;
        resolvers.resolve(true);
      }
    },
    get published() {
      return resolvers.operation;
    },
  };
}

function* awaiting(what: string, waited: Operation<boolean>): Operation<void> {
  const reached = yield* race([
    waited,
    (function* (): Operation<boolean> {
      yield* sleep(DEADLOCK_MS);
      return false;
    })(),
  ]);
  if (!reached) {
    throw new Error(`${what} never happened`);
  }
}

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
  scope: Scope,
): T {
  const resolution = imports.beginResolution(name, scope);
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
  scope: Scope,
): T {
  const asked = installation.open(scope, name);
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
    const here = yield* useScope();
    const imports = owner();
    const provider = imports.provider(ORIGIN);

    const { resolution, supplied } = resolving(
      imports,
      "Open",
      (resolution) => ({
        resolution,
        supplied: asking(provider, "Open", (request) => request.claim(answer(), OPEN), here),
      }),
      here,
    );

    expect(imports.identify(resolution, supplied)?.identity).toEqual(IDENTITY);
    expect(identityRecord(IDENTITY)).toBe("test://provider#Open@1");
  });

  it("CIV24: identification answers with the claim-time copy, not the answer", function* () {
    const here = yield* useScope();
    const imports = owner();
    const provider = imports.provider(ORIGIN);
    const supplied = answer();

    const resolution = resolving(
      imports,
      "Open",
      (resolution) => {
        asking(provider, "Open", (request) => request.claim(supplied, OPEN), here);
        return resolution;
      },
      here,
    );

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
    const here = yield* useScope();
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

    const resolution = resolving(
      imports,
      "Open",
      (resolution) => {
        asking(provider, "Open", (request) => request.claim(alternating, OPEN), here);
        return resolution;
      },
      here,
    );
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
    const here = yield* useScope();
    const imports = owner();
    const provider = imports.provider(ORIGIN);
    const supplied = answer();

    const resolution = resolving(
      imports,
      "Open",
      (resolution) => {
        asking(
          provider,
          "Open",
          (request) => {
            request.claim(supplied, OPEN);
            // A provider installed twice states the same thing twice. That is not
            // two providers disagreeing, and it is not a conflict.
            expect(refusalOf(() => request.claim(supplied, OPEN))).toBe(undefined);
          },
          here,
        );
        return resolution;
      },
      here,
    );
    expect(imports.identify(resolution, supplied)?.identity).toEqual(IDENTITY);
  });

  it("CIV23: a competing claim refuses and never overwrites the first", function* () {
    const here = yield* useScope();
    const imports = owner();
    const first = imports.provider(ORIGIN);
    const second = imports.provider("test://other");
    const held = answer();

    const resolution = resolving(
      imports,
      "Open",
      (resolution) => {
        asking(first, "Open", (request) => request.claim(held, OPEN), here);
        // Another installation, asked in the same live resolution, cannot rename
        // what the first stated. An overwrite would let a second provider take
        // the first's implementation.
        asking(
          second,
          "Open",
          (request) => {
            expect(refusalOf(() => request.claim(held, OPEN))).toBeInstanceOf(AnswerIdentityError);
          },
          here,
        );
        // And the first installation's *next* invocation cannot restate it
        // differently either.
        asking(
          first,
          "Open",
          (request) => {
            expect(
              refusalOf(() => request.claim(held, { key: "Other", revision: "1" })),
            ).toBeInstanceOf(AnswerIdentityError);
            expect(
              refusalOf(() => request.claim(held, { key: "Open", revision: "2" })),
            ).toBeInstanceOf(AnswerIdentityError);
          },
          here,
        );
        return resolution;
      },
      here,
    );

    expect(imports.identify(resolution, held)?.identity).toEqual(IDENTITY);
  });

  it("CIV25: a request whose handler has returned states nothing", function* () {
    const here = yield* useScope();
    const imports = owner();
    const provider = imports.provider(ORIGIN);
    const late = answer();
    let stale: ComponentAnswerRequest | undefined;

    // The losing-handler case, inside one live resolution. The handler keeps
    // the request it was given and returns; the resolution is still open, and
    // the execution is still very much alive. What has ended is this
    // invocation, and an invocation that has returned is not supplying an
    // answer.
    const resolution = resolving(
      imports,
      "Open",
      (resolution) => {
        asking(
          provider,
          "Open",
          (request) => {
            stale = request;
          },
          here,
        );
        expect(refusalOf(() => stale?.claim(late, OPEN))).toBeInstanceOf(AnswerIdentityError);
        // The positive control in the same still-open window: a fresh invocation
        // of the same installation claims, so the refusal above is about the
        // handler lease rather than about the window or the provider.
        asking(provider, "Open", (request) => request.claim(answer(), OPEN), here);
        return resolution;
      },
      here,
    );

    expect(imports.identify(resolution, late)).toBe(undefined);
    expect(imports.identifying).toBe(true);
  });

  it("CIV25: a stale request cannot answer the next resolution of its own name", function* () {
    const here = yield* useScope();
    const imports = owner();
    const provider = imports.provider(ORIGIN);
    const fresh = answer();
    const requests: ComponentAnswerRequest[] = [];
    let stale: ComponentAnswerRequest | undefined;

    // Resolution N of `Open`, whose handler keeps its request.
    resolving(
      imports,
      "Open",
      () => {
        asking(
          provider,
          "Open",
          (request) => {
            requests.push(request);
            stale = request;
          },
          here,
        );
      },
      here,
    );

    // Resolution N+1 of the same name. The stale request names the right
    // component and belongs to an import that is over.
    const { resolution, claimed } = resolving(
      imports,
      "Open",
      (resolution) => {
        expect(refusalOf(() => stale?.claim(fresh, OPEN))).toBeInstanceOf(AnswerIdentityError);
        // The same installation is asked again and answers this resolution: the
        // installation is reusable, the request is not.
        return {
          resolution,
          claimed: asking(
            provider,
            "Open",
            (request) => {
              requests.push(request);
              return request.claim(answer(), OPEN);
            },
            here,
          ),
        };
      },
      here,
    );

    expect(requests).toHaveLength(2);
    expect(requests[0]).not.toBe(requests[1]);
    expect(imports.identify(resolution, fresh)).toBe(undefined);
    expect(imports.identify(resolution, claimed)?.identity).toEqual(IDENTITY);
  });

  it("CIV25: a stale request cannot retag while another name is being decided", function* () {
    const here = yield* useScope();
    const imports = owner();
    const provider = imports.provider(ORIGIN);
    const substitute = answer("Other");
    let stale: ComponentAnswerRequest | undefined;

    resolving(
      imports,
      "Open",
      () => {
        asking(
          provider,
          "Open",
          (request) => {
            stale = request;
          },
          here,
        );
      },
      here,
    );

    // `claim` takes no name, so the stale request cannot even ask about the
    // name being decided: it is fixed to `Open`, which this resolution is not.
    const { resolution, claimed } = resolving(
      imports,
      "Other",
      (resolution) => {
        expect(stale?.name).toBe("Open");
        expect(refusalOf(() => stale?.claim(substitute, OTHER))).toBeInstanceOf(
          AnswerIdentityError,
        );
        return {
          resolution,
          claimed: asking(
            provider,
            "Other",
            (request) => request.claim(answer("Other"), OTHER),
            here,
          ),
        };
      },
      here,
    );

    expect(imports.identify(resolution, substitute)).toBe(undefined);
    expect(imports.identify(resolution, claimed)?.identity.key).toBe("Other");
  });

  it("CIV25: one installation answers two names through two distinct requests", function* () {
    const here = yield* useScope();
    const imports = owner();
    // One installation owns one origin and may answer more than one admitted
    // name. Spending the installation on its first answer would break exactly
    // this, so what settles is the request rather than the provider.
    const provider = imports.provider(ORIGIN);
    const seen: ComponentAnswerRequest[] = [];

    const open = resolving(
      imports,
      "Open",
      (resolution) => ({
        resolution,
        claimed: asking(
          provider,
          "Open",
          (request) => {
            seen.push(request);
            return request.claim(answer(), OPEN);
          },
          here,
        ),
      }),
      here,
    );
    const other = resolving(
      imports,
      "Other",
      (resolution) => ({
        resolution,
        claimed: asking(
          provider,
          "Other",
          (request) => {
            seen.push(request);
            return request.claim(answer("Other"), OTHER);
          },
          here,
        ),
      }),
      here,
    );

    // Two invocations, two requests, each fixed to what it was asked.
    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe(seen[1]);
    expect(seen.map((request) => request.name)).toEqual(["Open", "Other"]);
    expect(imports.identify(open.resolution, open.claimed)?.identity.key).toBe("Open");
    expect(imports.identify(other.resolution, other.claimed)?.identity.key).toBe("Other");
  });

  it("CIV25: identification takes the window it was asked about", function* () {
    const here = yield* useScope();
    const imports = owner();
    const provider = imports.provider(ORIGIN);
    const requests: ComponentAnswerRequest[] = [];

    const first = resolving(
      imports,
      "Open",
      (resolution) => ({
        resolution,
        claimed: asking(
          provider,
          "Open",
          (request) => {
            requests.push(request);
            return request.claim(answer(), OPEN);
          },
          here,
        ),
      }),
      here,
    );
    const second = resolving(
      imports,
      "Open",
      (resolution) => ({
        resolution,
        claimed: asking(
          provider,
          "Open",
          (request) => {
            requests.push(request);
            return request.claim(answer(), OPEN);
          },
          here,
        ),
      }),
      here,
    );

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
    const here = yield* useScope();
    const imports = owner();
    const provider = imports.provider(ORIGIN);
    // The engine's own object, which it reads again after any handler has seen
    // it. A provider is shown a copy, like everything else it is shown.
    const scanned = { path: "doc.md", offset: 12, line: 3, column: 5 };

    resolving(
      imports,
      "Open",
      () => {
        const asked = provider.open(here, "Open", scanned);
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
      },
      here,
    );
  });

  it("CIV23: a different object carries no claim, however alike", function* () {
    const here = yield* useScope();
    const imports = owner();
    const provider = imports.provider(ORIGIN);

    const { resolution, claimed } = resolving(
      imports,
      "Open",
      (resolution) => ({
        resolution,
        claimed: asking(provider, "Open", (request) => request.claim(answer(), OPEN), here),
      }),
      here,
    );

    expect(imports.identify(resolution, claimed)?.identity).toEqual(IDENTITY);
    // The outer-replacement case: a handler further out returns its own object,
    // so an intermediate claim does not travel with the name.
    expect(imports.identify(resolution, answer())).toBe(undefined);
    // A copy of the claimed object is a different object too.
    expect(imports.identify(resolution, { ...claimed })).toBe(undefined);
  });

  it("CIV23: editing the claimed answer invalidates the claim", function* () {
    const here = yield* useScope();
    const imports = owner();
    const provider = imports.provider(ORIGIN);

    const { resolution, claimed } = resolving(
      imports,
      "Open",
      (resolution) => ({
        resolution,
        claimed: asking(provider, "Open", (request) => request.claim(answer(), OPEN), here),
      }),
      here,
    );
    expect(imports.identify(resolution, claimed)?.identity).toEqual(IDENTITY);

    // The same object, edited after the claim by a handler further out. What
    // was claimed is no longer what is there.
    (claimed as { name: string }).name = "Substituted";

    expect(imports.identify(resolution, claimed)).toBe(undefined);
  });

  it("CIV25: an installation retained past its execution opens nothing", function* () {
    const here = yield* useScope();
    const imports = owner();
    const provider = imports.provider(ORIGIN);
    const { resolution, before } = resolving(
      imports,
      "Open",
      (resolution) => ({
        resolution,
        before: asking(provider, "Open", (request) => request.claim(answer(), OPEN), here),
      }),
      here,
    );
    expect(imports.identify(resolution, before)?.identity).toEqual(IDENTITY);

    imports.revoke();

    // The installation is the object a provider kept. The window it would need
    // cannot be opened, and a request minted from it states nothing.
    expect(refusalOf(() => imports.beginResolution("Open", here))).toBeInstanceOf(
      AnswerIdentityError,
    );
    expect(
      refusalOf(() => asking(provider, "Open", (request) => request.claim(answer(), OPEN), here)),
    ).toBeInstanceOf(AnswerIdentityError);
    // And what it stated while the execution was live identifies nothing now:
    // an admission may not be reconciled against a run that is over.
    expect(imports.identify(resolution, before)).toBe(undefined);
    expect(imports.identifying).toBe(false);
  });

  it("CIV25: an owner starts inactive, so a claim before activation refuses", function* () {
    const here = yield* useScope();
    const imports = new CanonicalImports();
    // Canonical execution registers teardown, then activates, then installs
    // providers. A claim that landed before activation would be a claim with no
    // teardown behind it.
    expect(imports.identifying).toBe(false);
    expect(refusalOf(() => imports.beginResolution("Open", here))).toBeInstanceOf(
      AnswerIdentityError,
    );
    expect(
      refusalOf(() =>
        asking(imports.provider(ORIGIN), "Open", (request) => request.claim(answer(), OPEN), here),
      ),
    ).toBeInstanceOf(AnswerIdentityError);
  });

  it("CIV25: overlapping executions are isolated", function* () {
    const here = yield* useScope();
    const first = owner();
    const second = owner();
    const shared = answer();

    const one = resolving(
      first,
      "Open",
      (resolution) => {
        asking(first.provider(ORIGIN), "Open", (request) => request.claim(shared, OPEN), here);
        return resolution;
      },
      here,
    );
    // Live at the same time, and each answers only for what it recorded.
    const two = resolving(
      second,
      "Open",
      (resolution) => {
        expect(second.identify(resolution, shared)).toBe(undefined);
        asking(
          second.provider(ORIGIN),
          "Open",
          (request) => request.claim(shared, { key: "Open", revision: "2" }),
          here,
        );
        return resolution;
      },
      here,
    );

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
    const here = yield* useScope();
    const imports = owner();
    // The installation carries the origin; the provider states only key and
    // revision. There is no member on the claim call to put another origin in.
    const { resolution, claimed } = resolving(
      imports,
      "Open",
      (resolution) => ({
        resolution,
        claimed: asking(
          imports.provider("test://assigned"),
          "Open",
          (request) => request.claim(answer(), OPEN),
          here,
        ),
      }),
      here,
    );

    expect(imports.identify(resolution, claimed)?.identity.origin).toBe("test://assigned");
  });

  it("CIV23: a partial identity is refused rather than recorded", function* () {
    const here = yield* useScope();
    const imports = owner();
    const provider = imports.provider(ORIGIN);
    const attempts = [
      { key: "", revision: "1" },
      { key: "Open", revision: "" },
    ];

    for (const attempt of attempts) {
      const supplied = answer();
      const resolution = resolving(
        imports,
        "Open",
        (resolution) => {
          asking(
            provider,
            "Open",
            (request) => {
              expect(refusalOf(() => request.claim(supplied, attempt))).toBeInstanceOf(
                AnswerIdentityError,
              );
            },
            here,
          );
          return resolution;
        },
        here,
      );
      // Refused rather than partially recorded: a half identity would compare
      // equal to a different half identity.
      expect(imports.identify(resolution, supplied)).toBe(undefined);
    }
  });

  it("CIV23: an answer nobody claimed identifies nothing", function* () {
    const here = yield* useScope();
    const imports = owner();
    // The ordinary case, and the reason this is not a permission: an unidentified
    // answer is a perfectly good answer. What it cannot be is the thing a
    // fragment runs, because a continuation would have nothing to compare.
    resolving(
      imports,
      "Open",
      (resolution) => {
        expect(imports.identify(resolution, answer())).toBe(undefined);
        expect(imports.identify(resolution, undefined)).toBe(undefined);
        expect(imports.identify(resolution, null)).toBe(undefined);
        expect(imports.identify(resolution, "Open")).toBe(undefined);
      },
      here,
    );
  });
});

/**
 * Tier PA10b — two sibling spawns resolving at the same time.
 *
 * `<All>` lets two `<Spawn>` children have an import open together, so a
 * resolution is no longer the only one in flight. What makes an answer this
 * import's is the exact window it was asked in, and windows now belong to the
 * engine scope that opened them — so these rows are written with two real
 * scopes standing for two spawns, and never with one spawn's bookkeeping
 * standing in for the other's.
 */
describe("Tier PA10b — concurrent resolution windows", () => {
  it("PA10b: one installation answers two windows open at the same time", function* () {
    const imports = owner();
    const provider = imports.provider(ORIGIN);
    const meet = rendezvous(2);
    const answers = new Map<string, ImportedDefinition>();

    /**
     * One spawned child, resolving in a scope of its own.
     *
     * Everything the spawn owns is opened and settled inside this operation:
     * it reads its own scope here, keeps its window and its request for as long
     * as the operation lasts, and hands nothing but its answer back. The two
     * run together under `all`, held at a rendezvous so neither can finish
     * before the other has opened — which is what makes two windows genuinely
     * open at once rather than one after the other.
     */
    const resolve = (name: string) =>
      scoped(function* (): Operation<void> {
        const here = yield* useScope();
        const window = imports.beginResolution("Open", here);
        try {
          // Both windows are open before either spawn claims, which is the
          // shape two `<Spawn>` children produce and the only arrangement in
          // which a claim could land in the wrong one.
          yield* meet("both open");
          answers.set(
            name,
            asking(provider, "Open", (request) => request.claim(answer(), OPEN), here),
          );
          yield* meet("claimed");
          // Both spawns have answered and both windows are still open, so
          // the cross-checks are made while the other one really exists.
          const mine = answers.get(name)!;
          const other = answers.get(name === "left" ? "right" : "left")!;
          expect(imports.identify(window, mine)?.identity).toEqual(IDENTITY);
          expect(imports.identify(window, other)).toBe(undefined);
          yield* meet("checked");
        } finally {
          window.close();
        }
      });

    yield* all([resolve("left"), resolve("right")]);
    // Two distinct answers, neither overwritten by the other's claim.
    expect(answers.size).toBe(2);
    expect(answers.get("left")).not.toBe(answers.get("right"));
  });

  it("PA10b: a request answers its own spawn and refuses the sibling's", function* () {
    const imports = owner();
    const provider = imports.provider(ORIGIN);
    const meet = rendezvous(2);

    const mine = scoped(function* (): Operation<void> {
      const here = yield* useScope();
      const window = imports.beginResolution("Open", here);
      try {
        const kept = provider.open(here, "Open");
        // Held open while the sibling's window is the last one opened anywhere.
        // Being the most recent window in the execution is not being the window
        // this handler was asked in.
        yield* meet("both open");
        expect(imports.identify(window, kept.request.claim(answer(), OPEN))?.identity).toEqual(
          IDENTITY,
        );
        kept.close();
        // And once closed it answers nothing at all.
        expect(refusalOf(() => kept.request.claim(answer(), OPEN))).toBeInstanceOf(
          AnswerIdentityError,
        );
        yield* meet("done");
      } finally {
        window.close();
      }
    });

    const sibling = scoped(function* (): Operation<void> {
      const here = yield* useScope();
      const window = imports.beginResolution("Open", here);
      try {
        yield* meet("both open");
        yield* meet("done");
      } finally {
        window.close();
      }
    });

    yield* all([mine, sibling]);
  });

  it("PA10b: a second different answer in one window refuses, whatever the sibling did", function* () {
    const imports = owner();
    const provider = imports.provider(ORIGIN);
    const meet = rendezvous(2);
    const refused: unknown[] = [];

    const first = scoped(function* (): Operation<void> {
      const here = yield* useScope();
      const window = imports.beginResolution("Open", here);
      try {
        asking(provider, "Open", (request) => request.claim(answer(), OPEN), here);
        // The sibling answers in between, which is what an installation that
        // remembered only its most recent window would treat as un-spending
        // this one.
        yield* meet("answered once");
        yield* meet("sibling answered");
        refused.push(
          refusalOf(() =>
            asking(provider, "Open", (request) => request.claim(answer(), OPEN), here),
          ),
        );
      } finally {
        window.close();
      }
    });

    const other = scoped(function* (): Operation<void> {
      const here = yield* useScope();
      const window = imports.beginResolution("Open", here);
      try {
        yield* meet("answered once");
        asking(provider, "Open", (request) => request.claim(answer(), OPEN), here);
        yield* meet("sibling answered");
      } finally {
        window.close();
      }
    });

    yield* all([first, other]);
    expect(refused).toHaveLength(1);
    expect(refused[0]).toBeInstanceOf(AnswerIdentityError);
  });

  it("PA10b: one spawn ending leaves the other live, and teardown leaves neither", function* () {
    const imports = owner();
    const provider = imports.provider(ORIGIN);
    const meet = rendezvous(2);
    const identified: unknown[] = [];

    // This spawn simply ends, which is what a spawned child answering, failing
    // or being cancelled looks like from the owner's side: its scope goes, and
    // with it every window it had open.
    const ending = scoped(function* (): Operation<void> {
      const here = yield* useScope();
      const window = imports.beginResolution("Open", here);
      try {
        yield* meet("both open");
      } finally {
        window.close();
      }
    });

    const continuing = scoped(function* (): Operation<void> {
      const here = yield* useScope();
      const window = imports.beginResolution("Open", here);
      try {
        yield* meet("both open");
        yield* meet("the other ended");
        // Still deciding, and still claimable: the spawn that ended neither
        // cleared this window nor authorized anything in it.
        const still = asking(provider, "Open", (request) => request.claim(answer(), OPEN), here);
        identified.push(imports.identify(window, still)?.identity);
      } finally {
        window.close();
      }
    });

    yield* all([
      (function* (): Operation<void> {
        yield* ending;
        yield* meet("the other ended");
      })(),
      continuing,
    ]);
    expect(identified).toEqual([IDENTITY]);

    // And once the owner is torn down nothing may be resolved at all, in any
    // scope — asked inside an operation that owns the scope it asks with.
    yield* scoped(function* () {
      const here = yield* useScope();
      imports.revoke();
      expect(refusalOf(() => imports.beginResolution("Open", here))).toBeInstanceOf(
        AnswerIdentityError,
      );
    });
  });

  it("PA10b: a nested resolution owns the top of its own spawn until it closes", function* () {
    const imports = owner();
    const provider = imports.provider(ORIGIN);

    yield* scoped(function* () {
      const here = yield* useScope();
      const outer = imports.beginResolution("Open", here);
      const held = provider.open(here, "Open");
      // The nested resolution is for the *same* name, which is the case a check
      // written against the name rather than the exact window would admit.
      const inner = imports.beginResolution("Open", here);
      // The inner resolution hides its parent: a request minted for the outer
      // one states nothing while something nested is deciding.
      expect(refusalOf(() => held.request.claim(answer(), OPEN))).toBeInstanceOf(
        AnswerIdentityError,
      );
      inner.close();
      // And the parent is claimable again once the nested one is over.
      const supplied = held.request.claim(answer(), OPEN);
      expect(imports.identify(outer, supplied)?.identity).toEqual(IDENTITY);
      held.close();
      outer.close();
    });
  });
});

/**
 * Tier PA10c — one reusable provider, one definition, several imports.
 *
 * A provider that holds an immutable definition hands back the exact same object
 * every time it answers. What that object *is* was settled once; which import it
 * answered is settled per resolution. These rows use one shared reference,
 * created once, so a ledger that made the first window part of the object's
 * permanent claim refuses the second — which is the defect they exist to catch.
 */
describe("Tier PA10c — one definition answering more than one import", () => {
  it("PA10c: the same definition answers a later import after the first window closed", function* () {
    const imports = owner();
    const provider = imports.provider(ORIGIN);
    const here = yield* useScope();
    // One object, created once and never copied: this is what a provider that
    // owns its definition hands to everybody who asks.
    const shared = answer();

    const first = resolving(
      imports,
      "Open",
      (resolution) => {
        const supplied = asking(provider, "Open", (request) => request.claim(shared, OPEN), here);
        expect(supplied).toBe(shared);
        expect(imports.identify(resolution, shared)?.identity).toEqual(IDENTITY);
        return resolution;
      },
      here,
    );

    // The second import is a new resolution of the same name, after the first is
    // over. The definition is the same object, and it is still this provider's
    // answer to say.
    resolvingLater(imports, provider, here, shared);
    // And the closed window still reads the claim it recorded, unchanged by the
    // later one: each resolution keeps its own.
    expect(imports.identify(first, shared)?.identity).toEqual(IDENTITY);
  });

  it("PA10c: an edited definition cannot be claimed again, and identifies nowhere", function* () {
    const imports = owner();
    const provider = imports.provider(ORIGIN);
    const here = yield* useScope();
    const shared = answer();

    const first = resolving(
      imports,
      "Open",
      (resolution) => {
        asking(provider, "Open", (request) => request.claim(shared, OPEN), here);
        expect(imports.identify(resolution, shared)?.identity).toEqual(IDENTITY);
        return resolution;
      },
      here,
    );

    // One member of the definition, edited after it was claimed and while the
    // stated identity says nothing changed. This is a different implementation
    // wearing the first one's revision.
    shared.props = { type: "object", properties: {}, additionalProperties: true };

    resolving(
      imports,
      "Open",
      (resolution) => {
        asking(
          provider,
          "Open",
          (request) => {
            // Refused before anything is recorded: the identity was stated about
            // the definition core retained, and this object is no longer it.
            expect(refusalOf(() => request.claim(shared, OPEN))).toBeInstanceOf(
              AnswerIdentityError,
            );
            return undefined;
          },
          here,
        );
        // So the new window vouches for nothing.
        expect(imports.identify(resolution, shared)).toBe(undefined);
      },
      here,
    );
    // And the window that did claim it cannot identify the changed object
    // either, which is the change detection that was already there.
    expect(imports.identify(first, shared)).toBe(undefined);
  });

  it("PA10c: the same definition answers two imports open at the same time", function* () {
    const imports = owner();
    const provider = imports.provider(ORIGIN);
    const meet = rendezvous(2);
    const shared = answer();
    const identified = new Map<string, AnswerIdentity | undefined>();

    /** One spawned child's import, opened and settled inside its own operation. */
    const resolve = (name: string) =>
      scoped(function* (): Operation<void> {
        const here = yield* useScope();
        const window = imports.beginResolution("Open", here);
        try {
          // Both windows are open before either claims, so neither claim can be
          // the other's: this is the arrangement sibling spawns produce.
          yield* meet("both open");
          const supplied = asking(provider, "Open", (request) => request.claim(shared, OPEN), here);
          // The provider handed back its own object, not a copy of it.
          expect(supplied).toBe(shared);
          yield* meet("claimed");
          // Read while the sibling's window is still open, which is the only
          // arrangement in which a shared ledger entry could answer for the
          // wrong import.
          identified.set(name, imports.identify(window, shared)?.identity);
          yield* meet("checked");
        } finally {
          window.close();
        }
      });

    yield* all([resolve("left"), resolve("right")]);
    expect(identified.get("left")).toEqual(IDENTITY);
    expect(identified.get("right")).toEqual(IDENTITY);
  });

  it("PA10c: reuse spends each window, so a different answer in one still refuses", function* () {
    const imports = owner();
    const provider = imports.provider(ORIGIN);
    const here = yield* useScope();
    const shared = answer();

    resolvingLater(imports, provider, here, shared);
    // The same definition again in a fresh window is reuse; a *second* answer in
    // that same window is two answers to one import, and that still refuses.
    resolving(
      imports,
      "Open",
      (resolution) => {
        asking(
          provider,
          "Open",
          (request) => {
            expect(request.claim(shared, OPEN)).toBe(shared);
            expect(refusalOf(() => request.claim(answer(), OPEN))).toBeInstanceOf(
              AnswerIdentityError,
            );
            return undefined;
          },
          here,
        );
        expect(imports.identify(resolution, shared)?.identity).toEqual(IDENTITY);
      },
      here,
    );
  });

  it("PA10c: a new window cannot rename the definition or take it for another provider", function* () {
    const imports = owner();
    const provider = imports.provider(ORIGIN);
    const other = imports.provider("test://other");
    const here = yield* useScope();
    const shared = answer();

    resolvingLater(imports, provider, here, shared);
    // What this object is was settled by its first claim. A new resolution is a
    // new question about which import it answered, never a chance to restate it.
    resolving(
      imports,
      "Other",
      (resolution) => {
        asking(
          provider,
          "Other",
          (request) => {
            expect(refusalOf(() => request.claim(shared, OTHER))).toBeInstanceOf(
              AnswerIdentityError,
            );
            return undefined;
          },
          here,
        );
        expect(imports.identify(resolution, shared)).toBe(undefined);
      },
      here,
    );
    resolving(
      imports,
      "Open",
      (resolution) => {
        asking(
          other,
          "Open",
          (request) => {
            expect(refusalOf(() => request.claim(shared, OPEN))).toBeInstanceOf(
              AnswerIdentityError,
            );
            return undefined;
          },
          here,
        );
        expect(imports.identify(resolution, shared)).toBe(undefined);
      },
      here,
    );
  });
});

/**
 * Claim one shared definition in a resolution of its own, and read it back.
 *
 * Written once because three rows need the same second import: a fresh window,
 * the same object, and the same provider saying the same thing about it. All of
 * it is synchronous bookkeeping, so it is a plain function — there is nothing
 * here for an operation to wait on.
 */
function resolvingLater(
  imports: CanonicalImports,
  provider: ProviderInstallation,
  scope: Scope,
  shared: ImportedDefinition,
): void {
  resolving(
    imports,
    "Open",
    (resolution) => {
      const supplied = asking(provider, "Open", (request) => request.claim(shared, OPEN), scope);
      expect(supplied).toBe(shared);
      expect(imports.identify(resolution, shared)?.identity).toEqual(IDENTITY);
    },
    scope,
  );
}
