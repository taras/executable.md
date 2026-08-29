/**
 * The registry a host's identity declarations make, for the paths that describe
 * a document rather than run one.
 *
 * Syntax inspection and document validation both answer for an environment the
 * host declared but no execution ever opened. They resolve against the same
 * entries, built here once, so the two cannot disagree about what a declared
 * name means or about which tier it wins on.
 */

import type { Operation } from "effection";

import { documentationOf } from "./documentation.ts";
import type { IdentityComponent } from "../invocation-identity.ts";
import type { ComponentRegistry, FunctionComponentDefinition, RegistryEntry } from "../types.ts";

/**
 * The identity declarations a host would make, as registry entries selection
 * can decide against.
 *
 * The implementation slot holds a refusal rather than what the factory would
 * build, because building it is the authority this has none of: the factory
 * takes an execution's claimant, and there is no execution here. Nothing that
 * only describes a document reaches an implementation, so the refusal is
 * unreachable — it is there so that anything which ever did would fail loudly
 * rather than run a component with no execution behind it.
 */
export function declaredRegistry(components: readonly IdentityComponent[]): ComponentRegistry {
  const entries = new Map<string, RegistryEntry>();
  for (const component of components) {
    const definition: FunctionComponentDefinition = {
      kind: "function",
      name: component.name,
      props: component.props,
      ...(component.returns === undefined ? {} : { returns: component.returns }),
      ...(component.captures === undefined ? {} : { captures: component.captures }),
      ...(component.forms === undefined ? {} : { forms: component.forms }),
      ...documentationOf(component),
      fn: uninvocable,
    };
    entries.set(component.name, { default: { definition, origin: component.origin } });
  }
  return entries;
}

// deno-lint-ignore require-yield
function* uninvocable(): Operation<never> {
  throw new Error(
    "this component was described rather than executed, so it has no implementation to run",
  );
}
