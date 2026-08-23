/**
 * Scope-local component registration (spec §5.3).
 *
 * A host or a package makes components resolvable by name for the current scope
 * and its descendants. Registration is not a global map: a child scope may add
 * to what it inherited without changing it, siblings never see one another's
 * registrations, and leaving the installing scope removes them.
 *
 * Registration describes a component; it does not run one. Names and schemas
 * are checked when they are installed, so a malformed registration is a mistake
 * in the host — an ordinary thrown error — rather than a printed error that
 * surfaces in a document the first time the name is written.
 */

import { createContext } from "effection";
import type { Context, Operation } from "effection";
import { Component } from "../component-api.ts";
import { updateOwn } from "../scope-local.ts";
import { RESERVED_STRUCTURAL } from "../structural.ts";
import { compilePropsSchema, compileReturnsSchema } from "../validate.ts";
import type {
  ComponentRegistry,
  FunctionComponent,
  FunctionComponentDefinition,
  PropsSchema,
  RegistryEntry,
  ReturnsSchema,
} from "../types.ts";
import type { TestHarnessComponentDefinition } from "../test-harness.ts";

/**
 * A malformed registration: an unusable name or schema, or two registrations
 * competing for one name at the same scope.
 *
 * A plain `Error`, like `PropsSchemaError` — not a `DocumentationError`, which
 * means "the ambient error mode has already failed this document" and is rethrown
 * by every generic catch.
 */
export class ComponentRegistrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ComponentRegistrationError";
  }
}

export interface ComponentRegistration {
  /** The name a document writes. Dots address a subdirectory, as paths do. */
  name: string;
  /** Stable, human-readable source identity — reported by inspection. */
  origin: string;
  props: PropsSchema;
  /**
   * Props the engine does not resolve. The component evaluates each itself,
   * when and if it wants to, so the value reaches it by reference — no JSON
   * gate, no clone, no identity lost. For operands a schema cannot describe.
   */
  captures?: readonly string[];
  /**
   * Whether replacement would break a language or security invariant. A
   * reserved registration outranks repository-local source; an ordinary one is
   * a default a repository file overrides.
   */
  reserved?: boolean;
  /**
   * Opt-in validation: the return is a validated JSON record. Without it the
   * return binds by reference under `as`, unchecked.
   */
  returns?: ReturnsSchema;
  fn: FunctionComponent | TestHarnessComponentDefinition;
}

type Kind = "reserved" | "default";

/** What one scope has registered, by name and kind, for collision reporting. */
type OwnIndex = ReadonlyMap<string, Partial<Record<Kind, string>>>;

const OwnContributions: Context<OwnIndex> = createContext<OwnIndex>(
  "component.registry.own",
  new Map(),
);

const SEGMENT = /^[A-Z][A-Za-z0-9_]*$/;

/**
 * Whether `name` is spelled the way a document writes a component name.
 *
 * The grammar registration is held to, offered as a predicate so a host
 * deciding what a name may be does not restate it. It answers about spelling
 * alone: a name that passes may still be structural syntax, a reserved
 * registration, or a name nothing supplies.
 */
export function isComponentName(name: string): boolean {
  return name.length > 0 && name.split(".").every((segment) => SEGMENT.test(segment));
}

function kindOf(registration: ComponentRegistration): Kind {
  return registration.reserved === true ? "reserved" : "default";
}

function assertUsableName(name: string): void {
  if (name.length === 0) {
    throw new ComponentRegistrationError("a component registration needs a name");
  }
  if (RESERVED_STRUCTURAL.has(name)) {
    throw new ComponentRegistrationError(
      `cannot register "${name}": it is structural syntax the engine owns, not a component`,
    );
  }
  if (!isComponentName(name)) {
    throw new ComponentRegistrationError(
      `cannot register "${name}": a component name is capitalized, and each ` +
        "dot-separated part must start with an uppercase letter",
    );
  }
}

/**
 * Fold `own` over `inherited`, per name and per kind.
 *
 * A default never displaces a reserved registration and vice versa: the two
 * live in separate fields, so what a name resolves to is decided by the
 * resolver's tiers rather than by the order registrations were installed in.
 * The inherited map is copied, never modified.
 */
export function mergeRegistry(
  inherited: ComponentRegistry,
  own: ComponentRegistry,
): ComponentRegistry {
  const merged = new Map<string, RegistryEntry>(inherited);
  for (const [name, entry] of own) {
    const base = merged.get(name);
    merged.set(name, {
      reserved: entry.reserved ?? base?.reserved,
      default: entry.default ?? base?.default,
    });
  }
  return merged;
}

