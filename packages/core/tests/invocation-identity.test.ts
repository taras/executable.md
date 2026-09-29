/**
 * Tier CIV — the identity a trusted host's component names its work after
 * (specs/executable-mdx-spec.md §5.6).
 *
 * A component that names a durable operation after its own invocation is making
 * an ownership claim: the name decides which retained record a replay restores,
 * and an implementation running under somebody else's identity commits against
 * its own storage under their expansion. Code Rule 15 says a decision like that
 * never trusts replaceable state, so nothing here is read from one.
 *
 * The execution is told, before any installation runs, which components name
 * durable work. It mints a domain for each, hands that domain's claimant
 * straight to the host's factory, registers what comes back, and activates the
 * claimant only once that registration has committed. What a document, a
 * component or middleware can reach is the implementation — never the claimant,
 * never the domain — and the claimant answers only for the invocation the
 * engine is running at that moment.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { createContext, race, scoped, sleep, spawn, useScope, withResolvers } from "effection";
import type { Context, Operation } from "effection";
import {
  collect,
  Component,
  content,
  importComponent,
  inlineSource,
  registerComponents,
} from "../mod.ts";
import { importThroughTerminal, MissingImportProvider } from "../src/component-api.ts";
import { executeInstalled } from "../host.ts";
import type { ExecutionInstallation, IdentityClaimant, IdentityComponent } from "../host.ts";
import { getExpansion } from "../src/expansion.ts";
import { formDispatcher, installIdentities, issueInvocation } from "../src/invocation-identity.ts";
import type { IdentityDomain } from "../src/invocation-identity.ts";
import type {
  ComponentDefinition,
  ComponentInvocation,
  ComponentRegistry,
  FunctionComponent,
  FunctionComponentDefinition,
  Json,
  RegistryEntry,
} from "../src/types.ts";
import { InMemoryStream } from "@executablemd/durable-streams";
import { readTextFile } from "@effectionx/fs";
import { fileURLToPath } from "node:url";

/**
 * The engine's expansion context, addressed by the name it publishes under.
 *
 * Rebuilt here on purpose: a Context is identified by its name, so a repository
 * `.ts` component or a middleware package holding a second loaded copy of core
 * addresses the same one.
 */
const CurrentExpansion: Context<{ id: string; name: string } | undefined> = createContext<
  { id: string; name: string } | undefined
>("expand.current", undefined);

const FORGED = "forged-identity";

const NO_PROPS = { type: "object", properties: {}, additionalProperties: false } as const;

/** What one execution's probes did, in the order they did it. */
interface Seen {
  /** The durable identity each invocation was handed, in order. */
  readonly taken: string[];
  /** What `getExpansion()` reported inside each invocation, in order. */
  readonly context: string[];
  /** What the composable Component Api reported, in order. */
  readonly api: boolean[];
  /** What the engine's own invocation reported about the authored form. */
  readonly authored: boolean[];
  /** Why a take was refused, when one was. */
  readonly refusals: string[];
}

function record(): Seen {
  return { taken: [], context: [], api: [], authored: [], refusals: [] };
}

/**
 * `<Probe />`, as a host declares it: a factory the execution calls with the
 * claimant it minted, and content-bearing so one probe can be another's live
 * ancestor.
 */
function probe(seen: Seen, name = "Probe"): IdentityComponent {
  return {
    name,
    origin: `test://${name.toLowerCase()}`,
    props: NO_PROPS,
    factory: (claim: IdentityClaimant) =>
      function* Probe(
        _props: Record<string, Json>,
        invocation: ComponentInvocation,
      ): Operation<string> {
        try {
          seen.taken.push(yield* claim(invocation));
        } catch (error) {
          seen.refusals.push(error instanceof Error ? error.message : String(error));
        }
        seen.context.push((yield* getExpansion()).id);
        seen.authored.push(invocation.hasContent());
        const paired = yield* Component.operations.hasContent();
        seen.api.push(paired);
        return paired ? yield* content() : "";
      },
  };
}

/**
 * What another loaded copy's empty public terminal raises.
 *
 * The mark is copied off a genuine report rather than written out here, because
 * the mark is exactly the contract between copies: what makes this one foreign is
 * its class, which is this file's own. A real second copy is proved to be one of
 * these arrangements by `syntax-loaded-copy.test.ts`, which bundles one; what
 * matters here is that the class differs while the mark does not.
 */
class ForeignTerminalReport extends Error {
  override name = "MissingImportProvider";
}

function foreignTerminalReport(asked: string): Error {
  const authentic = new MissingImportProvider(asked);
  const foreign = new ForeignTerminalReport(authentic.message);
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(authentic))) {
    if (key !== "stack" && key !== "message") {
      Object.defineProperty(foreign, key, descriptor);
    }
  }
  return foreign;
}

/**
 * The same report, with a payload that reads as one member and is not.
 *
 * The mark's own key is found structurally rather than written out — the payload
 * is the object under it carrying `asked` — so this stays a statement about the
 * shape a reader has to parse, not a copy of a constant. The extras are hidden
 * exactly the way a reader looking at enumerable string keys alone would miss
 * them: one non-enumerable member, one symbol.
 */
function hiddenMemberReport(asked: string): Error {
  const authentic = new MissingImportProvider(asked);
  const report = new ForeignTerminalReport(authentic.message);
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(authentic))) {
    if (key === "stack" || key === "message") {
      continue;
    }
    const marked: unknown = descriptor.value;
    const names =
      typeof marked === "object" && marked !== null
        ? Object.getOwnPropertyDescriptor(marked, "asked") !== undefined
        : false;
    if (!names) {
      Object.defineProperty(report, key, descriptor);
      continue;
    }
    const payload: Record<string, unknown> = { asked };
    Object.defineProperty(payload, "hidden", { value: "not enumerable", enumerable: false });
    Object.defineProperty(payload, Symbol("also hidden"), { value: "not a string key" });
    Object.defineProperty(report, key, { ...descriptor, value: payload });
  }
  return report;
}

/** One execution of `source`, with `components` declared to it. */
function run(
  source: string,
  components: readonly IdentityComponent[],
  install?: () => Operation<void>,
  includes: readonly string[] = [],
): Operation<void> {
  return scoped(function* () {
    const installation: ExecutionInstallation = {
      components,
      ...(install === undefined ? {} : { install }),
    };
    yield* collect(
      yield* executeInstalled(
        {
          ...inlineSource(source),
          stream: new InMemoryStream(),
          includes: [...includes],
        },
        [installation],
      ),
    );
  });
}

