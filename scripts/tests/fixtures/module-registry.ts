/**
 * Fixture for `local/no-module-scoped-registry` — the reported shapes.
 *
 * Every construction here outlives the work that fills it: one table per
 * process, shared by every run, whichever of the four kinds it is.
 */

const marked = new WeakSet<object>();

export const exported = new WeakSet<object>();

export let assignedLater: WeakSet<object> | undefined;
assignedLater = new WeakSet<object>();

const pair = { members: new WeakSet<object>() };

export class Registry {
  static everything = new WeakSet<object>();
}

const causes = new WeakMap<object, unknown>();

const counts = new Map<string, number>();

const seen = new Set<string>();

export function remember(value: object, name: string): void {
  marked.add(value);
  exported.add(value);
  pair.members.add(value);
  assignedLater?.add(value);
  causes.set(value, name);
  counts.set(name, (counts.get(name) ?? 0) + 1);
  seen.add(name);
}