function collision(name: string, kind: Kind, first: string, second: string): Error {
  const what = kind === "reserved" ? "reserved registrations" : "registrations";
  return new ComponentRegistrationError(
    `two ${what} for "${name}" at the same scope: "${first}" and "${second}". ` +
      "Register the name once per scope, or register one of them in a nested scope to shadow " +
      "the other.",
  );
}

/**
 * Make `registrations` resolvable by name for this scope and its descendants.
 *
 * The whole batch is validated before anything is installed, so a rejected call
 * changes nothing. Each accepted call contributes one immutable layer: a
 * descendant scope's layer merges over the layers it inherited, which is what
 * lets a nested registration shadow an outer one without touching it.
 */
/**
 * A capture is a prop the schema never sees, so it may not also be one the
 * schema describes, and it may not be a name the engine already owns.
 */
function assertUsableCaptures(
  name: string,
  captures: readonly string[] | undefined,
  props: PropsSchema,
): void {
  if (captures === undefined) {
    return;
  }
  const declared = props.properties;
  const described = typeof declared === "object" && declared !== null ? declared : {};
  const seen = new Set<string>();
  for (const capture of captures) {
    if (typeof capture !== "string" || capture.length === 0) {
      throw new ComponentRegistrationError(
        `the registration for "${name}" declares a capture that is not a prop name`,
      );
    }
    if (capture === "as" || capture === "slot") {
      throw new ComponentRegistrationError(
        `cannot capture "${capture}" on "${name}": the engine owns that prop`,
      );
    }
    if (seen.has(capture)) {
      throw new ComponentRegistrationError(
        `the registration for "${name}" declares the capture "${capture}" twice`,
      );
    }
    if (Object.hasOwn(described, capture)) {
      throw new ComponentRegistrationError(
        `"${capture}" on "${name}" is both a schema property and a capture: a ` +
          "schema cannot describe a value it never sees",
      );
    }
    seen.add(capture);
  }
}

export function* registerComponents(
  registrations: readonly ComponentRegistration[],
): Operation<void> {
  if (registrations.length === 0) {
    return;
  }

  const batch = new Map<string, RegistryEntry>();
  const additions = new Map<string, Partial<Record<Kind, string>>>();

  for (const registration of registrations) {
    const { name, origin, fn, props, returns, captures } = registration;
    assertUsableName(name);
    if (origin.length === 0) {
      throw new ComponentRegistrationError(
        `the registration for "${name}" needs an origin naming where it came from`,
      );
    }
    yield* compilePropsSchema(props);
    if (returns !== undefined) {
      yield* compileReturnsSchema(returns);
    }
    assertUsableCaptures(name, registration.captures, props);

    const kind = kindOf(registration);
    const already = additions.get(name)?.[kind];
    if (already !== undefined) {
      throw collision(name, kind, already, origin);
    }

    const definition: FunctionComponentDefinition = {
      kind: "function",
      name,
      props,
      fn,
      ...(returns ? { returns } : {}),
      ...(captures && captures.length > 0 ? { captures } : {}),
    };
    batch.set(name, { ...batch.get(name), [kind]: { definition, origin } });
    additions.set(name, { ...additions.get(name), [kind]: origin });
  }

  // Commit: the collision check throws before the write, so a rejected batch
  // leaves both this index and the middleware stack as they were.
  yield* updateOwn(
    OwnContributions,
    () => new Map(),
    (own) => {
      const next = new Map(own);
      for (const [name, kinds] of additions) {
        const prior = own.get(name);
        for (const kind of ["reserved", "default"] as const) {
          const incoming = kinds[kind];
          const existing = prior?.[kind];
          if (incoming !== undefined && existing !== undefined) {
            throw collision(name, kind, existing, incoming);
          }
        }
        next.set(name, { ...prior, ...kinds });
      }
      return next;
    },
  );

  const layer: ComponentRegistry = batch;
  // `min` is what makes a nested registration shadow an outer one: the
  // innermost layer runs first, delegates outward through `next()`, and folds
  // its own batch over whatever came back. Under `max` the outermost would fold
  // last and a parent would overwrite its children.
  yield* Component.around(
    { registry: (_args, next) => mergeRegistry(next(), layer) },
    { at: "min" },
  );
}