/** The same, kept for what it rendered. */
function rendered(
  source: string,
  components: readonly IdentityComponent[],
  includes: readonly string[] = [],
): Operation<string> {
  return scoped(function* () {
    const settled = yield* collect(
      yield* executeInstalled(
        {
          ...inlineSource(source),
          stream: new InMemoryStream(),
          includes: [...includes],
        },
        [{ components }],
      ),
    );
    return String(settled);
  });
}

// deno-lint-ignore require-yield
function* nothing(): Operation<void> {}

/**
 * One activated domain and its claimant, without an execution around them.
 *
 * The engine expands one element at a time, so the cases that need two live
 * issuances — or one the engine has already ended — are stated here, at the
 * seam, with the issuances the engine would have minted.
 */
function* seam(): Operation<{ claim: IdentityClaimant; domain: IdentityDomain }> {
  let claim: IdentityClaimant | undefined;
  const installed = installIdentities([
    {
      name: "Both",
      origin: "test://both",
      props: NO_PROPS,
      factory: (delivered: IdentityClaimant) => {
        claim = delivered;
        // deno-lint-ignore require-yield
        return function* Both(): Operation<string> {
          return "";
        };
      },
    },
  ]);
  installed.activate();
  // The engine's own two steps, in order: open the frame for the import,
  // record what canonical resolution selected, settle it.
  const registration = installed.registrations[0];
  if (claim === undefined || registration === undefined) {
    throw new Error("the seam produced no claimant");
  }
  // The frame is the only thing a selection can be made into: the engine holds
  // it and hands it to the terminal it builds for that import, so this seam
  // selects through the frame rather than through the execution.
  const frame = installed.identities.beginImport("Both");
  frame.select("Both", {
    kind: "function",
    name: "Both",
    props: NO_PROPS,
    fn: registration.fn,
  });
  const domain = frame.settle();
  if (domain === undefined) {
    throw new Error("canonical selection produced no domain");
  }
  return { claim, domain };
}

