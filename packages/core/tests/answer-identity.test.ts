/**
 * Tier CIV — what a published answer is bound to, and when it stops meaning
 * anything.
 *
 * A generated fragment's admission is a decision about which implementation may
 * run. A function carries no identity a run can retain — comparing one compares
 * how somebody wrote their code — so a provider publishes the definition, and
 * what each of its forms runs as is declared on it. Everything here is about
 * the ways a publication could be weaker than it looks: outliving the execution
 * that minted it, outliving the *invocation* that made it, surviving the answer
 * being replaced or edited, or being overwritten by a second provider.
 *
 * The shape under test is the split between two separate rights. A provider
 * installation is the right to be asked, and it is deliberately reusable: one
 * installation answers several admitted names and the same name resolved more
 * than once. A request is the right to answer one asking, and it is closed the
 * moment that handler invocation ends. Only a request publishes, which is what
 * makes a publication provable — an installation handle can prove "some
 * provider this host installed" and nothing about which invocation is speaking.
 *
 * The rows read what `identify()` answers rather than what a refusal says: a
 * publication that reported correctly while still vouching for a substituted
 * object would satisfy an error-shape assertion and none of these.
 *
 * The owner is `CanonicalImports`, which already holds issuance and retention.
 * One owner asks one question about one table; a second registry would be a
 * second place an answer could be authorized from.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { scoped } from "effection";
import type { Operation } from "effection";

import { AnswerIdentityError, CanonicalImports } from "../src/components/component-resolution.ts";
import type {
  ComponentAnswerRequest,
  ImportedDefinition,
  ProviderInstallation,
  ResolutionWindow,
} from "../src/components/component-resolution.ts";
import type { GeneratedForms } from "../src/components/generated-metadata.ts";
import type { FunctionComponentDefinition, Json } from "../src/types.ts";

const ORIGIN = "test://provider";
/** What this provider's definition offers its self-closing form as. */
const OFFERED: GeneratedForms = {
  "self-closing": { identity: "https://executable.md/components/open/read", effect: "read" },
};

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

/**
 * One answer a provider might return, fresh each time.
 *
 * It carries the generated metadata a provider's own declaration states, since
 * that is what a publication is now a statement about: the identity and effect
 * of each form travel on the definition rather than beside it.
 */
function answer(name = "Open"): ImportedDefinition {
  return { ...bare(name), generated: OFFERED };
}

/** One answer offering no generated use of itself, which is the ordinary case. */
function bare(name = "Open"): FunctionComponentDefinition {
  return {
    kind: "function",
    name,
    props: { type: "object", properties: {}, additionalProperties: false },
    forms: ["self-closing"],
    // deno-lint-ignore require-yield
    *fn(): Operation<Json> {
      return "";
    },
  };
}

/**
 * One answer carrying metadata this engine may not be able to read.
 *
 * Assembled rather than declared, because the point of each of these is that a
 * provider's definition crossed a package boundary carrying something the
 * declared shape does not describe.
 */
function answerWith(generated: unknown): ImportedDefinition {
  return Object.assign(bare(), { generated });
}

