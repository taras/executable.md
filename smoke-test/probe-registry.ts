/**
 * Live tokens for the resource-lifetime chapter.
 *
 * A token is added when its resource is acquired and removed when the resource
 * is released, so a later component can ask whether one issued earlier is still
 * alive. Module-local state is what makes that observable from Markdown without
 * writing files or reaching for JavaScript in the document.
 *
 * Lowercase filename: component names are capitalized, so this module is
 * shared implementation rather than something a document can invoke.
 */

const live = new Set<string>();

let counter = 0;

export function nextToken(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}`;
}

export function hold(token: string): void {
  live.add(token);
}

export function release(token: string): void {
  live.delete(token);
}

export function isLive(token: string): boolean {
  return live.has(token);
}