describe("Tier CIV — the identity a host's component names its work after", () => {
  it("CIV1: two sites are handed two identities", function* () {
    const seen = record();
    yield* run("<Probe />\n\n<Probe />\n", [probe(seen)], nothing);
    expect(seen.taken).toHaveLength(2);
    expect(new Set(seen.taken).size).toBe(2);
    // The engine's own identity for that invocation, which is what
    // `getExpansion()` reports when nobody has interfered.
    expect(seen.taken).toEqual(seen.context);
  });

  it("CIV2: a contextual Api answer is replaceable, so a durable name may not come from one", function* () {
    const seen = record();
    // `hasContent()` stands for every Component Api answer: a handler installed
    // outside the invocation answers ahead of the engine's own.
    yield* run("<Probe />\n", [probe(seen)], function* () {
      yield* Component.around({
        // deno-lint-ignore require-yield
        *hasContent(_args, _next) {
          return true;
        },
      });
    });
    expect(seen.api).toEqual([true]);
    expect(seen.taken).toHaveLength(1);
    expect(seen.taken[0]).not.toBe(FORGED);
  });

  it("CIV3: the expansion Context is bindable, so a durable name may not come from one either", function* () {
    const observed = yield* scoped(function* () {
      yield* CurrentExpansion.set({ id: FORGED, name: "Probe" });
      return yield* CurrentExpansion.get();
    });
    // The binding takes effect where nothing republishes over it — the reach a
    // durable name must not be exposed to.
    expect(observed?.id).toBe(FORGED);
  });

  it("CIV4: middleware cannot build an invocation the claimant will answer for", function* () {
    const seen = record();
    yield* run("<Probe />\n\n<Probe />\n", [probe(seen)], function* () {
      yield* Component.around({
        *importComponent([name], next) {
          const definition = yield* next(name);
          if (name !== "Probe" || definition.kind !== "function") {
            return definition;
          }
          const original = definition.fn;
          if (typeof original !== "function") {
            return definition;
          }
          return {
            ...definition,
            *fn(props: Record<string, Json>, _invocation: ComponentInvocation) {
              // A structural stand-in, which is what a wrapper would mint to
              // give both sites one durable name. It answers the authored form
              // too — implementing the whole public shape is exactly what a
              // forger would do, and identity is the private field rather than
              // the shape.
              return yield* original(props, { hasContent: () => false });
            },
          };
        },
      });
    });

    expect(seen.taken).toEqual([]);
    expect(seen.refusals).toHaveLength(2);
    for (const refusal of seen.refusals) {
      expect(refusal).toContain("not an invocation the engine issued");
    }
  });

  it("CIV5: middleware may forward the genuine issuance, and each site keeps its own", function* () {
    const seen = record();
    yield* run("<Probe />\n\n<Probe />\n", [probe(seen)], function* () {
      yield* Component.around({
        *importComponent([name], next) {
          const definition = yield* next(name);
          if (name !== "Probe" || definition.kind !== "function") {
            return definition;
          }
          const original = definition.fn;
          if (typeof original !== "function") {
            return definition;
          }
          return {
            ...definition,
            *fn(props: Record<string, Json>, invocation: ComponentInvocation) {
              // Ordinary delegation, and it stays supported.
              return yield* original(props, invocation);
            },
          };
        },
      });
    });

    expect(seen.refusals).toEqual([]);
    expect(seen.taken).toHaveLength(2);
    expect(new Set(seen.taken).size).toBe(2);
  });

  it("CIV6: a live ancestor's issuance cannot be spent inside its content", function* () {
    const seen = record();
    let parent: ComponentInvocation | undefined;
    // One `<Probe>` inside another: the same component, the same domain, so the
    // projection is the only thing that can refuse the nested claim.
    yield* run("<Probe>\n<Probe />\n</Probe>\n", [probe(seen)], function* () {
      yield* Component.around({
        *importComponent([name], next) {
          const definition = yield* next(name);
          if (name !== "Probe" || definition.kind !== "function") {
            return definition;
          }
          const original = definition.fn;
          if (typeof original !== "function") {
            return definition;
          }
          return {
            ...definition,
            *fn(props: Record<string, Json>, invocation: ComponentInvocation) {
              if (parent === undefined) {
                parent = invocation;
                return yield* original(props, invocation);
              }
              return yield* original(props, parent);
            },
          };
        },
      });
    });

    // The outer element named itself before it projected. The nested claim was
    // refused rather than answered with the ancestor's identity.
    expect(seen.taken).toHaveLength(1);
    expect(seen.refusals).toHaveLength(1);
    expect(seen.refusals[0]).toContain("expanding its own content");
  });

  it("CIV7: an issuance kept from the first site cannot be spent at the second", function* () {
    const seen = record();
    let kept: ComponentInvocation | undefined;
    yield* run("<Probe />\n\n<Probe />\n", [probe(seen)], function* () {
      yield* Component.around({
        *importComponent([name], next) {
          const definition = yield* next(name);
          if (name !== "Probe" || definition.kind !== "function") {
            return definition;
          }
          const original = definition.fn;
          if (typeof original !== "function") {
            return definition;
          }
          return {
            ...definition,
            *fn(props: Record<string, Json>, invocation: ComponentInvocation) {
              if (kept === undefined) {
                kept = invocation;
                return yield* original(props, invocation);
              }
              // The first site's issuance, routed at the second.
              return yield* original(props, kept);
            },
          };
        },
      });
    });

    expect(seen.taken).toHaveLength(1);
    expect(seen.refusals).toHaveLength(1);
    expect(seen.refusals[0]).toMatch(/already been taken|has finished|another invocation/);
  });

  it("CIV8: an implementation kept from one component names nothing at another", function* () {
    const seen = record();
    let kept: unknown;
    // Two components, each declared with a domain of its own, so a refusal here
    // is a mismatch rather than an absence.
    yield* run(
      "<Probe />\n\n<Elsewhere />\n",
      [probe(seen), probe(seen, "Elsewhere")],
      function* () {
        yield* Component.around({
          *importComponent([name], next) {
            const definition = yield* next(name);
            if (definition.kind !== "function") {
              return definition;
            }
            const original = definition.fn;
            if (typeof original !== "function") {
              return definition;
            }
            if (name === "Probe") {
              kept = original;
              return definition;
            }
            if (name !== "Elsewhere") {
              return definition;
            }
            return {
              ...definition,
              *fn(props: Record<string, Json>, invocation: ComponentInvocation) {
                const borrowed = kept;
                return typeof borrowed === "function"
                  ? yield* borrowed(props, invocation)
                  : yield* original(props, invocation);
              },
            };
          },
        });
      },
    );

    // `<Probe />` named itself; `<Elsewhere />` refused rather than admitting
    // `<Probe>`'s work under its identity.
    expect(seen.taken).toHaveLength(1);
    expect(seen.refusals).toHaveLength(1);
    expect(seen.refusals[0]).toContain("this claimant answers for <Probe />");
  });

  it("CIV9: an implementation kept from one execution names nothing in another", function* () {
    const first = record();
    const second = record();
    let kept: unknown;

    // Two executions, each declaring `<Probe />` and each minting its own
    // domain — what two live attachments are.
    yield* run("<Probe />\n", [probe(first)], function* () {
      yield* Component.around({
        *importComponent([name], next) {
          const definition = yield* next(name);
          if (name === "Probe" && definition.kind === "function") {
            kept = definition.fn;
          }
          return definition;
        },
      });
    });
    expect(first.taken).toHaveLength(1);

    yield* run("<Probe />\n", [probe(second)], function* () {
      yield* Component.around({
        *importComponent([name], next) {
          const definition = yield* next(name);
          if (name !== "Probe" || definition.kind !== "function") {
            return definition;
          }
          const original = definition.fn;
          if (typeof original !== "function") {
            return definition;
          }
          return {
            ...definition,
            *fn(props: Record<string, Json>, invocation: ComponentInvocation) {
              const borrowed = kept;
              // The first execution's implementation, at this execution's own
              // `<Probe />`, with the genuine issuance minted here.
              return typeof borrowed === "function"
                ? yield* borrowed(props, invocation)
                : yield* original(props, invocation);
            },
          };
        },
      });
    });

    // The borrowed implementation belongs to the first execution, so what it
    // recorded went there: it refused, and the second execution's own probe
    // never ran, so nothing was named in either.
    expect(first.refusals).toHaveLength(1);
    // Its own execution is over, so its claimant answers for nothing at all.
    expect(first.refusals[0]).toContain("is not running this");
    expect(first.taken).toHaveLength(1);
    expect(second.taken).toEqual([]);
  });

  it("CIV10: a registration's whole record, transplanted, carries no identity", function* () {
    const first = record();
    const second = record();
    let kept: unknown;
    let entry: RegistryEntry | undefined;

    yield* run("<Probe />\n", [probe(first)], function* () {
      yield* Component.around({
        *importComponent([name], next) {
          const definition = yield* next(name);
          if (name === "Probe" && definition.kind === "function") {
            kept = definition.fn;
          }
          return definition;
        },
        registry: (_args, next): ComponentRegistry => {
          const answer = next();
          entry = answer.get("Probe") ?? entry;
          return answer;
        },
      });
    });
    expect(entry).not.toBe(undefined);

    yield* run("<Probe />\n", [probe(second)], function* () {
      yield* Component.around({
        // The first execution's whole registration record, answered for this
        // name here: not a field read out of it, the object itself.
        registry: (_args, next): ComponentRegistry => {
          const answer = next();
          return entry === undefined ? answer : new Map([...answer, ["Probe", entry]]);
        },
        *importComponent([name], next) {
          const definition = yield* next(name);
          if (name !== "Probe" || definition.kind !== "function") {
            return definition;
          }
          const original = definition.fn;
          if (typeof original !== "function") {
            return definition;
          }
          return {
            ...definition,
            *fn(props: Record<string, Json>, invocation: ComponentInvocation) {
              const borrowed = kept;
              return typeof borrowed === "function"
                ? yield* borrowed(props, invocation)
                : yield* original(props, invocation);
            },
          };
        },
      });
    });

    // Same again, with the record itself transplanted: the second execution
    // resolved `<Probe />` to the first execution's registration entirely, and
    // still nothing was named here.
    expect(first.refusals).toHaveLength(1);
    expect(second.taken).toEqual([]);
    expect(second.refusals).toEqual([]);
  });

  it("CIV11: a nested registration of the same name borrows nothing", function* () {
    const seen = record();
    let kept: unknown;
    let shadowed: RegistryEntry | undefined;
    const nested: string[] = [];
    // The authored structure is the fixture's: the declared site first, then
    // `<Nest><Probe /></Nest>`. The harness only installs the adversary — it
    // retains the declared implementation at the first site's own resolution,
    // then registers the name again so the nested site resolves to that
    // registration, and runs what it retained there with the nested site's own
    // genuine invocation.
    const source = yield* readTextFile(
      fileURLToPath(
        new URL("./fixtures/invocation-identity/nested-registration.md", import.meta.url),
      ),
    );
    yield* run(source, [probe(seen)], function* () {
      yield* registerComponents([
        {
          name: "Nest",
          origin: "test://nest",
          props: NO_PROPS,
          *fn(): Operation<string> {
            return yield* content();
          },
        },
      ]);
      yield* Component.around({
        // The nested registration, once the declared implementation is in hand.
        registry: (_args, next): ComponentRegistry => {
          const answer = next();
          return shadowed === undefined ? answer : new Map([...answer, ["Probe", shadowed]]);
        },
        *importComponent([name], next) {
          const definition = yield* next(name);
          if (name !== "Probe" || definition.kind !== "function") {
            return definition;
          }
          if (kept === undefined) {
            kept = definition.fn;
            // Registered again under the same name, so canonical resolution
            // stops selecting the execution's own component for it.
            shadowed = {
              default: {
                definition: {
                  kind: "function",
                  name: "Probe",
                  props: NO_PROPS,
                  // deno-lint-ignore require-yield
                  *fn(): Operation<string> {
                    nested.push("the nested registration ran");
                    return "";
                  },
                },
                origin: "test://nested-probe",
              },
            };
            return definition;
          }
          return {
            ...definition,
            *fn(props: Record<string, Json>, invocation: ComponentInvocation) {
              const borrowed = kept;
              if (typeof borrowed !== "function") {
                nested.push("nothing retained");
                return "";
              }
              return yield* borrowed(props, invocation);
            },
          };
        },
      });
    });

    // The declared site named itself. The nested site ran the retained
    // implementation with its own genuine invocation and named nothing:
    // canonical resolution selected the nested registration there, so that
    // invocation is in no domain. Restoring identity by authored-name equality
    // would put a second identity in `taken` and fail this.
    expect(seen.taken).toHaveLength(1);
    expect(nested).toEqual([]);
    expect(seen.refusals).toHaveLength(1);
    expect(seen.refusals[0]).toContain("this claimant answers for <Probe />");
  });

  it("CIV12: another live invocation's issuance names nothing in this frame", function* () {
    // At the seam, because the engine expands one element at a time: two
    // invocations of one component, both live, both unspent, neither
    // projecting, in the two frames the engine would have invoked them in. The
    // only thing telling them apart is the frame, which is what this states.
    const { claim, domain } = yield* seam();

    const refusals: string[] = [];
    const taken: string[] = [];
    yield* scoped(function* () {
      // One invocation's frame, and its issuance.
      const first = issueInvocation("first", "Both", domain, yield* useScope(), false);
      yield* scoped(function* () {
        // A second, live at the same moment, in a frame of its own.
        const second = issueInvocation("second", "Both", domain, yield* useScope(), false);
        try {
          taken.push(yield* claim(second.invocation));
        } catch (error) {
          refusals.push(error instanceof Error ? error.message : String(error));
        }
        try {
          // The first invocation's issuance, claimed from the second's frame.
          taken.push(yield* claim(first.invocation));
        } catch (error) {
          refusals.push(error instanceof Error ? error.message : String(error));
        }
      });
      first.close();
    });

    // The frame's own issuance answered; the other one, live and unspent, did
    // not — so two invocations cannot arrive at one durable name.
    expect(taken).toEqual(["second"]);
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toContain("another invocation of the same component");
  });

  it("CIV14: a finished invocation's issuance names nothing, even in its own frame", function* () {
    const { claim, domain } = yield* seam();
    let refusal: string | undefined;
    yield* scoped(function* () {
      const issued = issueInvocation("done", "Both", domain, yield* useScope(), true);
      // The engine ends an issuance when the body returns, however it left.
      issued.close();
      try {
        yield* claim(issued.invocation);
      } catch (error) {
        refusal = error instanceof Error ? error.message : String(error);
      }
    });
    expect(refusal).toContain("this invocation has finished");
  });

  it("CIV15: one invocation names one durable operation", function* () {
    const { claim, domain } = yield* seam();
    const taken: string[] = [];
    let refusal: string | undefined;
    yield* scoped(function* () {
      const issued = issueInvocation("once", "Both", domain, yield* useScope(), true);
      taken.push(yield* claim(issued.invocation));
      try {
        // The same issuance, in the same frame, a second time.
        yield* claim(issued.invocation);
      } catch (error) {
        refusal = error instanceof Error ? error.message : String(error);
      }
    });
    expect(taken).toEqual(["once"]);
    expect(refusal).toContain("already been taken");
  });

  /**
   * Two sites, and an adversary at the second.
   *
   * The first resolves honestly, so the declared implementation is in hand;
   * `answer` decides what canonical resolution does at the second, and what the
   * engine is handed there. Whatever runs at that site runs with the genuine
   * invocation the engine minted for it.
   */
  function twoSites(
    seen: Seen,
    answer: (
      next: (name: string) => Operation<ComponentDefinition | FunctionComponentDefinition>,
      kept: FunctionComponent,
    ) => Operation<ComponentDefinition | FunctionComponentDefinition>,
  ): Operation<void> {
    let kept: FunctionComponent | undefined;
    // `<Elsewhere />` is declared as well, so a handler redirecting the name has
    // a real registration to redirect to.
    return run("<Probe />\n\n<Probe />\n", [probe(seen), probe(seen, "Elsewhere")], function* () {
      yield* Component.around({
        *importComponent([name], next) {
          if (name !== "Probe") {
            return yield* next(name);
          }
          if (kept === undefined) {
            const definition = yield* next(name);
            if (definition.kind === "function" && typeof definition.fn === "function") {
              kept = definition.fn;
            }
            return definition;
          }
          return yield* answer(next, kept);
        },
      });
    });
  }

  it("CIV16: an import nobody delegated selects nothing, so it names nothing", function* () {
    const seen = record();
    // Answered without delegating: canonical resolution never ran for this
    // site, so there is nothing for the frame to have selected.
    // deno-lint-ignore require-yield
    yield* twoSites(seen, function* (_next, kept) {
      return { kind: "function", name: "Probe", props: NO_PROPS, fn: kept };
    });

    expect(seen.taken).toHaveLength(1);
    expect(seen.refusals).toHaveLength(1);
    expect(seen.refusals[0]).toContain("this claimant answers for <Probe />");
  });

  it("CIV17: a redirected name selects nothing for the name the engine asked", function* () {
    const seen = record();
    yield* twoSites(seen, function* (next, kept) {
      // Delegated, but for a different name, and answered with what that name
      // resolved to: canonical resolution selected a registration this element
      // never named, and the implementation running here is that one's.
      const other = yield* next("Elsewhere");
      const redirected =
        other.kind === "function" && typeof other.fn === "function" ? other.fn : kept;
      return { kind: "function", name: "Probe", props: NO_PROPS, fn: redirected };
    });

    // `<Elsewhere />`'s implementation ran at a `<Probe />` site and named
    // nothing: the frame settles only for the name the engine asked.
    expect(seen.taken).toHaveLength(1);
    expect(seen.refusals).toHaveLength(1);
    expect(seen.refusals[0]).toContain("this claimant answers for <Elsewhere />");
  });

  it("CIV18: two canonical selections in one import settle to nothing", function* () {
    const seen = record();
    yield* twoSites(seen, function* (next, kept) {
      // Delegated twice. Which of the two answers the engine was handed is not
      // a question the frame can settle, so it settles to nothing.
      yield* next("Probe");
      const again = yield* next("Probe");
      void again;
      return { kind: "function", name: "Probe", props: NO_PROPS, fn: kept };
    });

    expect(seen.taken).toHaveLength(1);
    expect(seen.refusals).toHaveLength(1);
  });

  it("CIV13: a refused registration leaves a claimant that answers for nothing", function* () {
    const seen = record();
    let refusal: string | undefined;
    // `as` is the engine's own prop, so declaring it as a capture is refused
    // where the registration is validated — after the factory was called with
    // this execution's claimant and before anything activated it.
    const invalid: IdentityComponent = {
      ...probe(seen),
      captures: ["as"],
    };
    try {
      yield* run("<Probe />\n", [invalid], nothing);
    } catch (error) {
      refusal = error instanceof Error ? error.message : String(error);
    }
    expect(refusal).toContain("as");
    expect(seen.taken).toEqual([]);
  });
});

