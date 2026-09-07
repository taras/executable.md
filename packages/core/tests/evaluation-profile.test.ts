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
import { installIdentities } from "../src/invocation-identity.ts";
import type { ProtectedBodies, ProtectedSite } from "../src/invocation-identity.ts";

import { prepareEvaluationProfile } from "../src/evaluation-profile.ts";
import type {
  CapabilityEntry,
  CapturedProfile,
  ComponentAnswerEntry,
  FragmentEvaluationInput,
  ResolvedAnswer,
  ResolvedAnswers,
} from "../src/evaluation-profile.ts";
import type { Json } from "../src/types.ts";
import { recordedFiles } from "./support/fragment-files.ts";

describe("protected route projection", () => {
  function installation() {
    return installIdentities(
      [],
      [],
      ["Admitted", "Hidden"].map((name) => ({
        name,
        origin: "test://protected",
        props: { type: "object" },
        build: (claim) =>
          function* (_props, invocation): Operation<string> {
            return `${name}:${yield* claim(invocation)}`;
          },
      })),
    );
  }

  function invoke(route: ProtectedBodies, fn: unknown): Operation<unknown> {
    return scoped(function* () {
      const body = route.body(fn);
      const issued = route.issue(fn, "occurrence", "Admitted", yield* useScope(), false);
      if (body === undefined || issued === undefined) {
        return "unrouted";
      }
      try {
        const site: ProtectedSite = {
          syntax: undefined,
          evaluation: undefined,
          projectContent: undefined,
          narrowProtectedBodies: route.narrow,
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
        read: [
          {
            kind: "component-answer",
            name: "Admitted",
            identity: { origin: "test://provider", key: "Admitted", revision: "1" },
            forms: ["self-closing"],
          },
        ],
      });
      const captured = yield* prepared.seal(
        new Map([["Admitted", { definition: original }]]),
        owner.protectedBodies.project,
      );
      const sealed = captured.read[0]?.definition.fn;
      expect(yield* invoke(owner.protectedBodies, sealed)).toBe("Admitted:occurrence");
      const child = owner.protectedBodies.narrow([sealed]);
      const wrapper = function* (): Operation<never> {
        throw new Error("unrouted wrapper ran");
      };
      child.project(sealed, wrapper);
      expect(yield* invoke(child, wrapper)).toBe("Admitted:occurrence");
      expect(yield* invoke(owner.protectedBodies, wrapper)).toBe("unrouted");
      expect(yield* invoke(other.protectedBodies, sealed)).toBe("unrouted");
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
      expect(yield* invoke(owner.protectedBodies, sealed)).toBe("Admitted:occurrence");
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
    const child = owner.protectedBodies.narrow([original]);
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
          evaluation: undefined,
          projectContent: undefined,
          narrowProtectedBodies: narrow,
        },
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("route has closed");
    const later = installation();
    later.activate();
    try {
      later.protectedBodies.project(wrapper, later.protected.get("Admitted")?.fn);
      expect(yield* invoke(later.protectedBodies, wrapper)).toBe("unrouted");
      expect(yield* invoke(later.protectedBodies, later.protected.get("Admitted")?.fn)).toBe(
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
    identity: { origin: "test://host", key: "File:read", revision: "1" },
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
function* capture(overrides: Partial<FragmentEvaluationInput> = {}): Operation<CapturedProfile> {
  // Preparation copies and binds; sealing settles the provider-backed names.
  // A capability-only profile resolves none, which is why every row here seals
  // against no answers at all.
  const prepared = yield* prepareEvaluationProfile({
    read: [entry()],
    files: recordedFiles(),
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

    read.push(entry({ name: "Added", identity: { origin: "t", key: "Added", revision: "1" } }));
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

  it("EP3: an identity the host edits after capture does not change what is compared", function* () {
    const identity = { origin: "test://host", key: "Probe", revision: "1" };
    const captured = yield* capture({ read: [entry({ identity })] });

    identity.revision = "2";

    expect(captured.read[0]?.identity.revision).toBe("1");
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
        entry({
          name: "Second",
          identity: { origin: "test://host", key: "Second", revision: "1" },
          requests: [{ url: "https://api.example.test/second" }],
        }),
      ],
      fetchTimeout: 1000,
    });

    // Flattening them would let the first entry's limit admit the second's
    // request: a ceiling belongs to the identity it bounds.
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
  it("EP12: an entry with no complete identity refuses", function* () {
    const attempts: Partial<CapabilityEntry>[] = [
      { identity: { origin: "", key: "Probe", revision: "1" } },
      { identity: { origin: "test://host", key: "", revision: "1" } },
      { identity: { origin: "test://host", key: "Probe", revision: "" } },
    ];
    for (const attempt of attempts) {
      expect(yield* refusal({ read: [entry(attempt)] })).toContain("complete identity");
    }
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

  it("EP17: a file entry with no operations behind it refuses", function* () {
    // A host that admits `<File />` and states no operations has admitted
    // something it cannot perform. Refused at capture — rather than admitted and
    // left to fall through to whichever provider a document installed, which is
    // exactly the reach this profile exists to remove.
    expect(
      yield* refusal({
        read: [entry()],
        files: undefined,
      }),
    ).toContain("without stating the filesystem operations");
  });

  it("EP16: forms are canonically ordered, so two statements of one pair match", function* () {
    const one = yield* capture({
      read: [entry({ forms: ["paired", "self-closing"] })],
    });
    const other = yield* capture({
      read: [entry({ forms: ["self-closing", "paired"] })],
    });

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
 * component, and a second identity for the second spelling would make which
 * implementation a fragment reached depend on which table admitted it.
 */
describe("Tier EP — a provider-backed name states one identity", () => {
  const OPEN: ComponentAnswerEntry = {
    kind: "component-answer",
    name: "Open",
    identity: { origin: "test://provider", key: "Open", revision: "1" },
    forms: ["self-closing"],
  };

  /** One implementation, as canonical execution hands sealing its answer. */
  function answered(): ResolvedAnswers {
    return new Map<string, ResolvedAnswer>([
      [
        "Open",
        {
          definition: {
            kind: "function",
            name: "Open",
            props: { type: "object", properties: {}, additionalProperties: false },
            // deno-lint-ignore require-yield
            *fn(): Operation<Json> {
              return "opened";
            },
          },
        },
      ],
    ]);
  }

  /** Prepare a profile holding these entries, without sealing it. */
  function prepare(input: Partial<FragmentEvaluationInput>) {
    return prepareEvaluationProfile({ read: [entry()], files: recordedFiles(), ...input });
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
    // the same identity for both, because there is only one thing behind the
    // name.
    const prepared = yield* prepare({
      read: [OPEN],
      write: [{ ...OPEN, forms: ["paired"] }],
    });

    // Asked for once, however many entries hold it: a second lookup would be a
    // second chance for the chain to answer differently.
    expect(prepared.answered).toEqual([
      { name: "Open", identity: { origin: "test://provider", key: "Open", revision: "1" } },
    ]);

    const profile = yield* prepared.seal(answered());
    const observing = profile.read[0];
    const mutating = profile.write[0];
    expect(observing?.forms).toEqual(["self-closing"]);
    expect(mutating?.forms).toEqual(["paired"]);
    // One sealed implementation, shared. Two guards over one answer would be
    // two lifetimes for one implementation, and which of them a fragment
    // reached would depend on which table admitted it.
    expect(observing?.definition).toBe(mutating?.definition);
    expect(observing?.props).toBe(mutating?.props);
  });

  it("EP19: a second identity for one name refuses, naming both", function* () {
    const cases: readonly (readonly [string, Partial<FragmentEvaluationInput>])[] = [
      [
        "within one table",
        { read: [OPEN, { ...OPEN, identity: { ...OPEN.identity, revision: "2" } }] },
      ],
      [
        "across the two tables",
        {
          read: [OPEN],
          write: [{ ...OPEN, forms: ["paired"], identity: { ...OPEN.identity, key: "Other" } }],
        },
      ],
      [
        "under another origin",
        { read: [OPEN, { ...OPEN, identity: { ...OPEN.identity, origin: "test://other" } }] },
      ],
    ];

    for (const [where, input] of cases) {
      const failed = yield* refused(input);
      // Refused rather than resolved by position: a last-stated identity
      // winning would be a ceiling decided by the order a host assembled its
      // tables in.
      expect([where, failed.includes("One name states one identity")]).toEqual([where, true]);
      expect([where, failed.includes("test://provider#Open@1")]).toEqual([where, true]);
    }
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