/** The generated identity on a saved definition, whichever arm it is. */
function offeredIdentity(definition: ImportedDefinition | undefined): unknown {
  const generated = definition === undefined ? undefined : Reflect.get(definition, "generated");
  if (typeof generated !== "object" || generated === null) {
    return undefined;
  }
  const form = Reflect.get(generated, "self-closing");
  return typeof form === "object" && form !== null ? Reflect.get(form, "identity") : undefined;
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

describe("Tier CIV — a publication belongs to one answer of one import", () => {
  it("CIV23: a definition is published on the exact answer and read back", function* () {
    const imports = owner();
    const provider = imports.provider(ORIGIN);

    const { resolution, supplied } = resolving(imports, "Open", (resolution) => ({
      resolution,
      supplied: asking(provider, "Open", (request) => request.answer(answer())),
    }));

    const identified = imports.identify(resolution, supplied);
    // The publishing installation's origin, which is provenance and nothing
    // else: what the implementation *is* comes back on the definition, as the
    // identity its own declaration offers that form under.
    expect(identified?.origin).toBe(ORIGIN);
    expect(offeredIdentity(identified?.definition)).toBe(
      "https://executable.md/components/open/read",
    );
  });

  it("CIV24: identification answers with the publication-time copy, not the answer", function* () {
    const imports = owner();
    const provider = imports.provider(ORIGIN);
    const supplied = answer();

    const resolution = resolving(imports, "Open", (resolution) => {
      asking(provider, "Open", (request) => request.answer(supplied));
      return resolution;
    });

    // One call answers both halves. The definition is core's own copy, taken
    // when it was published — so a caller that keeps what identification
    // gave it has kept the object the check was made about, and never has to
    // read the chain's object a second time to obtain one.
    const identified = imports.identify(resolution, supplied);
    expect(identified?.origin).toBe(ORIGIN);
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
    // between what was published and a substitution; comparing descriptors,
    // which is how a publication is checked, does not run this at all. So a
    // caller that
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
      asking(provider, "Open", (request) => request.answer(alternating));
      return resolution;
    });
    const identified = imports.identify(resolution, alternating);

    // The publication itself was recorded from the first reading, and
    // identification answers with that recording.
    expect(identified?.origin).toBe(ORIGIN);
    expect(identified?.definition.name).toBe("Open");
    // The plant is live rather than inert: the very next read of the object the
    // chain returned says something else, which is what a second read would
    // have kept.
    expect((alternating as { name: string }).name).toBe("Substituted");
    expect(identified?.definition.name).toBe("Open");
  });

  it("CIV23: publishing exactly the same definition again is idempotent", function* () {
    const imports = owner();
    const provider = imports.provider(ORIGIN);
    const supplied = answer();

    const resolution = resolving(imports, "Open", (resolution) => {
      asking(provider, "Open", (request) => {
        request.answer(supplied);
        // A provider installed twice publishes the same thing twice. That is
        // not two providers disagreeing, and it is not a conflict.
        expect(refusalOf(() => request.answer(supplied))).toBe(undefined);
      });
      return resolution;
    });
    expect(imports.identify(resolution, supplied)?.origin).toBe(ORIGIN);
  });

  it("CIV23: a competing publication refuses and never overwrites the first", function* () {
    const imports = owner();
    const first = imports.provider(ORIGIN);
    const second = imports.provider("test://other");
    const held = answer();

    const resolution = resolving(imports, "Open", (resolution) => {
      asking(first, "Open", (request) => request.answer(held));
      // Another installation, asked in the same live resolution, cannot take
      // what the first published. An overwrite would let a second provider take
      // the first's implementation.
      asking(second, "Open", (request) => {
        expect(refusalOf(() => request.answer(held))).toBeInstanceOf(AnswerIdentityError);
      });
      // And the first installation's *next* invocation cannot publish a
      // different implementation for a resolution it has already answered.
      asking(first, "Open", (request) => {
        expect(refusalOf(() => request.answer(answer()))).toBeInstanceOf(AnswerIdentityError);
      });
      return resolution;
    });

    expect(imports.identify(resolution, held)?.origin).toBe(ORIGIN);
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
      expect(refusalOf(() => stale?.answer(late))).toBeInstanceOf(AnswerIdentityError);
      // The positive control in the same still-open window: a fresh invocation
      // of the same installation publishes, so the refusal above is about the
      // handler lease rather than about the window or the provider.
      asking(provider, "Open", (request) => request.answer(answer()));
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
    const { resolution, published } = resolving(imports, "Open", (resolution) => {
      expect(refusalOf(() => stale?.answer(fresh))).toBeInstanceOf(AnswerIdentityError);
      // The same installation is asked again and answers this resolution: the
      // installation is reusable, the request is not.
      return {
        resolution,
        published: asking(provider, "Open", (request) => {
          requests.push(request);
          return request.answer(answer());
        }),
      };
    });

    expect(requests).toHaveLength(2);
    expect(requests[0]).not.toBe(requests[1]);
    expect(imports.identify(resolution, fresh)).toBe(undefined);
    expect(imports.identify(resolution, published)?.origin).toBe(ORIGIN);
  });

  it("CIV25: a stale request cannot publish while another name is being decided", function* () {
    const imports = owner();
    const provider = imports.provider(ORIGIN);
    const substitute = answer("Other");
    let stale: ComponentAnswerRequest | undefined;

    resolving(imports, "Open", () => {
      asking(provider, "Open", (request) => {
        stale = request;
      });
    });

    // `answer` takes no name, so the stale request cannot even ask about the
    // name being decided: it is fixed to `Open`, which this resolution is not.
    const { resolution, published } = resolving(imports, "Other", (resolution) => {
      expect(stale?.name).toBe("Open");
      expect(refusalOf(() => stale?.answer(substitute))).toBeInstanceOf(AnswerIdentityError);
      return {
        resolution,
        published: asking(provider, "Other", (request) => request.answer(answer("Other"))),
      };
    });

    expect(imports.identify(resolution, substitute)).toBe(undefined);
    expect(imports.identify(resolution, published)?.definition.name).toBe("Other");
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
      published: asking(provider, "Open", (request) => {
        seen.push(request);
        return request.answer(answer());
      }),
    }));
    const other = resolving(imports, "Other", (resolution) => ({
      resolution,
      published: asking(provider, "Other", (request) => {
        seen.push(request);
        return request.answer(answer("Other"));
      }),
    }));

    // Two invocations, two requests, each fixed to what it was asked.
    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe(seen[1]);
    expect(seen.map((request) => request.name)).toEqual(["Open", "Other"]);
    expect(imports.identify(open.resolution, open.published)?.definition.name).toBe("Open");
    expect(imports.identify(other.resolution, other.published)?.definition.name).toBe("Other");
  });

  it("CIV25: identification takes the window it was asked about", function* () {
    const imports = owner();
    const provider = imports.provider(ORIGIN);
    const requests: ComponentAnswerRequest[] = [];

    const first = resolving(imports, "Open", (resolution) => ({
      resolution,
      published: asking(provider, "Open", (request) => {
        requests.push(request);
        return request.answer(answer());
      }),
    }));
    const second = resolving(imports, "Open", (resolution) => ({
      resolution,
      published: asking(provider, "Open", (request) => {
        requests.push(request);
        return request.answer(answer());
      }),
    }));

    // Each answer belongs to the import it answered, and to no other. Nothing
    // here reads whichever window is current: the caller presents the one it
    // opened, which is why the answer does not change with when it is asked.
    expect(requests).toHaveLength(2);
    expect(requests[0]).not.toBe(requests[1]);
    expect(imports.identify(first.resolution, first.published)?.origin).toBe(ORIGIN);
    expect(imports.identify(second.resolution, second.published)?.origin).toBe(ORIGIN);
    expect(imports.identify(first.resolution, second.published)).toBe(undefined);
    expect(imports.identify(second.resolution, first.published)).toBe(undefined);
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

  it("CIV23: a different object carries no publication, however alike", function* () {
    const imports = owner();
    const provider = imports.provider(ORIGIN);

    const { resolution, published } = resolving(imports, "Open", (resolution) => ({
      resolution,
      published: asking(provider, "Open", (request) => request.answer(answer())),
    }));

    expect(imports.identify(resolution, published)?.origin).toBe(ORIGIN);
    // The outer-replacement case: a handler further out returns its own object,
    // so an intermediate publication does not travel with the name.
    expect(imports.identify(resolution, answer())).toBe(undefined);
    // A copy of the published object is a different object too, and copying the
    // generated metadata with it changes nothing.
    expect(imports.identify(resolution, { ...published })).toBe(undefined);
  });

  it("CIV23: editing the published answer invalidates the publication", function* () {
    const imports = owner();
    const provider = imports.provider(ORIGIN);

    const { resolution, published } = resolving(imports, "Open", (resolution) => ({
      resolution,
      published: asking(provider, "Open", (request) => request.answer(answer())),
    }));
    expect(imports.identify(resolution, published)?.origin).toBe(ORIGIN);

    // The same object, edited after publication by a handler further out. What
    // was published is no longer what is there.
    (published as { name: string }).name = "Substituted";

    expect(imports.identify(resolution, published)).toBe(undefined);
  });

  it("CIV25: an installation saved past its execution opens nothing", function* () {
    const imports = owner();
    const provider = imports.provider(ORIGIN);
    const { resolution, before } = resolving(imports, "Open", (resolution) => ({
      resolution,
      before: asking(provider, "Open", (request) => request.answer(answer())),
    }));
    expect(imports.identify(resolution, before)?.origin).toBe(ORIGIN);

    imports.revoke();

    // The installation is the object a provider kept. The window it would need
    // cannot be opened, and a request minted from it publishes nothing.
    expect(refusalOf(() => imports.beginResolution("Open"))).toBeInstanceOf(AnswerIdentityError);
    expect(
      refusalOf(() => asking(provider, "Open", (request) => request.answer(answer()))),
    ).toBeInstanceOf(AnswerIdentityError);
    // And what it published while the execution was live identifies nothing now:
    // an admission may not be reconciled against a run that is over.
    expect(imports.identify(resolution, before)).toBe(undefined);
    expect(imports.identifying).toBe(false);
  });

  it("CIV25: an owner starts inactive, so a publication before activation refuses", function* () {
    const imports = new CanonicalImports();
    // Canonical execution registers teardown, then activates, then installs
    // providers. A publication that landed before activation would be one with
    // no teardown behind it.
    expect(imports.identifying).toBe(false);
    expect(refusalOf(() => imports.beginResolution("Open"))).toBeInstanceOf(AnswerIdentityError);
    expect(
      refusalOf(() =>
        asking(imports.provider(ORIGIN), "Open", (request) => request.answer(answer())),
      ),
    ).toBeInstanceOf(AnswerIdentityError);
  });

  it("CIV25: overlapping executions are isolated", function* () {
    const first = owner();
    const second = owner();
    const shared = answer();

    const one = resolving(first, "Open", (resolution) => {
      asking(first.provider(ORIGIN), "Open", (request) => request.answer(shared));
      return resolution;
    });
    // Live at the same time, and each answers only for what it recorded.
    const two = resolving(second, "Open", (resolution) => {
      expect(second.identify(resolution, shared)).toBe(undefined);
      asking(second.provider("test://other"), "Open", (request) => request.answer(shared));
      return resolution;
    });

    // One definition, published separately in each owner, and each owner
    // answers with the provenance of the installation that published it there.
    expect(first.identify(one, shared)?.origin).toBe(ORIGIN);
    expect(second.identify(two, shared)?.origin).toBe("test://other");

    // The positive control: tearing one down leaves the other working.
    first.revoke();
    expect(first.identify(one, shared)).toBe(undefined);
    expect(second.identify(two, shared)?.origin).toBe("test://other");
  });

  it("CIV23: a provider cannot state an origin canonical execution did not give it", function* () {
    const imports = owner();
    // The installation carries the origin, and `answer` takes the definition
    // and nothing else. There is no member on the call to put another origin
    // in, and the provenance identification reports is the one this execution
    // assigned.
    const { resolution, published } = resolving(imports, "Open", (resolution) => ({
      resolution,
      published: asking(imports.provider("test://assigned"), "Open", (request) =>
        request.answer(answer()),
      ),
    }));

    expect(imports.identify(resolution, published)?.origin).toBe("test://assigned");
  });

  it("CIV23: metadata this engine cannot read is refused rather than recorded", function* () {
    const imports = owner();
    const provider = imports.provider(ORIGIN);
    // A provider's definition never passed registration, so its generated
    // metadata is read here or nowhere. Each of these is a form offered under
    // something a continuation could not be compared against.
    const attempts: unknown[] = [
      { "self-closing": { identity: "components/open/read", effect: "read" } },
      { "self-closing": { identity: "https://executable.md.example.com/open", effect: "read" } },
      { "self-closing": { identity: "https://executable.md/components/open/read", effect: "ask" } },
      { paired: { identity: "https://executable.md/components/open/write", effect: "write" } },
    ];

    for (const generated of attempts) {
      const supplied = answerWith(generated);
      const resolution = resolving(imports, "Open", (resolution) => {
        asking(provider, "Open", (request) => {
          expect(refusalOf(() => request.answer(supplied))).toBeInstanceOf(AnswerIdentityError);
        });
        return resolution;
      });
      // Refused rather than partially recorded: metadata read in part would
      // admit a form under an identity nobody declared.
      expect(imports.identify(resolution, supplied)).toBe(undefined);
    }
  });

  it("CIV23: a definition whose stated forms are not a declaration refuses", function* () {
    const imports = owner();
    const provider = imports.provider(ORIGIN);
    // The forms a definition states are read the way its metadata is, and only
    // genuine omission means both: a value that is not a canonical declaration
    // cannot be read as one by dropping what it says, because the offered
    // spelling is checked against it.
    for (const forms of ["paired", ["self-closing", "unknown"], []]) {
      const supplied = Object.assign(bare(), { generated: OFFERED, forms });
      const resolution = resolving(imports, "Open", (resolution) => {
        asking(provider, "Open", (request) => {
          expect(refusalOf(() => request.answer(supplied))).toBeInstanceOf(AnswerIdentityError);
        });
        return resolution;
      });
      expect([forms, imports.identify(resolution, supplied)]).toEqual([forms, undefined]);
    }
  });

  it("CIV23: an answer carrying no metadata is published and read back", function* () {
    const imports = owner();
    const provider = imports.provider(ORIGIN);
    // The ordinary authored case: a provider answering an import that is not a
    // generated admission offers no generated form, and publishing it is still
    // a perfectly good answer. What it cannot do is satisfy an admitted entry,
    // which refuses the missing form where the table is sealed.
    const { resolution, supplied } = resolving(imports, "Open", (resolution) => ({
      resolution,
      supplied: asking(provider, "Open", (request) => request.answer(bare())),
    }));

    expect(imports.identify(resolution, supplied)?.origin).toBe(ORIGIN);
    expect(offeredIdentity(imports.identify(resolution, supplied)?.definition)).toBe(undefined);
  });

  it("CIV23: an answer nobody published identifies nothing", function* () {
    const imports = owner();
    // The ordinary case, and the reason this is not a permission: an answer
    // nobody published is a perfectly good answer. What it cannot be is the
    // thing a fragment runs, because a continuation would have nothing to
    // compare.
    resolving(imports, "Open", (resolution) => {
      expect(imports.identify(resolution, answer())).toBe(undefined);
      expect(imports.identify(resolution, undefined)).toBe(undefined);
      expect(imports.identify(resolution, null)).toBe(undefined);
      expect(imports.identify(resolution, "Open")).toBe(undefined);
    });
  });
});