/**
 * Tier CIV — the authored form the engine issues with an invocation
 * (specs/executable-mdx-spec.md §5.6).
 *
 * How the element was written is a fact about the invocation, not about the
 * surroundings it runs in. It travels on the object the engine minted, so a
 * component choosing an effect from it — read a file or write over it — is not
 * choosing from an answer the composable chain produced.
 *
 * These prove the fact itself: what it reports for each authored form, that
 * reading it costs nothing, and that it cannot be recovered from anywhere else.
 */
describe("Tier CIV — the import's own terminal is the association", () => {
  it("CIV26: a handler that delegates through a descendant scope keeps the identity", function* () {
    // Ordinary middleware, delegating the same name once — in a scope of its
    // own, which the Api allows and which nothing about an import forbids. The
    // terminal `next` reaches is the one this import created, so the invocation
    // is still in its execution's domain.
    const seen = record();
    yield* run("<Probe />\n", [probe(seen)], function* () {
      yield* Component.around(
        {
          *importComponent([name, position], next) {
            return yield* scoped(() => next(name, position));
          },
        },
        { at: "max" },
      );
    });

    expect(seen.refusals).toEqual([]);
    expect(seen.taken).toHaveLength(1);

    // And it is the same identity the undelegated import names, because the
    // identity is the authored element's and the delegation changed nothing
    // about which element asked.
    const direct = record();
    yield* run("<Probe />\n", [probe(direct)]);
    expect(seen.taken).toEqual(direct.taken);
  });

  it("CIV26: nested imports shadow and restore, each through its own terminal", function* () {
    // The outer probe expands a body that imports the inner one, so two imports
    // are open at once in one scope. Each dispatch owns its terminal, so neither
    // needs a stack to find its own frame.
    const seen = record();
    yield* run("<Outer>\n<Probe />\n</Outer>\n", [probe(seen, "Outer"), probe(seen, "Probe")]);

    expect(seen.refusals).toEqual([]);
    expect(seen.taken).toHaveLength(2);
    expect(new Set(seen.taken).size).toBe(2);
  });

  it("CIV26: delegating twice, or delegating another name, names nothing", function* () {
    // Each of these reaches this import's terminal — that is not the failure.
    // What fails is what the frame then holds: two selections, or one for a
    // component the element never wrote.
    const ways: readonly ("twice" | "another name")[] = ["twice", "another name"];
    for (const what of ways) {
      const seen = record();
      yield* run("<Probe />\n", [probe(seen), probe(seen, "Other")], function* () {
        yield* Component.around(
          {
            *importComponent([name, position], next) {
              // Only the element's own import. The root is imported through the
              // same operation, and redirecting that is a different mistake.
              if (name !== "Probe") {
                return yield* next(name, position);
              }
              if (what === "twice") {
                yield* next(name, position);
                return yield* next(name, position);
              }
              return yield* next("Other", position);
            },
          },
          { at: "max" },
        );
      });

      expect([what, seen.taken]).toEqual([what, []]);
      expect([what, seen.refusals]).toHaveLength(2);
    }
  });

  it("CIV29: a foreign copy's nested import resolves, and is nobody's delegation", function* () {
    // A handler starts an import of its own while the authored import is still
    // open, through a descriptor carrying the same stable Api name whose terminal
    // belongs to another copy of core — what `--include` and a middleware package
    // holding its own copy produce. That terminal's "nothing answered this"
    // report is not this copy's class, so an execution recognizing it by class
    // would propagate the failure instead of resolving the nested import at all.
    const foreign = foreignTerminalReport("Other");
    expect(foreign).not.toBeInstanceOf(MissingImportProvider);

    const seen = record();
    const nested: string[] = [];
    yield* run("<Probe />\n", [probe(seen), probe(seen, "Other")], function* () {
      yield* Component.around(
        {
          *importComponent([name, position], next) {
            if (name !== "Probe") {
              return yield* next(name, position);
            }
            const answered = yield* importThroughTerminal(
              "Other",
              position,
              // deno-lint-ignore require-yield
              function* (asked: string) {
                throw foreignTerminalReport(asked);
              },
            );
            nested.push(`${answered.kind}:${answered.name}`);
            return yield* next(name, position);
          },
        },
        { at: "max" },
      );
    });

    // The nested import was answered by this execution's ordinary resolution,
    // with this execution's own implementation of that component.
    expect(nested).toEqual(["function:Other"]);
    // And the element that was authored is the one holding an identity: a
    // separate import is not a delegation of it, however either one resolved.
    expect(seen.refusals).toEqual([]);
    expect(seen.taken).toHaveLength(1);
    const direct = record();
    yield* run("<Probe />\n", [probe(direct)]);
    expect(seen.taken).toEqual(direct.taken);
  });

  /**
   * Reports that carry the mark and are still not this call's: one about another
   * import, and one whose payload only *looks* like the single member the mark
   * is. Each names the fragment its failure has to reach the document with.
   */
  const NOT_THIS_CALL: ReadonlyArray<{
    what: string;
    report: (asked: string) => Error;
    says: string;
  }> = [
    {
      what: "a report about another import",
      report: () => foreignTerminalReport("Elsewhere"),
      says: "Elsewhere",
    },
    {
      what: "a mark carrying hidden members",
      report: (asked: string) => hiddenMemberReport(asked),
      says: "Other",
    },
  ];

  for (const { what, report, says } of NOT_THIS_CALL) {
    it(`CIV29: ${what} is somebody else's failure`, function* () {
      // The same arrangement, with the foreign terminal raising something that
      // carries the mark without being this call's report of it. Ordinary
      // resolution answers imports nothing answered, not unrelated failures, so
      // these propagate — and the element that asked says so rather than quietly
      // resolving something nobody asked for.
      const seen = record();
      let failure = "";
      try {
        yield* run("<Probe />\n", [probe(seen), probe(seen, "Other")], function* () {
          yield* Component.around(
            {
              *importComponent([name, position], next) {
                if (name !== "Probe") {
                  return yield* next(name, position);
                }
                return yield* importThroughTerminal(
                  "Other",
                  position,
                  // deno-lint-ignore require-yield
                  function* (asked: string) {
                    throw report(asked);
                  },
                );
              },
            },
            { at: "max" },
          );
        });
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
      }

      expect([what, failure.includes(says)]).toEqual([what, true]);
      expect([what, seen.taken]).toEqual([what, []]);
    });
  }
});

