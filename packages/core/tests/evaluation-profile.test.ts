/**
 * Tier EP — what canonical execution captures from a host's evaluation profile.
 *
 * `<Evaluate>` is public, so any author may write it. What keeps that from
 * being a capability is that the ceiling it narrows from was stated by a
 * trusted host before a document existed — and that the execution stopped
 * reading the host's objects the moment it captured them.
 *
 * Every row here is about that second half. A host that edits its own tables,
 * schemas, headers or roots after installation is editing objects nothing is
 * looking at, and a profile that kept a reference instead of a copy would let
 * it move the ceiling from inside its own `install()`.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import type { Operation } from "effection";
import { scoped, useScope } from "effection";
import { installIdentities, isFormDispatcher } from "../src/invocation-identity.ts";
import type { ComponentRouting, ProtectedSite } from "../src/invocation-identity.ts";

import {
  CANONICAL_PROFILE_ANSWERS,
  elicitWriteEntry,
  fileReadEntry,
  globReadEntry,
  prepareEvaluationProfile,
  syntaxReadEntry,
} from "../src/evaluation-profile.ts";
import { CORE_ORIGIN } from "../src/components/registry.ts";
import { SYNTAX_PROTECTED } from "../src/components/Syntax.ts";
import { props as globProps } from "../src/components/Glob.ts";
import { props as elicitProps } from "../src/components/Elicit.ts";
import { capabilityReturns } from "../src/fragment-capabilities.ts";
import { fixedFilesystemDefinition } from "../src/components/fixed-filesystem.ts";
import type {
  CapabilityEntry,
  EvaluationProfile,
  ComponentAnswerEntry,
  FragmentEvaluationInput,
  FragmentForm,
  ResolvedAnswer,
  ResolvedAnswers,
} from "../src/evaluation-profile.ts";
import type { GeneratedForms } from "../src/components/generated-metadata.ts";
import type { Json } from "../src/types.ts";

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
      const prepared = yield* prepareEvaluationProfile({
        read: [{ kind: "component-answer", name: "Admitted", forms: ["self-closing"] }],
      });
      const captured = yield* prepared.seal(
        new Map([["Admitted", { definition: original, origin: "test://protected" }]]),
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
      prepared.revoke();
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

function entry(overrides: Partial<CapabilityEntry> = {}): CapabilityEntry {
  const name = overrides.name ?? "File";
  return {
    kind: "capability",
    name,
    forms: ["self-closing"],
    props: { type: "object", properties: {}, additionalProperties: false },
    // The capability follows the name unless a row states otherwise: what these
    // rows are about is how a ceiling is captured, not which body runs.
    capability: name === "Fetch" ? "fetch" : "file:read",
    ...overrides,
  };
}

/**
 * Capture a profile, with the operations every file entry needs supplied.
 *
 * A host that admits `<File />` states the operations it runs, and a profile
 * that does not is refused — EP17 covers that on its own. Every other row is
 * about what capture does with a profile a host *can* state, so they all supply
 * them and none of them restates the fact.
 */
function* capture(overrides: Partial<FragmentEvaluationInput> = {}): Operation<EvaluationProfile> {
  // Preparation copies and binds; sealing settles the provider-backed names.
  // A capability-only profile resolves none, which is why every row here seals
  // against no answers at all.
  const prepared = yield* prepareEvaluationProfile({
    read: [entry()],
    ...overrides,
  });
  return yield* prepared.seal(new Map());
}