/**
 * Tier PA10b — serial component-answer capture.
 *
 * Each request retains the window that was open when its handler began. A
 * descendant scope preserves that correlation, and closing the window makes
 * the saved request unable to record an answer’s identity in a later one.
 */
describe("Tier PA10b — one serial resolution window", () => {
  /**
   * Component answers are captured serially, before any document expands.
   *
   * That is the whole reason no scope takes part here: the execution asks for
   * each admitted name in turn, so there is one window at a time, and what a
   * request answers is the window object it captured when its handler was
   * opened — not whichever window is open when it records the identity, and
   * not anything about where it is running.
   */
  it("PA10b: a request answers the window it captured, not the one open later", function* () {
    const imports = owner();
    const provider = imports.provider(ORIGIN);

    const first = imports.beginResolution("Open");
    const kept = provider.open("Open");
    // The capture phase moves on: this resolution closes and the next name's
    // window opens. The request is still holding the first one.
    first.close();
    const second = imports.beginResolution("Open");
    try {
      expect(refusalOf(() => kept.request.answer(answer()))).toBeInstanceOf(AnswerIdentityError);
      // And the window that is open answers for what was published in it.
      const published = asking(provider, "Open", (request) => request.answer(answer()));
      expect(imports.identify(second, published)?.origin).toBe(ORIGIN);
    } finally {
      kept.close();
      second.close();
    }
  });

  it("PA10b: a handler that delegates through a descendant scope still identifies", function* () {
    // The request captured its window before the handler ran, so a handler that
    // does its work in a scope of its own answers the same resolution. Nothing
    // about the scope participates in the correlation.
    const imports = owner();
    const provider = imports.provider(ORIGIN);

    const window = imports.beginResolution("Open");
    try {
      const published = yield* scoped(function* (): Operation<ImportedDefinition> {
        return asking(provider, "Open", (request) => request.answer(answer()));
      });
      expect(imports.identify(window, published)?.origin).toBe(ORIGIN);
    } finally {
      window.close();
    }
  });

  it("PA10b: with no window open, a provider answers and identifies nothing", function* () {
    // Where concurrent document imports are: after capture, with no profile
    // window open at all. A handler may still answer such an import as ordinary
    // middleware; what it cannot do is acquire a profile identity for it.
    const imports = owner();
    const provider = imports.provider(ORIGIN);

    const window = imports.beginResolution("Open");
    window.close();

    expect(
      refusalOf(() => asking(provider, "Open", (request) => request.answer(answer()))),
    ).toBeInstanceOf(AnswerIdentityError);
    expect(imports.identify(window, answer())).toBe(undefined);
  });
});

