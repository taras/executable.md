/**
 * Tier GOM — what a declaration says about the generated use of its own forms
 * (spec §§5.3, 5.6, 6.13).
 *
 * A generated fragment names a component, and two facts decide what naming it
 * grants: which URL a continuation is compared against, and whether the
 * spelling observes or mutates. Both belong to the declaration that owns the
 * implementation, so this tier is about the declaration — the shapes it may
 * state, the shapes it may not, and what survives construction.
 *
 * Three halves, failing in different places:
 *
 * **Validation.** A declaration crosses a package boundary, so the metadata is
 * read the way durable input is read: exactly two members, an identity in the
 * accepted HTTPS namespace, one of the two effects, and a spelling the
 * declaration itself accepts. A refused registration batch installs nothing.
 *
 * **The shipped owners.** `<File>`, `<File.Delete>`, `<Dir>`, `<Glob>`,
 * `<Fetch>`, `<Syntax />` and `<Elicit>` state exactly the table the
 * specification does, with `<File>`'s two spellings differing on one
 * definition. `<Json>` stays trusted composition and `<Evaluate>` offers
 * nothing, because carrying metadata grants nothing and evaluation inside
 * evaluation is not something a table may name.
 *
 * **Retention.** The shared fixed definitions are frozen through their nested
 * metadata, so a change left behind by one execution is not what the next one
 * takes its first copy of.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { InMemoryStream } from "@executablemd/durable-streams";
import { scoped } from "effection";
import type { Operation } from "effection";

import { collect } from "../src/collect.ts";
import { executeInstalled } from "../host.ts";
import type { ComponentAnswerInstallation, ExecutionInstallation } from "../host.ts";
import { useSelection } from "./support/generated-selection.ts";
import { savedSource } from "../src/root-source.ts";
import type { IdentityComponent } from "../src/invocation-identity.ts";
import { Component } from "../src/component-api.ts";
import { registerComponents } from "../src/components/registration.ts";
import type { ComponentRegistration } from "../src/components/registration.ts";
import {
  admitGeneratedForms,
  definitionGeneratedRefusal,
  generatedRefusal,
  isGeneratedIdentity,
  offeredForm,
} from "../src/components/generated-metadata.ts";
import type { GeneratedForms } from "../src/components/generated-metadata.ts";
import { fixedFilesystemDefinition } from "../src/components/fixed-filesystem.ts";
import { coreComponentDefinition } from "../src/components/registry.ts";
import { SYNTAX_PROTECTED } from "../src/components/Syntax.ts";
import { EVALUATE_PROTECTED } from "../src/components/Evaluate.ts";
import { pinnedJson } from "../src/generated-xmd.ts";
import type { ComponentRegistry, FunctionComponentDefinition, Json } from "../src/types.ts";

/** The registry visible in the current scope. */
function currentRegistry(): Operation<ComponentRegistry> {
  return Component.operations.registry;
}

/** One registration, with whatever one row states about its generated forms. */
function registration(overrides: Partial<ComponentRegistration> = {}): ComponentRegistration {
  return {
    name: "Probe",
    origin: "test://owner",
    props: { type: "object", properties: {}, additionalProperties: false },
    // deno-lint-ignore require-yield
    *fn(): Operation<Json> {
      return "probed";
    },
    ...overrides,
  };
}

