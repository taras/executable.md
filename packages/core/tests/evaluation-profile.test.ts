/**
 * Tier EP — what canonical execution captures from a host's generated
 * selection.
 *
 * `<Evaluate>` is public, so any author may write it. What keeps that from
 * being a capability is that what it narrows from was offered by a trusted host
 * before a document existed — and that the execution stopped reading the host's
 * objects the moment it captured them.
 *
 * The host's half is small on purpose: component names and authored forms. The
 * contract, the identity and the effect of every selected spelling come from
 * the declaration that owns the implementation, so the rows here are about what
 * capture *derives* and what it refuses to derive, rather than about a table a
 * host wrote out.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import type { Operation } from "effection";
import { scoped, useScope } from "effection";
import { installIdentities, isFormDispatcher } from "../src/invocation-identity.ts";
import type {
  ComponentRouting,
  InvocationForm,
  ProtectedSite,
} from "../src/invocation-identity.ts";

import {
  captureEvaluationProfile,
  evaluationLifetime,
  REVOKED,
} from "../src/evaluation-profile.ts";
import { CORE_ORIGIN } from "../src/components/registry.ts";
import { SYNTAX_PROTECTED } from "../src/components/Syntax.ts";
import { props as globProps } from "../src/components/Glob.ts";
import { coreComponentDefinition } from "../src/components/registry.ts";
import { fixedFilesystemDefinition } from "../src/components/fixed-filesystem.ts";
import type {
  EvaluationProfile,
  ResolvedAnswer,
  ResolvedAnswers,
} from "../src/evaluation-profile.ts";
import type { AdmittedSelection } from "../src/generated-selection.ts";
import type { GeneratedForms } from "../src/components/generated-metadata.ts";
import type { FunctionComponentDefinition, Json } from "../src/types.ts";

describe("protected route projection", () => {
  function installation() {
    return installIdentities(
      [],
      [],
      ["Admitted", "Hidden"].map((name) => ({
        name,
        origin: "test://protected",
        props: { type: "object" },
        forms: ["self-closing" as const],
        generated: {
          "self-closing": {
            identity: `https://executable.md/components/${name.toLowerCase()}/read`,
            effect: "read" as const,
          },
        },
        build: (claim) =>
          function* (_props, invocation): Operation<string> {
            return `${name}:${yield* claim(invocation)}`;
          },
      })),
    );
  }

  function invoke(route: ComponentRouting, fn: unknown): Operation<unknown> {
    return scoped(function* () {
      const body = route.body(fn);
      const issued = route.issue(fn, "occurrence", "Admitted", yield* useScope(), false);
      if (body === undefined || issued === undefined) {
        return "unrouted";
      }
      try {
        const site: ProtectedSite = {
          syntax: undefined,
          evaluationProfile: undefined,
          projectContent: undefined,
          narrowComponentRouting: route.narrow,
        };
        return yield* body({}, issued.invocation, site);
      } finally {
        issued.close();
      }
    });
  }

  it("projects exact sealed functions and cannot widen a child from any other source", function* () {
    const owner = installation();
    const other = installation();
    owner.activate();
    other.activate();
    try {
      const original = owner.protected.get("Admitted");
      if (original === undefined) {
        throw new Error("missing protected definition");
      }
      const lifetime = evaluationLifetime();
      const captured = captureEvaluationProfile(
        new Map([["Admitted", ["self-closing"]]]),
        new Map([["Admitted", { definition: original, origin: "test://protected" }]]),
        lifetime,
        owner.componentRouting.project,
      );
      const sealed = captured.read[0]?.definition.fn;
      expect(yield* invoke(owner.componentRouting, sealed)).toBe("Admitted:occurrence");
      const child = owner.componentRouting.narrow([sealed]);
      const wrapper = function* (): Operation<never> {
        throw new Error("unrouted wrapper ran");
      };
      child.project(sealed, wrapper);
      expect(yield* invoke(child, wrapper)).toBe("Admitted:occurrence");
      expect(yield* invoke(owner.componentRouting, wrapper)).toBe("unrouted");
      expect(yield* invoke(other.componentRouting, sealed)).toBe("unrouted");
      const independent = function* Admitted(): Operation<string> {
        return "independent";
      };
      for (const source of [
        original.fn,
        owner.protected.get("Hidden")?.fn,
        other.protected.get("Admitted")?.fn,
        independent,
        { ...original, fn: independent },
      ]) {
        const attempted = function* (): Operation<string> {
          return "attempted";
        };
        child.project(source, attempted);
        expect(yield* invoke(child, source)).toBe("unrouted");
        expect(yield* invoke(child, attempted)).toBe("unrouted");
      }
      child.close();
      expect(yield* invoke(child, wrapper)).toBe("unrouted");
      expect(yield* invoke(owner.componentRouting, sealed)).toBe("Admitted:occurrence");
      lifetime.revoke();
    } finally {
      owner.identities.revoke();
      other.identities.revoke();
    }
  });

  it("revokes retained lookup, body, projection and narrowing operations at teardown", function* () {
    const owner = installation();
    owner.activate();
    const original = owner.protected.get("Admitted")?.fn;
    const child = owner.componentRouting.narrow([original]);
    const project = child.project;
    const narrow = child.narrow;
    const wrapper = function* (): Operation<string> {
      return "wrapper";
    };
    project(original, wrapper);
    expect(yield* invoke(child, wrapper)).toBe("Admitted:occurrence");
    const body = child.body(wrapper);
    if (body === undefined) {
      throw new Error("expected a live body");
    }
    owner.identities.revoke();
    project(original, wrapper);
    expect(yield* invoke(child, wrapper)).toBe("unrouted");
    expect(yield* invoke(narrow([original, wrapper]), wrapper)).toBe("unrouted");
    let message = "";
    try {
      yield* body(
        {},
        { hasContent: () => false },
        {
          syntax: undefined,
          evaluationProfile: undefined,
          projectContent: undefined,
          narrowComponentRouting: narrow,
        },
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("route has closed");
    const later = installation();
    later.activate();
    try {
      later.componentRouting.project(wrapper, later.protected.get("Admitted")?.fn);
      expect(yield* invoke(later.componentRouting, wrapper)).toBe("unrouted");
      expect(yield* invoke(later.componentRouting, later.protected.get("Admitted")?.fn)).toBe(
        "Admitted:occurrence",
      );
    } finally {
      later.identities.revoke();
    }
  });
});

/**
 * The answers canonical resolution would have produced for these names.
 *
 * Capture never resolves anything itself: by the time it runs, every selected
 * name has been resolved once through the ordinary import chain and core holds
 * its own copy of what the chain answered with. These rows hand it those copies
 * directly, which is the seam, and core's own definitions are what they hand
 * over wherever the name is core's.
 */