/**
 * How long a signal that a correct engine publishes immediately may go
 * unpublished before the wait is called a deadlock.
 *
 * Never reached by a passing run: every barrier below is opened by the imports
 * that arrive at it. An engine that could not hold two imports at once would
 * otherwise hang the suite instead of saying what went wrong.
 */
const DEADLOCK_MS = 10_000;

/** Wait for one signal, reporting a deadlock rather than hanging on one. */
function* awaiting(what: string, waited: Operation<void>): Operation<void> {
  const reached = yield* race([
    (function* (): Operation<boolean> {
      yield* waited;
      return true;
    })(),
    (function* (): Operation<boolean> {
      yield* sleep(DEADLOCK_MS);
      return false;
    })(),
  ]);
  if (!reached) {
    throw new Error(`${what} never happened: the two imports did not run at the same time`);
  }
}

/**
 * Middleware that holds the import of each listed component until every one of
 * them is live, and then releases them in `order`.
 *
 * The rendezvous is inside `importComponent` deliberately. A document holds its
 * spawned children at barriers in their component *bodies*, which the import
 * has already finished by then — so two such children prove that the bodies
 * overlapped, not the imports. Only a wait inside the import itself puts two
 * imports in flight together, which is the one arrangement in which an import
 * could take a sibling's canonical selection.
 *
 * A name listed twice holds two separate sites of the same component: each
 * arrival takes the next slot that name still has free.
 */
