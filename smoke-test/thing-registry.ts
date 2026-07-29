/**
 * The live resources the lifetime chapter observes.
 *
 * A handle is added when its resource is acquired and removed when the
 * resource is released, so a document can watch a lifetime it holds no
 * reference to. Module-local state is what makes that observable from Markdown
 * without writing files or reaching for JavaScript in the document.
 *
 * Lowercase filename: component names are capitalized, so this module is
 * shared implementation rather than something a document can invoke.
 */

const live = new Set<string>();

let counter = 0;

export function nextHandle(): string {
  counter += 1;
  return `thing-${counter}`;
}

export function hold(handle: string): void {
  live.add(handle);
}

export function release(handle: string): void {
  live.delete(handle);
}

export function isLive(handle: string): boolean {
  return live.has(handle);
}

export function anyLive(): boolean {
  return live.size > 0;
}
