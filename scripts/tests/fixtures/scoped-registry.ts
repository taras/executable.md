/**
 * Fixture for `local/no-module-scoped-registry` — the shapes it accepts.
 *
 * Each table is created inside the lifetime that uses it, so it is discarded
 * with that lifetime rather than accumulating across runs. The metadata brand
 * is the one shape that is not run state: an author declares it about a
 * definition at module evaluation, under a module-private symbol.
 */

const CAPTURES = Symbol("fixture.captures");

export function collectOnce(values: object[]): object[] {
  const seen = new WeakSet<object>();
  return values.filter((value) => {
    if (seen.has(value)) {
      return false;
    }
    seen.add(value);
    return true;
  });
}

export function* useRegistries(): Generator<unknown, { causes: WeakMap<object, unknown> }, unknown> {
  const registries = { causes: new WeakMap<object, unknown>(), counts: new Map<string, number>() };
  yield registries;
  return registries;
}

export function tally(names: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const name of names) {
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return counts;
}

export function declaresCapture(component: () => void): boolean {
  return Object.hasOwn(component, CAPTURES);
}

/** A constant lookup table: built from its contents, never written to. */
export const RESERVED = new Set(["Content", "Output"]);

export const HANDLERS = new Map([["exec", "run"]]);

/** An instance field belongs to the object's lifetime, not the module's. */
export class Index {
  private entries = new Map<string, number>();

  count(name: string): number {
    return this.entries.get(name) ?? 0;
  }
}

/** Handed straight to a call: the module keeps no handle on it. */
export const context = createContext("fixture.registry", new Map<string, number>());

function createContext(name: string, initial: Map<string, number>): { name: string } {
  return { name: `${name}:${initial.size}` };
}