function heldImports(names: readonly string[], order: readonly number[]): () => Operation<void> {
  const arrivals = names.map(() => withResolvers<void>());
  const releases = names.map(() => withResolvers<void>());
  const held = names.map(() => false);
  return function* () {
    yield* spawn(function* () {
      for (const [index, name] of names.entries()) {
        yield* awaiting(`the import of <${name}> starting`, arrivals[index].operation);
      }
      for (const index of order) {
        releases[index].resolve();
      }
    });
    yield* Component.around(
      {
        *importComponent([name, position], next) {
          const index = names.findIndex((listed, at) => listed === name && !held[at]);
          if (index < 0) {
            return yield* next(name, position);
          }
          held[index] = true;
          arrivals[index].resolve();
          yield* releases[index].operation;
          return yield* next(name, position);
        },
      },
      { at: "max" },
    );
  };
}

/**
 * One source file of core's own, read for what it declares.
 *
 * A boundary is a declaration, so the row about where the execution's import
 * resolution may live reads the declarations rather than a runtime object: an
 * object says what one execution happened to build, while the interface says what
 * every host's installation and every fragment's narrowed table are described
 * against.
 */
function sourceOf(file: string): Operation<string> {
  return readTextFile(fileURLToPath(new URL(`../${file}`, import.meta.url)));
}

/** The body of the `ExecutionEnvironment` declaration, as written. */
function* environmentDeclaration(): Operation<string> {
  const source = yield* sourceOf("src/execution-environment.ts");
  const opened = source.indexOf("export interface ExecutionEnvironment {");
  if (opened < 0) {
    throw new Error("ExecutionEnvironment is no longer declared where this row reads it");
  }
  const closed = source.indexOf("\n}\n", opened);
  if (closed < 0) {
    throw new Error("the ExecutionEnvironment declaration does not end");
  }
  return source.slice(opened, closed);
}