describe("Tier PA10c — one definition answering more than one import", () => {
  it("PA10c: the same definition answers a later import after the first window closed", function* () {
    const imports = owner();
    const provider = imports.provider(ORIGIN);
    // One object, created once and never copied: this is what a provider that
    // owns its definition hands to everybody who asks.
    const shared = answer();

    const first = resolving(imports, "Open", (resolution) => {
      const supplied = asking(provider, "Open", (request) => request.answer(shared));
      expect(supplied).toBe(shared);
      expect(imports.identify(resolution, shared)?.origin).toBe(ORIGIN);
      return resolution;
    });

    // The second import is a new resolution of the same name, after the first is
    // over. The definition is the same object, and it is still this provider's
    // answer to say.
    resolvingLater(imports, provider, shared);
    // And the closed window still reads the publication it recorded, unchanged by the
    // later one: each resolution keeps its own.
    expect(imports.identify(first, shared)?.origin).toBe(ORIGIN);
  });

  it("PA10c: reuse cannot substitute between comparison and retention", function* () {
    const imports = owner();
    const provider = imports.provider(ORIGIN);
    const reads: string[] = [];
    const shared = new Proxy(answer(), {
      get(target, key, receiver) {
        if (key !== "name") {
          return Reflect.get(target, key, receiver);
        }
        reads.push(key);
        return reads.length === 1 ? "Open" : "Substituted";
      },
      getOwnPropertyDescriptor(target, key) {
        const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
        if (key !== "name" || descriptor === undefined || !("value" in descriptor)) {
          return descriptor;
        }
        return { ...descriptor, value: reads.length < 2 ? "Open" : "Substituted" };
      },
    });

    const first = resolving(imports, "Open", (resolution) => {
      asking(provider, "Open", (request) => request.answer(shared));
      return resolution;
    });
    expect(imports.identify(first, shared)?.definition.name).toBe("Open");
    resolving(imports, "Open", (resolution) => {
      asking(provider, "Open", (request) => {
        expect(refusalOf(() => request.answer(shared))).toBeInstanceOf(AnswerIdentityError);
        return undefined;
      });
      expect(imports.identify(resolution, shared)).toBe(undefined);
    });
  });

  it("PA10c: an edited definition cannot be published again, and identifies nowhere", function* () {
    const imports = owner();
    const provider = imports.provider(ORIGIN);
    const shared = answer();

    const first = resolving(imports, "Open", (resolution) => {
      asking(provider, "Open", (request) => request.answer(shared));
      expect(imports.identify(resolution, shared)?.origin).toBe(ORIGIN);
      return resolution;
    });

    // One member of the definition, edited after it was published. This is a
    // different implementation asking to answer under the first one's
    // publication.
    shared.props = { type: "object", properties: {}, additionalProperties: true };

    resolving(imports, "Open", (resolution) => {
      asking(provider, "Open", (request) => {
        // Refused before anything is recorded: the publication was about the
        // definition core saved, and this object is no longer it.
        expect(refusalOf(() => request.answer(shared))).toBeInstanceOf(AnswerIdentityError);
        return undefined;
      });
      // So the new window vouches for nothing.
      expect(imports.identify(resolution, shared)).toBe(undefined);
    });
    // And the window that did publish it cannot identify the changed object
    // either, which is the change detection that was already there.
    expect(imports.identify(first, shared)).toBe(undefined);
  });

  it("PA10c: one definition answers two windows in turn, and each holds its own copy", function* () {
    // Serial, because capture is: the first resolution closes before the second
    // opens. What this holds is that reuse is per window — the second window
    // identifies the same definition, and closing either leaves the other's copy
    // alone.
    const imports = owner();
    const provider = imports.provider(ORIGIN);
    const shared = answer();

    const first = imports.beginResolution("Open");
    asking(provider, "Open", (request) => request.answer(shared));
    expect(imports.identify(first, shared)?.origin).toBe(ORIGIN);
    first.close();

    const second = imports.beginResolution("Open");
    try {
      asking(provider, "Open", (request) => request.answer(shared));
      expect(imports.identify(second, shared)?.origin).toBe(ORIGIN);
      // And each window keeps its own copy: the first still identifies what it
      // published, because provenance is a fact about that resolution rather than
      // about which one is open now.
      expect(imports.identify(first, shared)?.origin).toBe(ORIGIN);
    } finally {
      second.close();
    }
  });

  it("PA10c: reuse spends each window, so a different answer in one still refuses", function* () {
    const imports = owner();
    const provider = imports.provider(ORIGIN);
    const shared = answer();

    resolvingLater(imports, provider, shared);
    // The same definition again in a fresh window is reuse; a *second* answer in
    // that same window is two answers to one import, and that still refuses.
    resolving(imports, "Open", (resolution) => {
      asking(provider, "Open", (request) => {
        expect(request.answer(shared)).toBe(shared);
        expect(refusalOf(() => request.answer(answer()))).toBeInstanceOf(AnswerIdentityError);
        return undefined;
      });
      expect(imports.identify(resolution, shared)?.origin).toBe(ORIGIN);
    });
  });

  it("PA10c: a new window cannot rename the definition or take it for another provider", function* () {
    const imports = owner();
    const provider = imports.provider(ORIGIN);
    const other = imports.provider("test://other");
    const shared = answer();

    resolvingLater(imports, provider, shared);
    // What this object answers for was settled by its first publication. A new
    // resolution is a new question about which import it answered, never a
    // chance to publish it again elsewhere.
    resolving(imports, "Other", (resolution) => {
      asking(provider, "Other", (request) => {
        expect(refusalOf(() => request.answer(shared))).toBeInstanceOf(AnswerIdentityError);
        return undefined;
      });
      expect(imports.identify(resolution, shared)).toBe(undefined);
    });
    resolving(imports, "Open", (resolution) => {
      asking(other, "Open", (request) => {
        expect(refusalOf(() => request.answer(shared))).toBeInstanceOf(AnswerIdentityError);
        return undefined;
      });
      expect(imports.identify(resolution, shared)).toBe(undefined);
    });
  });
});

/**
 * Identify one shared definition in a resolution of its own, and read it back.
 *
 * Written once because three rows need the same second import: a fresh window,
 * the same object, and the same provider saying the same thing about it. All of
 * it is synchronous bookkeeping, so it is a plain function — there is nothing
 * here for an operation to wait on.
 */
function resolvingLater(
  imports: CanonicalImports,
  provider: ProviderInstallation,
  shared: ImportedDefinition,
): void {
  resolving(imports, "Open", (resolution) => {
    const supplied = asking(provider, "Open", (request) => request.answer(shared));
    expect(supplied).toBe(shared);
    expect(imports.identify(resolution, shared)?.origin).toBe(ORIGIN);
  });
}