function coreAnswers(...names: readonly string[]): ResolvedAnswers {
  const answers = new Map<string, ResolvedAnswer>();
  for (const name of names) {
    const definition = fixedFilesystemDefinition(name) ?? coreComponentDefinition(name);
    if (definition === undefined) {
      throw new Error(`core supplies no ${name} component`);
    }
    answers.set(name, { definition, origin: CORE_ORIGIN });
  }
  return answers;
}

/** One selection, in the canonical order the admission produces. */
function selection(stated: Readonly<Record<string, readonly InvocationForm[]>>): AdmittedSelection {
  return new Map(Object.entries(stated));
}

/** Capture one selection against the answers its names resolved to. */
function capture(
  stated: Readonly<Record<string, readonly InvocationForm[]>>,
  answers: ResolvedAnswers = coreAnswers(...Object.keys(stated)),
): EvaluationProfile {
  return captureEvaluationProfile(selection(stated), answers, evaluationLifetime());
}

/** What capturing this selection refused with, as a string. */
function refusal(
  stated: Readonly<Record<string, readonly InvocationForm[]>>,
  answers?: ResolvedAnswers,
): string {
  try {
    capture(stated, answers);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected the capture to be refused");
}

describe("Tier EP — a captured profile stops reading the host's objects", () => {
  it("EP1: a selection the host mutates after capture does not change the profile", function* () {
    const stated: Record<string, readonly InvocationForm[]> = { File: ["self-closing"] };
    const admitted = new Map(Object.entries(stated));
    const captured = captureEvaluationProfile(admitted, coreAnswers("File"), evaluationLifetime());

    // The selection the host stated, and the validated map core derived from
    // it, are both edited after capture. Neither reaches the profile.
    stated["File.Delete"] = ["self-closing"];
    admitted.set("Glob", ["self-closing"]);

    expect(captured.read.map((admittedEntry) => admittedEntry.name)).toEqual(["File"]);
    expect(captured.write).toEqual([]);
    yield* useScope();
  });

  it("EP2: a schema the owner's definition carries is detached before it validates", function* () {
    const captured = capture({ Glob: ["self-closing"] });
    const props = captured.read[0]?.props;

    // The contract is the owning declaration's, copied rather than referenced:
    // what a fragment's props are validated against cannot be edited through
    // the definition the chain answered with.
    expect(props).toEqual(globProps);
    expect(props).not.toBe(globProps);
    expect(Object.isFrozen(props)).toBe(true);
    yield* useScope();
  });

  it("EP3: the forms a selection offers are copied, in canonical order", function* () {
    const forms: InvocationForm[] = ["paired", "self-closing"];
    const captured = capture({ File: forms });
    forms.length = 0;

    // Canonical order whatever order the host wrote, so two hosts stating the
    // same pair stated the same thing — and the arrays on the profile are its
    // own, so emptying the host's changes nothing.
    expect(captured.read[0]?.forms).toEqual(["self-closing"]);
    expect(captured.write[0]?.forms).toEqual(["paired"]);
    yield* useScope();
  });

  it("EP4: a captured implementation refuses once the execution has ended", function* () {
    const lifetime = evaluationLifetime();
    const captured = captureEvaluationProfile(
      selection({ File: ["self-closing"] }),
      coreAnswers("File"),
      lifetime,
    );

    expect(captured.live()).toBe(true);
    captured.revoke();
    expect(captured.live()).toBe(false);
    expect(lifetime.live()).toBe(false);

    const held = captured.read[0]?.definition.fn;
    if (typeof held !== "function") {
      throw new Error("the capture sealed no invocable entry");
    }
    let refused = "";
    try {
      yield* held({}, { hasContent: () => false });
    } catch (error) {
      refused = error instanceof Error ? error.message : String(error);
    }
    expect(refused).toContain(REVOKED);
  });
});

describe("Tier EP — the table a spelling lands in is the owner's answer", () => {
  it("EP5: one name's two spellings are derived into the two tables", function* () {
    const captured = capture({ File: ["self-closing", "paired"] });

    // The selection says `<File>` in both spellings. Which of them observes and
    // which mutates is on core's own declaration, so the host never divided
    // them — and the implementation behind both is the same object.
    expect(captured.read.map((entry) => entry.name)).toEqual(["File"]);
    expect(captured.write.map((entry) => entry.name)).toEqual(["File"]);
    expect(captured.read[0]?.definition).toBe(captured.write[0]?.definition);
    expect(captured.read[0]?.props).toBe(captured.write[0]?.props);
    expect(captured.read[0]?.definition.generated).toEqual({
      "self-closing": { identity: "https://executable.md/components/file/read", effect: "read" },
      paired: { identity: "https://executable.md/components/file/write", effect: "write" },
    });
  });

  it("EP6: a selection whose spellings all write derives no read table", function* () {
    const captured = capture({ File: ["paired"], "File.Delete": ["self-closing"] });

    expect(captured.read).toEqual([]);
    expect(captured.write.map((entry) => entry.name)).toEqual(["File", "File.Delete"]);
  });

  it("EP7: the contract, the origin and the dispatcher come from the owner", function* () {
    const captured = capture({ File: ["self-closing"], Glob: ["self-closing"] });
    const [file, glob] = captured.read;

    expect(file?.origin).toBe(CORE_ORIGIN);
    expect(file?.props).toEqual(fixedFilesystemDefinition("File")?.props);
    // The component's own dispatcher travels with it, so canonical selection
    // enters the body the scan chose rather than the lifetime guard around it.
    expect(isFormDispatcher(file?.dispatch)).toBe(true);

    // The search is the same component an author writes: the ordinary props,
    // the one spelling, and a declared return — which is what makes `as`
    // mandatory before the provider is asked to traverse anything.
    expect(glob?.props).toEqual(globProps);
    expect(glob?.definition.returns).toEqual({ type: "array", items: { type: "string" } });
    expect(Object.keys(glob?.definition.generated ?? {})).toEqual(["self-closing"]);
  });

  it("EP8: core's protected `<Syntax />` is one selected name like any other", function* () {
    const captured = capture({ Syntax: ["self-closing"] }, syntaxAnswer());

    // The selection carries the name and the spelling and nothing else. What is
    // behind a protected name, and what the one spelling grants, are canonical
    // resolution's to answer and the declaration's to state.
    expect(captured.read.map((entry) => entry.name)).toEqual(["Syntax"]);
    expect(SYNTAX_PROTECTED.generated).toEqual({
      "self-closing": { identity: "https://executable.md/components/syntax/read", effect: "read" },
    });
    yield* useScope();
  });
});

describe("Tier EP — a selection a host cannot capture", () => {
  it("EP9: a spelling its owner offers no generated use of refuses", function* () {
    // `<File.Delete>` offers the self-closing form alone, so selecting the
    // paired one would admit a spelling with no identity for a continuation to
    // be compared against.
    expect(refusal({ "File.Delete": ["paired"] })).toContain("offers no generated use of it");
    yield* useScope();
  });

  it("EP10: a selected name this execution resolved nothing for refuses", function* () {
    expect(refusal({ File: ["self-closing"] }, new Map())).toContain("resolved no implementation");
    yield* useScope();
  });

  it("EP11: an answer with nothing to invoke refuses", function* () {
    const answers: ResolvedAnswers = new Map([
      [
        "Open",
        {
          origin: "test://provider",
          definition: {
            kind: "function",
            name: "Open",
            props: { type: "object", properties: {}, additionalProperties: false },
            generated: {
              "self-closing": {
                identity: "https://executable.md/components/open/read",
                effect: "read" as const,
              },
            },
            fn: undefined,
          } as unknown as FunctionComponentDefinition,
        },
      ],
    ]);
    expect(refusal({ Open: ["self-closing"] }, answers)).toContain("no implementation to invoke");
    yield* useScope();
  });

  it("EP12: selecting a trusted composition name refuses", function* () {
    // Closed-world conflict detection, at capture: a host never gets to give an
    // effect to core's own pure component.
    expect(refusal({ Json: ["self-closing"] })).toContain("trusted composition");
    yield* useScope();
  });

  it("EP13: a declaration whose generated metadata is unusable refuses", function* () {
    const answers: ResolvedAnswers = new Map([
      [
        "Open",
        {
          origin: "test://provider",
          definition: {
            kind: "function" as const,
            name: "Open",
            props: { type: "object", properties: {}, additionalProperties: false },
            // Not an absolute URL in the accepted namespace, so the owner has
            // stated no identity a continuation could be compared against.
            generated: { "self-closing": { identity: "components/open/read", effect: "read" } },
            // deno-lint-ignore require-yield
            *fn(): Operation<Json> {
              return "opened";
            },
          },
        },
      ],
    ]);
    expect(refusal({ Open: ["self-closing"] }, answers)).toContain("absolute URL");
    yield* useScope();
  });
});

/**
 * Tier EP — one name, one implementation.
 *
 * A selected name is resolved once through the ordinary import chain and
 * captured. So what a selection may say about a name is settled here rather
 * than at the lookup: its two spellings are two grants of one component, each
 * reading its own identity and effect off the one definition the chain answered
 * with.
 */
describe("Tier EP — a provider-backed name resolves once to one definition", () => {
  /** What that provider's declaration offers each of its two spellings as. */
  const BOTH_FORMS: GeneratedForms = {
    "self-closing": { identity: "https://executable.md/components/open/read", effect: "read" },
    paired: { identity: "https://executable.md/components/open/write", effect: "write" },
  };

  /** One implementation, as canonical execution hands capture its answer. */
  function answered(generated: GeneratedForms = BOTH_FORMS): ResolvedAnswers {
    return new Map<string, ResolvedAnswer>([
      [
        "Open",
        {
          origin: "test://provider",
          definition: {
            kind: "function",
            name: "Open",
            props: { type: "object", properties: {}, additionalProperties: false },
            generated,
            // deno-lint-ignore require-yield
            *fn(): Operation<Json> {
              return "opened";
            },
          },
        },
      ],
    ]);
  }

  it("EP18: one name across both spellings is one implementation in two tables", function* () {
    const captured = capture({ Open: ["self-closing", "paired"] }, answered());
    const observing = captured.read[0];
    const mutating = captured.write[0];

    expect(observing?.forms).toEqual(["self-closing"]);
    expect(mutating?.forms).toEqual(["paired"]);
    // Two URLs and two effects, read off the one definition: the reading
    // spelling and the writing one are different grants, and the implementation
    // behind them is the same object.
    expect(observing?.definition.generated).toEqual(BOTH_FORMS);
    expect(observing?.origin).toBe("test://provider");
    // One captured implementation, shared. Two guards over one answer would be
    // two lifetimes for one implementation, and which of them a fragment
    // reached would depend on which table admitted it.
    expect(observing?.definition).toBe(mutating?.definition);
    expect(observing?.props).toBe(mutating?.props);
    yield* useScope();
  });

  it("EP19: an answer that does not offer a selected spelling refuses at capture", function* () {
    // The implementation is resolved once and then held to what its own
    // declaration offers. A selection cannot name a spelling the provider never
    // offered: that would be a grant the implementation does not have, and it
    // refuses before an execution holds a profile.
    const readOnly: GeneratedForms = {
      "self-closing": { identity: "https://executable.md/components/open/read", effect: "read" },
    };
    expect(refusal({ Open: ["self-closing", "paired"] }, answered(readOnly))).toContain(
      "offers no generated use of it",
    );
    yield* useScope();
  });

  it("EP20: both spellings offered as reads land in the read table together", function* () {
    // A provider whose component observes in both spellings, which is what a
    // form-insensitive read is. The effect is the owner's answer, so both
    // spellings are reads and the selection decided nothing about it.
    const bothRead: GeneratedForms = {
      "self-closing": { identity: "https://executable.md/components/open/read", effect: "read" },
      paired: { identity: "https://executable.md/components/open/also", effect: "read" },
    };
    const captured = capture({ Open: ["paired", "self-closing"] }, answered(bothRead));

    expect(captured.write).toEqual([]);
    expect(captured.read).toHaveLength(1);
    expect(captured.read[0]?.forms).toEqual(["self-closing", "paired"]);
    yield* useScope();
  });
});

/** Canonical `<Syntax />`, as canonical resolution answers for it. */
function syntaxAnswer(): ResolvedAnswers {
  const identity = installIdentities([], [], [SYNTAX_PROTECTED]);
  identity.activate();
  const definition = identity.protected.get("Syntax");
  if (definition === undefined) {
    throw new Error("core supplies no Syntax component");
  }
  return new Map([["Syntax", { definition, origin: CORE_ORIGIN }]]);
}