describe("Tier CIV — where the execution's import resolution lives", () => {
  it("CIV30: the environment boundary carries no import terminal", function* () {
    const declared = yield* environmentDeclaration();
    // Read as members rather than as text, so this is about what the interface
    // offers a holder and not about a word appearing in a comment.
    const members = [...declared.matchAll(/^ {2}(?:readonly )?([A-Za-z]+)\??[:(]/gm)].map(
      (match) => match[1],
    );
    // The row can see the boundary at all: it is the interface with the members
    // canonical execution hands expansion, and it still has them.
    expect(members).toContain("componentResolution");
    expect(members).toContain("componentIdentity");

    expect(members).not.toContain("canonicalImport");
    expect(members).not.toContain("resolveComponentImport");
    expect(members).not.toContain("importTerminal");
    // And no member of it accepts an import's own frame or answers with a
    // definition, whatever it might be called: that shape *is* an import
    // terminal, and naming it something else would not move it off the boundary.
    expect(declared).not.toContain("ImportSelection");
    expect(declared).not.toMatch(/=>\s*Operation<\s*\n?\s*ComponentDefinition/);
  });

  it("CIV30: the terminal reaches expansion by hand, and leaves no other way", function* () {
    const expansion = yield* sourceOf("src/expand.ts");
    // Declared where it is consumed, and carried as a required parameter beside
    // the environment: a recursion that dropped it would not compile, which is
    // what the CIV26–CIV29 rows depend on for every nested body, branch and
    // spawned child.
    expect(expansion).toContain("export type ComponentImportTerminal = (");
    expect(expansion).toContain("imports: ComponentImportTerminal | undefined,");
    // No contextual route to the same value: it is not published under a context
    // name and not the core of an Api, so nothing can read it by knowing a name.
    expect(expansion).not.toMatch(/createContext<[^>]*ComponentImportTerminal/);
    expect(expansion).not.toMatch(/createApi<[^>]*ComponentImportTerminal/);

    // And no package entry point re-exports the type or the identifier, so a
    // host, a middleware package and a repository component have no name for it.
    for (const entry of ["mod.ts", "api.ts", "host.ts"]) {
      const published = yield* sourceOf(entry);
      expect([entry, published.includes("ComponentImportTerminal")]).toEqual([entry, false]);
      expect([entry, published.includes("resolveComponentImport")]).toEqual([entry, false]);
    }
  });
});

describe("Tier CIV — two canonical imports live at the same time", () => {
  const CONCURRENT = [
    "<All>",
    "<Spawn><Probe /></Spawn>",
    "<Spawn><Probe /></Spawn>",
    "</All>",
    "",
  ].join("\n");

  const ORDERS: Array<[string, readonly number[]]> = [
    ["in arrival order", [0, 1]],
    ["in reverse", [1, 0]],
  ];

  for (const [what, order] of ORDERS) {
    it(`CIV27: each of two live imports selects into its own frame, released ${what}`, function* () {
      // Both spawned sites are inside their import before either resolves, so
      // the frames are open at the same time. Each dispatch reaches the
      // terminal it was created with, so neither selection can land in the
      // sibling's frame — and which import resolves first decides nothing.
      const seen = record();
      yield* run(CONCURRENT, [probe(seen)], heldImports(["Probe", "Probe"], order));

      expect(seen.refusals).toEqual([]);
      expect(seen.taken).toHaveLength(2);
      expect(new Set(seen.taken).size).toBe(2);

      // And they are the identities the same two sites name when nothing holds
      // their imports at all: overlapping changed the scheduling, not the
      // authored element either invocation belongs to.
      const direct = record();
      yield* run(CONCURRENT, [probe(direct)]);
      expect(new Set(seen.taken)).toEqual(new Set(direct.taken));
    });
  }

  it("CIV28: cancelling one live import closes only its own frame", function* () {
    // Three spawned children: one import is released and claims, a second is
    // still suspended inside its import when the third fails and `<All>` halts
    // it. The cancelled branch settles its own frame in `finally`, and there is
    // no execution-wide association for it to take the survivor's with it.
    const FIXTURE = [
      "<All>",
      "<Spawn><Probe /></Spawn>",
      "<Spawn><Other /></Spawn>",
      "<Spawn><Boom /></Spawn>",
      "</All>",
      "",
    ].join("\n");

    /** A probe that says when it has claimed, so the failure lands after it. */
    function claiming(seen: Seen, done: { resolve(value: void): void }): IdentityComponent {
      return {
        name: "Probe",
        origin: "test://probe",
        props: NO_PROPS,
        factory: (claim: IdentityClaimant) =>
          function* Probe(
            _props: Record<string, Json>,
            invocation: ComponentInvocation,
          ): Operation<string> {
            try {
              seen.taken.push(yield* claim(invocation));
            } catch (error) {
              seen.refusals.push(error instanceof Error ? error.message : String(error));
            }
            done.resolve();
            return "";
          },
      };
    }

    /** The sibling that decides the run's outcome once the survivor claimed. */
    function tripwire(waited: Operation<void>, outcome: "fails" | "finishes"): IdentityComponent {
      return {
        name: "Boom",
        origin: "test://boom",
        props: NO_PROPS,
        factory: () =>
          function* Boom(): Operation<string> {
            yield* awaiting("the surviving child claiming", waited);
            if (outcome === "fails") {
              throw new Error("BOOM");
            }
            return "";
          },
      };
    }

    const survived = record();
    const cancelled = record();
    const claimed = withResolvers<void>();
    let failure = "";
    try {
      yield* run(
        FIXTURE,
        [
          claiming(survived, claimed),
          probe(cancelled, "Other"),
          tripwire(claimed.operation, "fails"),
        ],
        // `<Other>` is listed but never released: its import is live when the
        // document fails under it.
        heldImports(["Probe", "Other"], [0]),
      );
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }

    expect(failure).toContain("BOOM");
    // The survivor claimed once and was refused nothing; the branch cancelled
    // inside its import claimed nothing at all.
    expect(survived.refusals).toEqual([]);
    expect(survived.taken).toHaveLength(1);
    expect(cancelled.taken).toEqual([]);

    // The same document, with the third child finishing instead of failing:
    // both siblings claim, and the survivor names exactly what it named while
    // its sibling was being torn down beside it. Nothing outlived that
    // teardown to lend or withhold an identity here.
    const quiet = record();
    const other = record();
    const finished = withResolvers<void>();
    yield* run(
      FIXTURE,
      [claiming(quiet, finished), probe(other, "Other"), tripwire(finished.operation, "finishes")],
      heldImports(["Probe", "Other"], [0, 1]),
    );

    expect(quiet.refusals).toEqual([]);
    expect(other.refusals).toEqual([]);
    expect(quiet.taken).toEqual(survived.taken);
    expect(other.taken).toHaveLength(1);
    expect(new Set([...quiet.taken, ...other.taken]).size).toBe(2);
  });
});

describe("Tier CIV — the authored form on the invocation", () => {
  const FORMS: Array<[string, string, boolean]> = [
    ["self-closing", "<Probe />\n", false],
    ["paired", "<Probe>written</Probe>\n", true],
    ["paired and empty", "<Probe></Probe>\n", true],
  ];

  for (const [what, source, expected] of FORMS) {
    it(`CIV19: a ${what} element reports its own form`, function* () {
      const seen = record();
      yield* run(source, [probe(seen)]);

      expect(seen.authored).toEqual([expected]);
      // The engine's two accounts of the same element agree while nothing is
      // interfering, which is what makes the difference elsewhere a lie rather
      // than a disagreement.
      expect(seen.api).toEqual([expected]);
    });
  }

  it("CIV19: asking the form projects nothing and suspends on nothing", function* () {
    const ran: string[] = [];
    const seen = record();
    // A component that reads the form and returns without projecting. The
    // canary is its content, so anything the query expanded would be visible.
    const asking: IdentityComponent = {
      name: "Asking",
      origin: "test://asking",
      props: NO_PROPS,
      factory: (_claim: IdentityClaimant) =>
        // deno-lint-ignore require-yield
        function* Asking(
          _props: Record<string, Json>,
          invocation: ComponentInvocation,
        ): Operation<string> {
          seen.authored.push(invocation.hasContent());
          seen.authored.push(invocation.hasContent());
          return "";
        },
    };

    yield* run("<Asking>\n<Canary />\n</Asking>\n", [asking], function* () {
      yield* registerComponents([
        {
          name: "Canary",
          origin: "test://canary",
          props: NO_PROPS,
          // deno-lint-ignore require-yield
          *fn(): Operation<string> {
            ran.push("canary");
            return "";
          },
        },
      ]);
    });

    // Read twice, answered twice, and the content it was written with never
    // expanded: the query is a fact about the element, not a projection of it.
    expect(seen.authored).toEqual([true, true]);
    expect(ran).toEqual([]);
  });

  it("CIV20: reading the form leaves the durable identity unspent", function* () {
    const seen = record();
    const taking: IdentityComponent = {
      name: "Taking",
      origin: "test://taking",
      props: NO_PROPS,
      factory: (claim: IdentityClaimant) =>
        function* Taking(
          _props: Record<string, Json>,
          invocation: ComponentInvocation,
        ): Operation<string> {
          // Read first, and more than once: if the read spent anything, the
          // claim below would be the second take of one identity.
          seen.authored.push(invocation.hasContent());
          seen.authored.push(invocation.hasContent());
          try {
            seen.taken.push(yield* claim(invocation));
          } catch (error) {
            seen.refusals.push(error instanceof Error ? error.message : String(error));
          }
          return "";
        },
    };

    yield* run("<Taking />\n", [taking]);

    expect(seen.authored).toEqual([false, false]);
    expect(seen.refusals).toEqual([]);
    expect(seen.taken).toHaveLength(1);
  });

  it("CIV21: a component that imports nothing still reads the canonical form", function* () {
    const directory = fileURLToPath(new URL("./fixtures/invocation-identity/", import.meta.url));

    // A repository `.ts` component with no imports at all: no helper of its own
    // copy to ask, no context of its own copy to read, only the object the
    // engine handed it.
    const both = yield* rendered(
      "<LoadedForm />\n\n<LoadedForm>written</LoadedForm>\n",
      [],
      [directory],
    );

    expect(both).toContain("loaded:false");
    expect(both).toContain("loaded:true");
  });

  it("CIV21: the form is on the invocation and nowhere a name reaches", function* () {
    const seen = record();
    let reachable: string[] = [];

    yield* run("<Probe />\n", [probe(seen)], function* () {
      yield* Component.around({
        *importComponent([name, position], next) {
          const definition = yield* next(name, position);
          if (name === "Probe") {
            // What a handler holding the definition can see of the fact: the
            // definition carries none of it, because it is not a property of
            // the component.
            reachable = Reflect.ownKeys(definition).map(String);
          }
          return definition;
        },
      });
    });

    expect(seen.authored).toEqual([false]);
    expect(reachable).not.toContain("hasContent");
    expect(reachable).not.toContain("content");
  });

  // CIV22: what a dispatcher requires before it enters a form-specific body.
  //
  // The method on the object stays readable and stays honest, which is CIV21's
  // contract. What it is not is a permission: a component is handed whatever its
  // caller passes, and every check expressible against the shape is one a
  // forger satisfies by construction. So the dispatcher asks this copy of core
  // instead — the same private field a claim is recognized by — and also asks
  // that the issuance is live, is running in its own frame, and is the one
  // canonical resolution selected this dispatcher for.
  it("CIV22: only a selected dispatcher's own live invocation enters a form body", function* () {
    const entered: string[] = [];
    const refusals: string[] = [];
    const refuse = (_props: Record<string, Json>, form: string | undefined) =>
      new Error(`refused:${form ?? "no-invocation"}`);
    // deno-lint-ignore require-yield
    const dispatch = formDispatcher({
      forms: "self-closing",
      *fn(): Operation<string> {
        entered.push("body");
        return "";
      },
      refuse,
    });

    function* attempt(invocation: ComponentInvocation): Operation<void> {
      try {
        yield* dispatch({}, invocation);
      } catch (error) {
        refusals.push(error instanceof Error ? error.message : String(error));
      }
    }

    const frame = yield* useScope();
    const issued = issueInvocation("e1", "Probing", undefined, frame, false, dispatch);

    // The genuine, selected, live, self-closing case is the only one that runs.
    yield* attempt(issued.invocation);
    expect(entered).toEqual(["body"]);
    expect(refusals).toEqual([]);
    // And the method it carries still answers, for anyone observing rather than
    // selecting an effect.
    expect(issued.invocation.hasContent()).toBe(false);

    // A structural look-alike carrying the whole public shape.
    const lookAlike: ComponentInvocation = {
      hasContent() {
        return false;
      },
    };
    expect(lookAlike.hasContent()).toBe(false);
    yield* attempt(lookAlike);

    // A genuine invocation canonical resolution selected nothing for.
    const unselected = issueInvocation("e2", "Probing", undefined, frame, false);
    yield* attempt(unselected.invocation);

    // A genuine invocation selected for a different dispatcher.
    // deno-lint-ignore require-yield
    const other = formDispatcher({
      forms: "either",
      *fn(): Operation<string> {
        return "";
      },
    });
    const elsewhere = issueInvocation("e3", "Probing", undefined, frame, false, other);
    yield* attempt(elsewhere.invocation);

    // And one whose issuance has ended.
    const finished = issueInvocation("e4", "Probing", undefined, frame, false, dispatch);
    finished.close();
    yield* attempt(finished.invocation);

    // None of the four reached the body, and each was refused as an invocation
    // that could not be established rather than as a form.
    expect(entered).toEqual(["body"]);
    expect(refusals).toEqual([
      "refused:no-invocation",
      "refused:no-invocation",
      "refused:no-invocation",
      "refused:no-invocation",
    ]);

    // The form it will not run is refused as a form, and still never enters.
    const paired = issueInvocation("e5", "Probing", undefined, frame, true, dispatch);
    yield* attempt(paired.invocation);
    expect(entered).toEqual(["body"]);
    expect(refusals.at(-1)).toEqual("refused:paired");
  });
});

/**
 * Tier PA10b — one declared component, two sibling spawns at once.
 *
 * `<All>` gives two `<Spawn>` children imports in flight together. What puts an
 * invocation in this execution's identity domain is the canonical selection
 * made inside the frame its own import opened — so these rows are the general
 * statement of the thing an ordinary `<Session>` in each spawn needs.
 *
 * They take the spawns as the engine schedules them. The rows that hold two
 * imports open *together*, by suspending inside the import itself, are CIV27
 * and CIV28 below.
 */
describe("Tier PA10b — concurrent capability-backed identity", () => {
  it("PA10b: two concurrent sites each claim their own identity, exactly once", function* () {
    const seen = record();
    yield* run(
      ["<All>", "<Spawn><Probe /></Spawn>", "<Spawn><Probe /></Spawn>", "</All>"].join("\n"),
      [probe(seen)],
      nothing,
    );

    // Both claimed, neither refused, and neither received the other's.
    expect(seen.refusals).toEqual([]);
    expect(seen.taken).toHaveLength(2);
    expect(new Set(seen.taken).size).toBe(2);
    // The engine's own identity for each invocation, which is what
    // `getExpansion()` reports when nothing has interfered.
    expect(seen.taken).toEqual(seen.context);
  });

  it("PA10b: a nested <All> inside a spawn claims its own identities too", function* () {
    const seen = record();
    yield* run(
      [
        "<All>",
        "<Spawn>",
        "<All>",
        "<Spawn><Probe /></Spawn>",
        "<Spawn><Probe /></Spawn>",
        "</All>",
        "</Spawn>",
        "<Spawn><Probe /></Spawn>",
        "</All>",
      ].join("\n"),
      [probe(seen)],
      nothing,
    );

    // Three sites, three identities, no refusal: a spawn nested inside a
    // spawn owns its own frames as much as a top-level one does.
    expect(seen.refusals).toEqual([]);
    expect(seen.taken).toHaveLength(3);
    expect(new Set(seen.taken).size).toBe(3);
    expect(seen.taken).toEqual(seen.context);
  });
});