/** What registering this batch refused with, or nothing when it installed. */
function* refusal(registrations: readonly ComponentRegistration[]): Operation<string | undefined> {
  try {
    yield* registerComponents([...registrations]);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return undefined;
}

/** The metadata on the definition this name resolves to in the current scope. */
function* registered(name: string): Operation<GeneratedForms | undefined> {
  const entry = (yield* currentRegistry()).get(name)?.default?.definition;
  return entry === undefined || entry.kind !== "function" ? undefined : entry.generated;
}

const READ_PROBE: GeneratedForms = {
  "self-closing": { identity: "https://executable.md/components/probe/read", effect: "read" },
};

describe("Tier GOM — a declaration states what its spellings are offered as", () => {
  it("GOM1: an accepted map survives registration, copied and frozen", function* () {
    expect(yield* refusal([registration({ generated: READ_PROBE })])).toBe(undefined);

    const held = yield* registered("Probe");
    expect(held).toEqual(READ_PROBE);
    // Copied and frozen through, so the declarer's own object is not what the
    // engine reads and a nested record cannot be edited afterwards.
    expect(held).not.toBe(READ_PROBE);
    expect(Object.isFrozen(held)).toBe(true);
    expect(Object.isFrozen(offeredForm(held, "self-closing"))).toBe(true);
  });

  it("GOM1: a component offering nothing registers and keeps its ordinary use", function* () {
    expect(yield* refusal([registration()])).toBe(undefined);

    // Omission is the ordinary case: metadata is what makes a spelling
    // offerable to a generated fragment, and offering none takes nothing away
    // from the authored element.
    expect(yield* registered("Probe")).toBe(undefined);
    const entry = (yield* currentRegistry()).get("Probe");
    expect(entry?.default?.origin).toBe("test://owner");
  });

  it("GOM1: an empty map offers no spelling, and still registers", function* () {
    expect(yield* refusal([registration({ generated: {} })])).toBe(undefined);

    const held = yield* registered("Probe");
    expect(held).toEqual({});
    expect(offeredForm(held, "self-closing")).toBe(undefined);
    expect(offeredForm(held, "paired")).toBe(undefined);
  });

  it("GOM1: a malformed map refuses, and a refused batch installs nothing", function* () {
    // Each of these is a declaration this engine cannot read: an identity that
    // is not an absolute URL in the accepted namespace, a look-alike origin, an
    // effect it does not have, a key that is not an authored form, a value that
    // is not an identity and an effect, and a spelling the declaration itself
    // does not accept.
    const attempts: readonly (readonly [string, unknown, readonly string[] | undefined])[] = [
      [
        "a relative identity",
        { "self-closing": { identity: "/probe", effect: "read" } },
        undefined,
      ],
      [
        "a look-alike origin",
        {
          "self-closing": {
            identity: "https://executable.md.example.com/components/probe/read",
            effect: "read",
          },
        },
        undefined,
      ],
      [
        "an identity that is not a URL at all",
        { "self-closing": { identity: "probe", effect: "read" } },
        undefined,
      ],
      [
        "an effect this engine does not have",
        {
          "self-closing": {
            identity: "https://executable.md/components/probe/read",
            effect: "ask",
          },
        },
        undefined,
      ],
      [
        "a key that is not an authored form",
        { either: { identity: "https://executable.md/components/probe/read", effect: "read" } },
        undefined,
      ],
      ["a value that is not a record", { "self-closing": "read" }, undefined],
      [
        "a value carrying a member this engine does not know",
        {
          "self-closing": {
            identity: "https://executable.md/components/probe/read",
            effect: "read",
            widened: true,
          },
        },
        undefined,
      ],
      ["a map that is not a map", ["read"], undefined],
      [
        "a spelling the declaration does not accept",
        { paired: { identity: "https://executable.md/components/probe/write", effect: "write" } },
        ["self-closing"],
      ],
    ];

    for (const [what, generated, forms] of attempts) {
      yield* scoped(function* () {
        const declared = Object.assign(
          registration(forms === undefined ? {} : { forms: ["self-closing"] }),
          { generated },
        );
        // Registered beside a component that is perfectly fine, so the row says
        // the batch installed nothing rather than only that one entry refused.
        const failed = yield* refusal([
          registration({ name: "Fine", generated: READ_PROBE }),
          declared,
        ]);
        expect([what, failed !== undefined]).toEqual([what, true]);
        expect([what, yield* registered("Probe")]).toEqual([what, undefined]);
        expect([what, yield* registered("Fine")]).toEqual([what, undefined]);
      });
    }
  });

  // deno-lint-ignore require-yield
  it("GOM1: an identity is admitted by its origin rather than by its text", function* () {
    expect(isGeneratedIdentity("https://executable.md/components/file/read")).toBe(true);
    // Each of these starts with the accepted text and names somebody else, so a
    // check written as a prefix comparison would admit all three.
    expect(isGeneratedIdentity("https://executable.md.example.com/components/file/read")).toBe(
      false,
    );
    expect(
      isGeneratedIdentity("https://executable.md@elsewhere.example/components/file/read"),
    ).toBe(false);
    expect(isGeneratedIdentity("http://executable.md/components/file/read")).toBe(false);
    expect(isGeneratedIdentity("components/file/read")).toBe(false);
  });

  // deno-lint-ignore require-yield
  it("GOM1: a definition that never passed registration is read the same way", function* () {
    // A provider's answer is a definition no registration validated, so its
    // metadata is read off the object defensively — including the forms it
    // states, because a definition offering a spelling it does not accept
    // offers nothing that can run.
    const offered: FunctionComponentDefinition = {
      kind: "function",
      name: "Probe",
      props: { type: "object", properties: {}, additionalProperties: false },
      forms: ["self-closing"],
      generated: READ_PROBE,
      // deno-lint-ignore require-yield
      *fn(): Operation<Json> {
        return "probed";
      },
    };
    expect(definitionGeneratedRefusal(offered)).toBe(undefined);
    expect(definitionGeneratedRefusal({ ...offered, generated: {} })).toBe(undefined);
    expect(definitionGeneratedRefusal({ kind: "function", name: "Probe" })).toBe(undefined);
    expect(
      definitionGeneratedRefusal(
        Object.assign(
          { ...offered },
          {
            generated: { paired: { identity: "https://executable.md/x", effect: "write" } },
          },
        ),
      ),
    ).toContain("does not accept");
    expect(
      definitionGeneratedRefusal(
        Object.assign({ ...offered }, { generated: { "self-closing": 1 } }),
      ),
    ).toContain("not an identity and an effect");
  });

  // deno-lint-ignore require-yield
  it("GOM1: an accessor is read once, and what was validated is what is saved", function* () {
    // The check/use gap at the declaration boundary. The identity answers the
    // accepted URL the first time it is read and `not-a-url` afterwards, so a
    // registration that validated the declarer's object and then copied it
    // again would install a value the check never saw.
    const reads: string[] = [];
    const alternating = {
      "self-closing": {
        get identity(): string {
          reads.push("identity");
          return reads.length === 1 ? "https://executable.md/components/probe/read" : "not-a-url";
        },
        effect: "read" as const,
      },
    };

    yield* scoped(function* () {
      expect(yield* refusal([registration({ generated: alternating })])).toBe(undefined);

      // One read, and the registry holds exactly it. The plant is live rather
      // than inert: the very next read of the declarer's object says something
      // else, which is what a second reading would have installed.
      expect(reads).toEqual(["identity"]);
      expect(yield* registered("Probe")).toEqual({
        "self-closing": { identity: "https://executable.md/components/probe/read", effect: "read" },
      });
      expect(alternating["self-closing"].identity).toBe("not-a-url");
    });
  });

  it("GOM1: an accessor answering an unusable value first refuses the batch", function* () {
    // The other side of the same read. What the one reading says is what the
    // declaration states, so an accessor whose first answer is unusable refuses
    // — and the batch installs nothing, however plausible a later reading is.
    const reads: string[] = [];
    const alternating = {
      "self-closing": {
        get identity(): string {
          reads.push("identity");
          return reads.length === 1 ? "not-a-url" : "https://executable.md/components/probe/read";
        },
        effect: "read" as const,
      },
    };

    yield* scoped(function* () {
      const failed = yield* refusal([
        registration({ name: "Fine", generated: READ_PROBE }),
        registration({ generated: alternating }),
      ]);
      expect(failed).toContain("not an absolute URL");
      expect(reads).toEqual(["identity"]);
      expect(yield* registered("Probe")).toBe(undefined);
      expect(yield* registered("Fine")).toBe(undefined);
    });
  });

  it("GOM1: malformed stated forms are refused rather than filtered", function* () {
    // Only genuine omission means both forms. A value that is not a canonical
    // declaration cannot be read as one by dropping what it says: a string, an
    // unknown member, an empty list and a reversed pair each describe a
    // declaration this engine does not have, so a definition offering generated
    // use of itself alongside one of them offers nothing it can be held to.
    const offered = {
      kind: "function",
      name: "Probe",
      props: { type: "object", properties: {}, additionalProperties: false },
      generated: READ_PROBE,
    };
    for (const forms of ["paired", ["self-closing", "unknown"], [], ["paired", "self-closing"]]) {
      expect([forms, definitionGeneratedRefusal({ ...offered, forms })]).toEqual([
        forms,
        expect.stringContaining("the accepted declarations are"),
      ]);
    }
    // Omission is the one reading that widens anything, and a canonical
    // declaration holding the offered spelling is accepted.
    expect(definitionGeneratedRefusal(offered)).toBe(undefined);
    expect(definitionGeneratedRefusal({ ...offered, forms: ["self-closing"] })).toBe(undefined);
    // And a definition offering nothing is not held to its forms at all, because
    // it is asking for nothing identity or effect decides.
    expect(definitionGeneratedRefusal({ kind: "function", name: "Probe", forms: "paired" })).toBe(
      undefined,
    );
  });

  it("GOM1: the refusal is a sentence a caller words for itself", function* () {
    // A sentence rather than a thrown error, because a registration, a factory
    // declaration and a provider's published answer each refuse in their own
    // error family and with their own diagnostic context.
    expect(generatedRefusal(undefined, undefined)).toBe(undefined);
    expect(generatedRefusal(READ_PROBE, undefined)).toBe(undefined);
    expect(generatedRefusal(READ_PROBE, ["paired"])).toContain("does not accept");
    // The copy and the verdict are one answer, so a caller retains exactly what
    // was validated — frozen through, because a shared definition is read by
    // every execution in the process.
    const admitted = admitGeneratedForms(READ_PROBE, undefined);
    expect(admitted.ok).toBe(true);
    expect(admitted.ok ? admitted.value : undefined).toEqual(READ_PROBE);
    expect(Object.isFrozen(admitted.ok ? admitted.value : undefined)).toBe(true);
    expect(admitGeneratedForms("read", undefined).ok).toBe(false);
  });
});

describe("Tier GOM — the owners of the shipped generated forms", () => {
  /** Exactly what the specification's owner table states, read off each owner. */
  const OWNERS: readonly (readonly [string, GeneratedForms])[] = [
    [
      "File",
      {
        "self-closing": { identity: "https://executable.md/components/file/read", effect: "read" },
        paired: { identity: "https://executable.md/components/file/write", effect: "write" },
      },
    ],
    [
      "File.Delete",
      {
        "self-closing": {
          identity: "https://executable.md/components/file/delete",
          effect: "write",
        },
      },
    ],
    [
      "Dir",
      { paired: { identity: "https://executable.md/components/dir/ensure", effect: "write" } },
    ],
  ];

  for (const [name, generated] of OWNERS) {
    // deno-lint-ignore require-yield
    it(`GOM2: core's fixed <${name}> offers exactly its own spellings`, function* () {
      const definition = fixedFilesystemDefinition(name);
      expect(definition?.generated).toEqual(generated);
    });
  }

  // deno-lint-ignore require-yield
  it("GOM2: File's two spellings differ on one definition", function* () {
    const definition = fixedFilesystemDefinition("File");
    const reading = offeredForm(definition?.generated, "self-closing");
    const writing = offeredForm(definition?.generated, "paired");

    // One component, one definition, two grants: the identity a continuation is
    // compared against and the effect a table admits it in both come from the
    // spelling rather than from the name.
    expect(reading?.effect).toBe("read");
    expect(writing?.effect).toBe("write");
    expect(reading?.identity).not.toBe(writing?.identity);
  });

  // deno-lint-ignore require-yield
  it("GOM2: the registry's own offered components state their one spelling each", function* () {
    expect(coreComponentDefinition("Glob")?.generated).toEqual({
      "self-closing": { identity: "https://executable.md/components/glob/read", effect: "read" },
    });
    expect(coreComponentDefinition("Fetch")?.generated).toEqual({
      "self-closing": { identity: "https://executable.md/components/fetch/read", effect: "read" },
    });
    expect(coreComponentDefinition("Elicit")?.generated).toEqual({
      paired: { identity: "https://executable.md/components/elicit/ask", effect: "write" },
    });
  });

  // deno-lint-ignore require-yield
  it("GOM2: canonical Syntax offers a read, and Evaluate offers nothing", function* () {
    expect(SYNTAX_PROTECTED.generated).toEqual({
      "self-closing": { identity: "https://executable.md/components/syntax/read", effect: "read" },
    });
    // Evaluation inside evaluation is not a grant a table may name, so the
    // declaration offers no spelling at all — and carrying metadata would not
    // have admitted it either.
    expect(EVALUATE_PROTECTED.generated).toBe(undefined);
  });

  // deno-lint-ignore require-yield
  it("GOM2: Json stays trusted composition, with no read or write form", function* () {
    // Rendering a value it already holds performs nothing, so there is no
    // effect for an owner to offer. The composition table states core's own
    // identity for it, and that is the one admitted identity not read off an
    // owner's metadata.
    expect(coreComponentDefinition("Json")?.generated).toBe(undefined);
    expect(pinnedJson().identity).toBe("https://executable.md/components/json");
  });

  // deno-lint-ignore require-yield
  it("GOM2: every other core default offers nothing", function* () {
    for (const name of ["TempDir", "Fail", "CodeBlock", "Parse", "SafeParse", "Test"]) {
      expect([name, coreComponentDefinition(name)?.generated]).toEqual([name, undefined]);
    }
  });
});

describe("Tier GOM — a shared definition's metadata cannot be edited", () => {
  // deno-lint-ignore require-yield
  it("GOM3: a fixed definition's nested metadata is frozen through", function* () {
    const definition = fixedFilesystemDefinition("File");
    const generated = definition?.generated;
    const reading = offeredForm(generated, "self-closing");
    if (definition === undefined || generated === undefined || reading === undefined) {
      throw new Error("core supplies no File metadata");
    }

    // This object is shared by every execution in the process, so a change left
    // behind by one would be what the next one takes its own first copy of —
    // which the per-execution comparison cannot catch. Freezing is what the
    // sharing requires.
    expect(Object.isFrozen(definition)).toBe(true);
    expect(Object.isFrozen(generated)).toBe(true);
    expect(Object.isFrozen(reading)).toBe(true);
    expect(() => {
      Object.assign(reading, { effect: "write" });
    }).toThrow();
    expect(() => {
      Object.assign(generated, { paired: reading });
    }).toThrow();

    // And a fresh read sees the original contract rather than an attempted one.
    expect(offeredForm(fixedFilesystemDefinition("File")?.generated, "self-closing")).toEqual({
      identity: "https://executable.md/components/file/read",
      effect: "read",
    });
  });
});

/**
 * Tier GOM4 — a declared component's offer survives trusted capture.
 *
 * The other declaration path. A host may declare a component to the execution
 * instead of registering one, and the execution builds the implementation from
 * that declaration's factory — so the offer has to cross capture, which reads
 * every member of the host's object once and holds what it read. A member read
 * later would be read after an installation ran, and this is the member whose
 * reading is a grant: a URL and an effect decide which implementation a
 * continuation admits.
 *
 * Every row drives a real execution: the host declares the component, the
 * execution builds it, a provider publishes that exact built object, and the
 * fragment names it in the spelling its declaration offers. What the rows read
 * is the admission the run saved, because a refusal assertion would pass for
 * a run that admitted the wrong URL and happened to fail later.
 */
describe("Tier GOM — a declared component's offer survives capture", () => {
  const ROOT_PATH = "owner.md";
  /** A document naming the declared component in the spelling it offers. */
  const NAMING_PROBE = `<Evaluate text={'<Probe />\\n'} />\n`;
  /** What the host's object says after capture has taken its reading. */
  const SUBSTITUTE: GeneratedForms = {
    "self-closing": {
      identity: "https://executable.md/components/probe/substituted",
      effect: "read",
    },
  };

  /** One component a host declares, whose implementation its factory builds. */
  function declaredProbe(generated: GeneratedForms | undefined): IdentityComponent {
    return {
      name: "Probe",
      origin: "test://owner",
      props: { type: "object", properties: {}, additionalProperties: false },
      forms: ["self-closing"],
      ...(generated === undefined ? {} : { generated }),
      factory() {
        // deno-lint-ignore require-yield
        return function* (): Operation<Json> {
          return "the factory body ran";
        };
      },
    };
  }

  /**
   * A provider publishing the implementation this execution built.
   *
   * It holds no definition of its own: what a host-declared component resolves
   * to is the object the execution built from the factory, so the provider
   * reads that from the registry and publishes it. A row reads the published
   * object to say what construction kept.
   */
  function publishing(published: FunctionComponentDefinition[]): ComponentAnswerInstallation {
    let settled = false;
    return {
      origin: "test://publisher",
      *install(registrar) {
        yield* registrar.around(function* (request, next) {
          if (request.name !== "Probe" || settled) {
            return yield* next();
          }
          settled = true;
          const built = (yield* currentRegistry()).get("Probe")?.default?.definition;
          if (built === undefined || built.kind !== "function") {
            throw new Error("the execution built no implementation for the declared component");
          }
          published.push(built);
          return request.answer(built);
        });
      },
    };
  }

  /** One host: a declared component, an entry admitting it, and its provider. */
  function host(
    component: IdentityComponent,
    published: FunctionComponentDefinition[],
    install?: () => Operation<void>,
  ): ExecutionInstallation {
    return {
      components: [component],
      componentAnswers: [publishing(published)],
      *install(): Operation<void> {
        yield* useSelection({ Probe: ["self-closing"] });
        if (install !== undefined) {
          yield* install();
        }
      },
    };
  }

  function run(
    installations: readonly ExecutionInstallation[],
    stream: InMemoryStream,
  ): Operation<Json> {
    return scoped(function* () {
      return yield* collect(
        yield* executeInstalled({ ...savedSource(ROOT_PATH, NAMING_PROBE), stream }, [
          ...installations,
        ]),
      );
    });
  }

  function isRecord(value: Json | undefined): value is Record<string, Json> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  /** The row this run's admission saved for the name it admitted. */
  function* admittedRow(stream: InMemoryStream): Operation<Json> {
    const events = yield* stream.readAll();
    const event = events.find(
      (held) => held.type === "yield" && held.description.type === "generated_xmd",
    );
    const result = event?.type === "yield" ? event.result : undefined;
    if (result === undefined || result.status !== "ok" || !isRecord(result.value)) {
      throw new Error("the run saved no admission");
    }
    const policy = result.value.policy;
    if (!isRecord(policy) || !Array.isArray(policy.allowed)) {
      throw new Error("the admission recorded no policy");
    }
    // Trusted composition leads every policy, so the row the selection
    // contributed is the one after it.
    const row = policy.allowed.find((held) => isRecord(held) && held.name === "Probe");
    if (!isRecord(row)) {
      throw new Error("the admission admitted nothing for the declared component");
    }
    return row;
  }

  /** What an admission retains for a form offered as a read. */
  const PROBE_ROW = {
    name: "Probe",
    form: "self-closing",
    identity: "https://executable.md/components/probe/read",
    kind: "component-answer",
    effect: "read",
  };

  it("GOM4: a host's factory declaration runs the spelling it offered", function* () {
    const stream = new InMemoryStream();
    const published: FunctionComponentDefinition[] = [];

    const output = yield* run([host(declaredProbe(READ_PROBE), published)], stream);

    // The built implementation carries its declaration's offer, the admission
    // names that URL and effect, and the body a factory supplied is what ran.
    expect(published[0]?.generated).toEqual(READ_PROBE);
    expect(yield* admittedRow(stream)).toEqual(PROBE_ROW);
    expect(String(output)).toContain("the factory body ran");
  });

  it("GOM4: capture reads the offer once, and construction uses that reading", function* () {
    // The check/use gap at the installation boundary, where the host also gets
    // to run code in between: the accessor answers the accepted URL the first
    // time and a substituted one afterwards, so a construction that read the
    // host's object again would build a component offering a URL capture never
    // validated.
    const reads: GeneratedForms[] = [];
    const component: IdentityComponent = {
      ...declaredProbe(undefined),
      get generated(): GeneratedForms {
        reads.push(READ_PROBE);
        return reads.length === 1 ? READ_PROBE : SUBSTITUTE;
      },
    };
    const stream = new InMemoryStream();
    const published: FunctionComponentDefinition[] = [];

    const output = yield* run([host(component, published)], stream);

    // What the one reading said is what was built and what was admitted — and
    // one reading is all there was. The plant is live rather than inert: the
    // very next reading of the host's object offers the substituted URL.
    expect(published[0]?.generated).toEqual(READ_PROBE);
    expect(yield* admittedRow(stream)).toEqual(PROBE_ROW);
    expect(reads).toHaveLength(1);
    expect(component.generated).toEqual(SUBSTITUTE);
    expect(String(output)).toContain("the factory body ran");
  });

  it("GOM4: an offer replaced from inside install() has replaced nothing", function* () {
    // A host's installation callback runs before the declared components are
    // built, so this is the window a live reference would be read through.
    const offers: { generated: GeneratedForms } = { generated: READ_PROBE };
    const component: IdentityComponent = {
      ...declaredProbe(undefined),
      get generated(): GeneratedForms {
        return offers.generated;
      },
    };
    const stream = new InMemoryStream();
    const published: FunctionComponentDefinition[] = [];

    const output = yield* run(
      [
        // deno-lint-ignore require-yield
        host(component, published, function* () {
          offers.generated = SUBSTITUTE;
        }),
      ],
      stream,
    );

    expect(offers.generated).toEqual(SUBSTITUTE);
    expect(published[0]?.generated).toEqual(READ_PROBE);
    expect(yield* admittedRow(stream)).toEqual(PROBE_ROW);
    expect(String(output)).toContain("the factory body ran");
  });

  it("GOM4: an unusable offer refuses the execution, having run nothing", function* () {
    const stream = new InMemoryStream();
    const published: FunctionComponentDefinition[] = [];
    const unusable = { "self-closing": { identity: "not-a-url", effect: "read" as const } };

    let refused = "";
    try {
      yield* run([host(declaredProbe(unusable), published)], stream);
    } catch (error) {
      refused = error instanceof Error ? error.message : String(error);
    }

    // Read where it is captured, so a declaration this engine cannot read
    // refuses before an implementation is built, a provider is asked or
    // anything is written down.
    expect(refused).toContain('the identity component "Probe" offers its self-closing form');
    expect(refused).toContain("not an absolute URL");
    expect(published).toEqual([]);
    expect(yield* stream.readAll()).toEqual([]);
  });
});
