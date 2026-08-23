/**
 * Tier CIV — the invocation the engine hands a component
 * (specs/executable-mdx-spec.md §5.6).
 *
 * A component that names a durable operation after itself is making an authority
 * claim: the name decides which retained record a replay restores, so two sites
 * sharing one name each replay the other's work. Code Rule 15 says durable
 * identity never trusts replaceable state, and this is where that is measured
 * rather than asserted.
 *
 * Every channel a component could *read* an identity from is replaceable, and
 * two of these demonstrate one being replaced. What is not replaceable is the
 * capability the engine mints for the invocation it entered: `importComponent`
 * middleware may forward the genuine one it was handed, but it cannot build one,
 * and it cannot supply one invocation's to another — including a live one it
 * captured from a content-bearing ancestor, which is unspent and unfinished for
 * as long as its descendants are running.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { createContext, scoped } from "effection";
import type { Context, Operation } from "effection";
import { collect, Component, content, execute, inlineSource, registerComponents } from "../mod.ts";
import { componentClaim, durableIdentityOf } from "../host.ts";
import { getExpansion } from "../src/expansion.ts";
import type { ComponentClaim, ComponentInvocation, FunctionComponent, Json } from "../src/types.ts";
import { InMemoryStream } from "@executablemd/durable-streams";

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

/** What `<Probe>` names its identities in. One implementation, one domain. */
const PROBE_CLAIM: ComponentClaim = componentClaim();

function useProbe(): Operation<Seen> {
  const seen: Seen = { taken: [], context: [], api: [], refusals: [] };
  return {
    *[Symbol.iterator]() {
      yield* registerComponents([
        {
          // Self-closing, registered on its own terms, and naming nothing
          // durable: it exists to be somewhere else for the wrapper to call
          // from.
          name: "Elsewhere",
          origin: "test://elsewhere",
          props: { type: "object", properties: {}, additionalProperties: false },
          // deno-lint-ignore require-yield
          *fn(): Operation<string> {
            return "";
          },
        },
        {
          // A content-bearing parent: its own invocation stays open — live and
          // unspent — for as long as the content it projects is running.
          name: "Around",
          origin: "test://around",
          // The same domain as `<Probe>`, deliberately: two components one host
          // registered together. The claim domain therefore settles nothing
          // here, and what refuses the nested claim is that this element is
          // expanding its content.
          claim: PROBE_CLAIM,
          props: { type: "object", properties: {}, additionalProperties: false },
          *fn(): Operation<string> {
            return yield* content();
          },
        },
        {
          name: "Probe",
          origin: "test://probe",
          claim: PROBE_CLAIM,
          props: { type: "object", properties: {}, additionalProperties: false },
          *fn(_props: Record<string, Json>, invocation: ComponentInvocation): Operation<string> {
            try {
              seen.taken.push(durableIdentityOf(invocation, PROBE_CLAIM));
            } catch (error) {
              seen.refusals.push(error instanceof Error ? error.message : String(error));
            }
            seen.context.push((yield* getExpansion()).id);
            seen.api.push(yield* Component.operations.hasContent());
            return "";
          },
        },
      ]);
      return seen;
    },
  };
}

function run(source: string, install: () => Operation<void>): Operation<Seen> {
  return scoped(function* () {
    const seen = yield* useProbe();
    yield* install();
    yield* collect(yield* execute({ ...inlineSource(source), stream: new InMemoryStream() }));
    return seen;
  });
}

// deno-lint-ignore require-yield
function* nothing(): Operation<void> {}

describe("Tier CIV — the invocation the engine hands a component", () => {
  it("CIV1: two sites are handed two identities", function* () {
    const seen = yield* run("<Probe />\n\n<Probe />\n", nothing);
    expect(seen.taken).toHaveLength(2);
    expect(new Set(seen.taken).size).toBe(2);
    // The engine's own identity for that invocation, which is what
    // `getExpansion()` reports when nobody has interfered.
    expect(seen.taken).toEqual(seen.context);
  });

  it("CIV2: a contextual Api answer is replaceable, so a durable name may not come from one", function* () {
    // `hasContent()` stands for every Component Api answer: a handler installed
    // outside the invocation answers ahead of the engine's own.
    const seen = yield* run("<Probe />\n", function* () {
      yield* Component.around({
        // deno-lint-ignore require-yield
        *hasContent(_args, _next) {
          return true;
        },
      });
    });
    // The element is self-closing, so the engine's own answer is `false`.
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

  it("CIV4: importComponent middleware cannot mint an invocation", function* () {
    // The public import seam: middleware delegates, receives the registered
    // definition, and returns a wrapper that calls the original with an object
    // of its own. A structural identity would be minted here.
    const seen = yield* run("<Probe />\n\n<Probe />\n", function* () {
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
              return yield* original(props, {});
            },
          };
        },
      });
    });

    // Nothing was minted: both sites refused, and neither took an identity.
    expect(seen.taken).toEqual([]);
    expect(seen.refusals).toHaveLength(2);
    for (const refusal of seen.refusals) {
      expect(refusal).toContain("not an invocation the engine issued");
    }
  });

  it("CIV5: middleware may forward the genuine issuance, and each site keeps its own", function* () {
    const seen = yield* run("<Probe />\n\n<Probe />\n", function* () {
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
    let parent: ComponentInvocation | undefined;
    const seen = yield* run("<Around>\n<Probe />\n</Around>\n", function* () {
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
          if (name === "Around") {
            return {
              ...definition,
              *fn(props: Record<string, Json>, invocation: ComponentInvocation) {
                // Captured here and still live below: the parent has not
                // returned, so nothing about this issuance has expired.
                parent = invocation;
                return yield* original(props, invocation);
              },
            };
          }
          if (name !== "Probe") {
            return definition;
          }
          return {
            ...definition,
            *fn(props: Record<string, Json>, invocation: ComponentInvocation) {
              return yield* original(props, parent ?? invocation);
            },
          };
        },
      });
    });

    // The nested claim is refused, and the parent's identity is not handed out
    // a second time under it.
    expect(seen.taken).toEqual([]);
    expect(seen.refusals).toHaveLength(1);
    expect(seen.refusals[0]).toContain("expanding its own content");
  });

  it("CIV7: an implementation kept from one component names nothing at another", function* () {
    // The definition `importComponent` handed out at the real `<Probe />` site,
    // kept and called from an invocation of something else.
    let kept: FunctionComponent | undefined;
    const seen = yield* run("<Probe />\n\n<Elsewhere />\n", function* () {
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
              // `<Elsewhere />`'s own issuance: genuine, live, unspent, and
              // projecting nothing. Every other check passes.
              return yield* (kept ?? original)(props, invocation);
            },
          };
        },
      });
    });

    // The real site named itself. The other one refused rather than admitting
    // `<Probe>`'s work under `<Elsewhere />`'s identity.
    expect(seen.taken).toHaveLength(1);
    expect(seen.refusals).toHaveLength(1);
    expect(seen.refusals[0]).toContain("invocation of something else");
  });

  it("CIV8: an issuance kept from the first site cannot be spent at the second", function* () {
    let kept: ComponentInvocation | undefined;
    const seen = yield* run("<Probe />\n\n<Probe />\n", function* () {
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

    // The first site took its own identity; the second was refused rather than
    // handed the first one again.
    expect(seen.taken).toHaveLength(1);
    expect(seen.refusals).toHaveLength(1);
    expect(seen.refusals[0]).toMatch(/already been taken|has finished/);
  });
});
