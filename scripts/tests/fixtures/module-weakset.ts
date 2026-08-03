/**
 * Fixture for `local/no-module-scoped-weakset` — the reported shapes.
 *
 * Every construction here outlives the work that fills it: one table per
 * process, shared by every run.
 */

const marked = new WeakSet<object>();

export const exported = new WeakSet<object>();

export let assignedLater: WeakSet<object> | undefined;
assignedLater = new WeakSet<object>();

const pair = { members: new WeakSet<object>() };

export function remember(value: object): void {
  marked.add(value);
  exported.add(value);
  pair.members.add(value);
  assignedLater?.add(value);
}
