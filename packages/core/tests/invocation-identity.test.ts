/**
 * Tier CIV — the identity a trusted host's component names its work after
 * (specs/executable-mdx-spec.md §5.6).
 *
 * A component that names a durable operation after its own invocation is making
 * an authority claim: the name decides which retained record a replay restores,
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
import { createContext, scoped, useScope } from "effection";
import type { Context, Operation } from "effection";
import { collect, Component, content, inlineSource, registerComponents } from "../mod.ts";
import { executeInstalled } from "../host.ts";
import type { ExecutionInstallation, IdentityClaimant, IdentityComponent } from "../host.ts";
import { getExpansion } from "../src/expansion.ts";
import { installIdentities, issueInvocation } from "../src/invocation-identity.ts";
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
  /** Why a take was refused, when one was. */
  readonly refusals: string[];
}

function record(): Seen {
  return { taken: [], context: [], api: [], refusals: [] };
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
        const paired = yield* Component.operations.hasContent();
        seen.api.push(paired);
        return paired ? yield* content() : "";
      },
  };
}

/** One execution of `source`, with `components` declared to it. */
function run(
  source: string,
  components: readonly IdentityComponent[],
  install?: () => Operation<void>,
): Operation<void> {
  return scoped(function* () {
    const installation: ExecutionInstallation = {
      components,
      ...(install === undefined ? {} : { install }),
    };
    yield* collect(
      yield* executeInstalled({ ...inlineSource(source), stream: new InMemoryStream() }, [
        installation,
      ]),
    );
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
// deno-lint-ignore require-yield
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
  const frame = installed.identities.beginImport("Both");
  installed.identities.select("Both", {
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
              // give both sites one durable name.
              return yield* original(props, {});
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

  it("CIV10: a registration's whole record, transplanted, carries no authority", function* () {
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
    // invocation is in no domain. Restoring authority by authored-name equality
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
      const first = issueInvocation("first", "Both", domain, yield* useScope());
      yield* scoped(function* () {
        // A second, live at the same moment, in a frame of its own.
        const second = issueInvocation("second", "Both", domain, yield* useScope());
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
      const issued = issueInvocation("done", "Both", domain, yield* useScope());
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
      const issued = issueInvocation("once", "Both", domain, yield* useScope());
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
