/**
 * Fixture for `local/no-module-scoped-weakset` — the shapes it accepts.
 *
 * Each table is created inside the lifetime that uses it, so it is discarded
 * with that lifetime rather than accumulating across runs. A `WeakMap`, and a
 * mark placed on the object itself, are not this rule's subject at all.
 */

const CAPTURED = Symbol.for("executablemd.fixture.captured");

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

export function* trackDuringRun(values: object[]): Generator<object, void, unknown> {
  const visited = new WeakSet<object>();
  for (const value of values) {
    visited.add(value);
    yield value;
  }
}

export const causes = new WeakMap<object, unknown>();

export function mark(value: object): void {
  Object.defineProperty(value, CAPTURED, { value: true });
}