/** What capturing this profile refused with, as a string. */
function* refusal(overrides: Partial<FragmentEvaluationInput>): Operation<string> {
  try {
    yield* capture(overrides);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected the profile to be refused");
}

// deno-lint-ignore require-yield
function* emptyBasis(): Operation<{ roots: readonly string[]; current: string }> {
  return { roots: [], current: "" };
}

describe("Tier EP — a captured profile stops reading the host's objects", () => {
  it("EP1: a table the host mutates after capture does not change the profile", function* () {
    const read: CapabilityEntry[] = [entry()];
    const captured = yield* capture({ read });

    read.push(entry({ name: "Added" }));
    read.length = 0;

    expect(captured.read).toHaveLength(1);
    expect(captured.read[0]?.name).toBe("File");
  });

  it("EP2: a schema the host edits after capture does not change what validates", function* () {
    const props: Record<string, Json> = {
      type: "object",
      properties: { path: { type: "string" } },
      additionalProperties: false,
    };
    const captured = yield* capture({ read: [entry({ props })] });

    props.additionalProperties = true;
    const properties = props.properties;
    if (typeof properties === "object" && properties !== null && !Array.isArray(properties)) {
      properties.widened = { type: "string" };
    }

    expect(captured.read[0]?.props.additionalProperties).toBe(false);
    const held = captured.read[0]?.props.properties;
    const names =
      typeof held === "object" && held !== null && !Array.isArray(held) ? Object.keys(held) : [];
    expect(names).toEqual(["path"]);
  });

  it("EP3: forms the host edits after capture do not widen what is admitted", function* () {
    const forms: FragmentForm[] = ["self-closing"];
    const captured = yield* capture({ read: [entry({ forms })] });

    // The host's own array, pushed to after installation. Capture read it once
    // and kept its own ordered copy, so a spelling added afterwards is added to
    // an object nothing is looking at.
    forms.push("paired");

    expect(captured.read[0]?.forms).toEqual(["self-closing"]);
  });

  it("EP4: request headers and lists the host mutates do not widen the ceiling", function* () {
    const headers: Record<string, Json> = { accept: "text/plain" };
    const requests: Record<string, Json>[] = [{ url: "https://api.example.test/one", headers }];
    const captured = yield* capture({
      read: [entry({ name: "Fetch", requests })],
      fetchTimeout: 1000,
    });

    headers.authorization = "Bearer widened";
    requests.push({ url: "https://api.example.test/two" });

    const ceiling = captured.read[0]?.requests ?? [];
    expect(ceiling).toHaveLength(1);
    expect(Object.keys(ceiling[0]?.headers ?? {})).toEqual(["accept"]);
    expect(ceiling[0]?.url).toBe("https://api.example.test/one");
  });

  it("EP5: the host's resolved timeout is the ceiling, read once", function* () {
    const captured = yield* capture({
      read: [entry({ name: "Fetch", requests: [{ url: "https://api.example.test/one" }] })],
      fetchTimeout: 2500,
    });

    // The host resolved it when it built the profile. Nothing here reads a
    // context, so where preflight later happens cannot change the ceiling.
    expect(captured.read[0]?.requests?.[0]?.timeout).toBe(2500);
  });

  it("EP6: a request stating its own timeout outranks the host default", function* () {
    const captured = yield* capture({
      read: [
        entry({
          name: "Fetch",
          // The prop grammar, which is a duration rather than milliseconds.
          requests: [{ url: "https://api.example.test/one", timeout: "100ms" }],
        }),
      ],
      fetchTimeout: 2500,
    });

    expect(captured.read[0]?.requests?.[0]?.timeout).toBe(100);
  });

  it("EP7: one ceiling stated twice is one ceiling", function* () {
    const captured = yield* capture({
      read: [
        entry({
          name: "Fetch",
          requests: [
            { url: "https://api.example.test/one" },
            { url: "https://api.example.test/one" },
          ],
        }),
      ],
      fetchTimeout: 1000,
    });

    expect(captured.read[0]?.requests).toHaveLength(1);
  });

  it("EP8: ceilings are canonically ordered, so two statements of one set match", function* () {
    const one = yield* capture({
      read: [
        entry({
          name: "Fetch",
          requests: [{ url: "https://api.example.test/a" }, { url: "https://api.example.test/b" }],
        }),
      ],
      fetchTimeout: 1000,
    });
    const other = yield* capture({
      read: [
        entry({
          name: "Fetch",
          requests: [{ url: "https://api.example.test/b" }, { url: "https://api.example.test/a" }],
        }),
      ],
      fetchTimeout: 1000,
    });

    expect(one.read[0]?.requests?.map((request) => request.url)).toEqual(
      other.read[0]?.requests?.map((request) => request.url),
    );
  });

  it("EP9: each entry keeps its own ceiling rather than a flattened one", function* () {
    const captured = yield* capture({
      read: [
        entry({ name: "First", requests: [{ url: "https://api.example.test/first" }] }),
        entry({ name: "Second", requests: [{ url: "https://api.example.test/second" }] }),
      ],
      fetchTimeout: 1000,
    });

    // Flattening them would let the first entry's limit admit the second's
    // request: a ceiling belongs to the entry that states it.
    expect(captured.read[0]?.requests?.map((request) => request.url)).toEqual([
      "https://api.example.test/first",
    ]);
    expect(captured.read[1]?.requests?.map((request) => request.url)).toEqual([
      "https://api.example.test/second",
    ]);
  });

  it("EP10: a Workspace answer the host mutates afterwards does not move the basis", function* () {
    const roots = ["workspace://one"];
    const captured = yield* capture({
      read: [entry()],
      workspace: {
        // deno-lint-ignore require-yield
        *snapshot() {
          return { roots, current: "workspace://one" };
        },
      },
    });

    const basis = yield* captured.workspace?.snapshot() ?? emptyBasis();
    roots.push("workspace://two");

    expect(basis.roots).toEqual(["workspace://one"]);
  });

  it("EP11: replacing the host's snapshot method after capture reaches nothing", function* () {
    const access = {
      // deno-lint-ignore require-yield
      *snapshot(): Operation<{ roots: readonly string[]; current: string }> {
        return { roots: ["workspace://honest"], current: "workspace://honest" };
      },
    };
    const captured = yield* capture({ read: [entry()], workspace: access });

    // deno-lint-ignore require-yield
    access.snapshot = function* () {
      return { roots: ["workspace://substituted"], current: "workspace://substituted" };
    };

    const basis = yield* captured.workspace?.snapshot() ?? emptyBasis();
    expect(basis.roots).toEqual(["workspace://honest"]);
  });
});

describe("Tier EP — a profile a host cannot state", () => {
  it("EP12: an entry admitted in the table its owner does not offer refuses", function* () {
    // What a spelling does belongs to the component. `<File>` offers its paired
    // form as a write, so admitting that spelling in the read table would hand
    // a read selection a mutation — and `<File.Delete>` offers no paired form
    // at all, so admitting one would admit a spelling with no identity for a
    // continuation to be compared against.
    const wrongTable = yield* refusal({
      read: [entry({ name: "File", capability: "file:write", forms: ["paired"] })],
    });
    expect(wrongTable).toContain("its owner offers that form as a write");

    const unoffered = yield* refusal({
      read: [entry({ name: "File.Delete", capability: "file:delete", forms: ["paired"] })],
    });
    expect(unoffered).toContain("offers no generated use of it");
  });

  it("EP13: an entry admitted for no form refuses", function* () {
    expect(yield* refusal({ read: [entry({ forms: [] })] })).toContain("no authored form");
  });

  it("EP14: a request entry with no request it may perform refuses", function* () {
    expect(yield* refusal({ read: [entry({ name: "Fetch", requests: [] })] })).toContain(
      "no request it may perform",
    );
  });

  it("EP15: a profile stating no component at all refuses", function* () {
    expect(yield* refusal({ read: [] })).toContain("no component at all");
  });

  it("EP17: a file entry states no operations, and runs the component core owns", function* () {
    // The inverse of what this row asserted while the profile carried a private
    // transport, where a host admitting `<File />` without stating operations
    // had admitted something it could not perform. There is nothing left for a
    // host to state: the entry runs canonical core's own component, which
    // performs its work through whichever provider is installed where the
    // fragment runs. So the admission is complete on its own — and an absent
    // provider is fatal at the operation, exactly as it is for an authored
    // element.
    const captured = yield* capture({ read: [fileReadEntry()] });
    const admitted = captured.read[0];

    expect(admitted?.kind).toBe("capability");
    expect(admitted?.capability).toBe("file:read");
    // The owning component's own contract, read off it rather than restated.
    expect(admitted?.props).toEqual(fixedFilesystemDefinition("File")?.props);
    // And the component's own dispatcher travels with it, so canonical
    // selection enters the body the scan chose rather than a wrapper's.
    expect(isFormDispatcher(admitted?.dispatch)).toBe(true);
  });

  it("EP21: core's own read entries state exactly what a host may admit them as", function* () {
    const captured = yield* capture({ read: [fileReadEntry(), globReadEntry()] });
    const [file, glob] = captured.read;

    // The identity each spelling runs under is on the definition, where core's
    // own declaration states it: the reading form observes and the writing form
    // mutates, and one admitted entry carries both because one component does.
    expect(file?.definition.generated).toEqual({
      "self-closing": { identity: "https://executable.md/components/file/read", effect: "read" },
      paired: { identity: "https://executable.md/components/file/write", effect: "write" },
    });
    expect(file?.origin).toBe(CORE_ORIGIN);
    expect(file?.forms).toEqual(["self-closing"]);
    expect(file?.definition.returns).toBe(undefined);

    // The search is the same component an author writes: the ordinary props,
    // the one spelling, and a declared return — which is what makes `as`
    // mandatory before the host's provider is asked to traverse anything.
    expect(glob?.definition.generated).toEqual({
      "self-closing": { identity: "https://executable.md/components/glob/read", effect: "read" },
    });
    expect(glob?.forms).toEqual(["self-closing"]);
    expect(glob?.props).toEqual(globProps);
    expect(glob?.definition.returns).toEqual({ type: "array", items: { type: "string" } });
    // One spelling, so one offered form: nothing admits a paired `<Glob>`.
    expect(Object.keys(glob?.definition.generated ?? {})).toEqual(["self-closing"]);
  });

  it("EP22: canonical Syntax is admitted as an answer, and states no identity", function* () {
    const stated = syntaxReadEntry();

    expect(stated.kind).toBe("component-answer");
    expect(stated.name).toBe("Syntax");
    expect(stated.forms).toEqual(["self-closing"]);
    // The arm carries no implementation and no identity at all: what is behind
    // a protected name, and what admitting its one spelling grants, are
    // canonical resolution's to answer rather than a host's to hand over.
    expect(Object.keys(stated)).not.toContain("capability");
    expect(Object.keys(stated)).not.toContain("identity");
    // Core's own declaration is where that spelling's identity and effect are.
    expect(SYNTAX_PROTECTED.generated).toEqual({
      "self-closing": { identity: "https://executable.md/components/syntax/read", effect: "read" },
    });
  });

  it("EP23: one name admitted for two different components refuses", function* () {
    // `<File>` holds two capabilities under one name legitimately, because both
    // belong to the same component: its two spellings are two bodies of one
    // `<File>`. Two capabilities owned by *different* components would be one
    // name with two answers, decided by how the element happened to be written
    // — and the two would disagree about what `as` means, which is how this
    // same mistake used to be caught. The owning component is what is compared
    // now, because that is the earlier and more general fact: a name that runs
    // two components is already wrong, whatever either of them binds.
    expect(
      yield* refusal({
        read: [entry({ name: "File", capability: "files:glob", forms: ["self-closing"] })],
        write: [entry({ name: "File", capability: "file:write", forms: ["paired"] })],
      }),
    ).toContain("two different components");
  });

  it("EP16: forms are canonically ordered, so two statements of one pair match", function* () {
    // A provider whose component observes in both spellings, which is what a
    // form-insensitive read is: both are offered as reads, so both may be
    // admitted in the read table and the order the host wrote them in is not
    // part of what it stated.
    const both: GeneratedForms = {
      "self-closing": { identity: "https://executable.md/components/pair/read", effect: "read" },
      paired: { identity: "https://executable.md/components/pair/also", effect: "read" },
    };
    const answers: ResolvedAnswers = new Map([
      [
        "Pair",
        {
          origin: "test://provider",
          definition: {
            kind: "function" as const,
            name: "Pair",
            props: { type: "object", properties: {}, additionalProperties: false },
            generated: both,
            // deno-lint-ignore require-yield
            *fn(): Operation<Json> {
              return "paired";
            },
          },
        },
      ],
    ]);
    const admitting = function* (forms: readonly FragmentForm[]): Operation<EvaluationProfile> {
      const prepared = yield* prepareEvaluationProfile({
        read: [{ kind: "component-answer", name: "Pair", forms }],
      });
      return yield* prepared.seal(answers);
    };

    const one = yield* admitting(["paired", "self-closing"]);
    const other = yield* admitting(["self-closing", "paired"]);

    expect(one.read[0]?.forms).toEqual(other.read[0]?.forms);
    expect(one.read[0]?.forms).toEqual(["self-closing", "paired"]);
  });
});

/**
 * Tier EP — one name, one implementation.
 *
 * A provider-backed name is resolved once through the ordinary import chain and
 * sealed. So what a profile may say about a name is settled here rather than at
 * the lookup: two entries under one name are the two spellings of one
 * component, each reading its own identity and effect off the one definition
 * the chain answered with.
 */
describe("Tier EP — a provider-backed name resolves once to one definition", () => {
  const OPEN: ComponentAnswerEntry = {
    kind: "component-answer",
    name: "Open",
    forms: ["self-closing"],
  };

  /**
   * One implementation, as canonical execution hands sealing its answer.
   *
   * It offers both spellings, each under its own identity and effect, because
   * that is what a provider whose component reads one way and writes the other
   * declares — and it is one definition doing it.
   */
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

  /** What that provider's declaration offers each of its two spellings as. */
  const BOTH_FORMS: GeneratedForms = {
    "self-closing": { identity: "https://executable.md/components/open/read", effect: "read" },
    paired: { identity: "https://executable.md/components/open/write", effect: "write" },
  };

  /** Prepare a profile holding these entries, without sealing it. */
  function prepare(input: Partial<FragmentEvaluationInput>) {
    return prepareEvaluationProfile({ read: [entry()], ...input });
  }

  /** What sealing this prepared profile refused with. */
  function* sealing(
    prepared: { seal: (answers: ResolvedAnswers) => Operation<EvaluationProfile> },
    answers: ResolvedAnswers,
  ): Operation<string> {
    try {
      yield* prepared.seal(answers);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    throw new Error("expected sealing to be refused");
  }

  /** What preparing this profile refused with. */
  function* refused(input: Partial<FragmentEvaluationInput>): Operation<string> {
    try {
      yield* prepare(input);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    throw new Error("expected the profile to be refused");
  }

  it("EP18: one name across disjoint forms and tables is one lookup and one implementation", function* () {
    // The self-closing spelling admitted to observe and the paired one to
    // mutate: two entries, two forms, two tables, one component. The host says
    // the name, and the definition says what each spelling runs as.
    const prepared = yield* prepare({
      read: [OPEN],
      write: [{ ...OPEN, forms: ["paired"] }],
    });

    // Asked for once, however many entries hold it: a second lookup would be a
    // second chance for the chain to answer differently.
    expect(prepared.answered).toEqual(["Open"]);

    const profile = yield* prepared.seal(answered());
    const observing = profile.read[0];
    const mutating = profile.write[0];
    expect(observing?.forms).toEqual(["self-closing"]);
    expect(mutating?.forms).toEqual(["paired"]);
    // Two URLs and two effects, read off the one definition: the reading
    // spelling and the writing one are different grants, and the implementation
    // behind them is the same object.
    expect(observing?.definition.generated).toEqual(BOTH_FORMS);
    expect(observing?.origin).toBe("test://provider");
    // One sealed implementation, shared. Two guards over one answer would be
    // two lifetimes for one implementation, and which of them a fragment
    // reached would depend on which table admitted it.
    expect(observing?.definition).toBe(mutating?.definition);
    expect(observing?.props).toBe(mutating?.props);
  });

  it("EP19: an answer that does not offer the admitted spelling refuses at sealing", function* () {
    // The implementation is resolved once and then held to what its own
    // declaration offers. A host cannot describe a spelling the provider never
    // offered, and cannot move one into the other effect table: either would be
    // a grant the implementation does not have, and both refuse before an
    // execution holds a profile.
    const prepared = yield* prepare({ read: [OPEN], write: [{ ...OPEN, forms: ["paired"] }] });
    const readOnly: GeneratedForms = {
      "self-closing": { identity: "https://executable.md/components/open/read", effect: "read" },
    };
    expect(yield* sealing(prepared, answered(readOnly))).toContain("offers no generated use of it");

    const bothRead: GeneratedForms = {
      "self-closing": { identity: "https://executable.md/components/open/read", effect: "read" },
      paired: { identity: "https://executable.md/components/open/also", effect: "read" },
    };
    expect(yield* sealing(prepared, answered(bothRead))).toContain(
      "its owner offers that form as a read",
    );
  });

  it("EP20: one name held as both a capability and an answer refuses", function* () {
    // The same ambiguity with the sharper edge: canonical core would supply one
    // body and the import chain the other, which are different grants under one
    // spelling.
    const failed = yield* refused({
      read: [entry({ name: "Open", forms: ["self-closing"] }), { ...OPEN, forms: ["paired"] }],
    });

    expect(failed).toContain("different grants");
  });
});

describe("Tier EP — the entry that admits canonical `<Elicit>`", () => {
  it("EL1: the factory pins core's own body, paired only", function* () {
    const entry = elicitWriteEntry();

    // A capability rather than a component answer: what core owns here is the
    // behavior, so the body is pinned the way `<File>`'s is. Resolving the name
    // instead would hand a generated fragment whatever legitimately shadows
    // `Elicit` — a repository file, a registration, the workflow's own
    // suspension replacement — and would resolve it for every execution the
    // profile belongs to, including ones that ask nothing.
    expect(entry.kind).toBe("capability");
    expect(entry.capability).toBe("elicit:ask");
    expect(entry.name).toBe("Elicit");
    expect(Object.keys(entry)).not.toContain("identity");
    // Paired only. The question is the content, so a self-closing spelling
    // would be a request with nothing in it.
    expect(entry.forms).toEqual(["paired"]);
    // It declares `<Elicit>`'s own contract, read from the component rather than
    // restated, and binds a value — so a generated question written without
    // `as` is refused for the ordinary reason, before anybody is asked.
    expect(entry.props).toEqual(elicitProps);
    expect(capabilityReturns("elicit:ask")).toBeDefined();

    // And it is not a name anything resolves. `Elicit` left the set canonical
    // execution resolves eagerly, which is what stops an execution that never
    // asks anything from depending on what `Elicit` resolves to.
    expect(CANONICAL_PROFILE_ANSWERS.has("Elicit")).toBe(false);

    // Two factories state the same entry and share nothing: a host that edited
    // what it was given would be editing its own copy.
    const second = elicitWriteEntry();
    expect(second).toEqual(entry);
    expect(second).not.toBe(entry);
    yield* useScope();
  });
});
