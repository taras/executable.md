/**
 * How a document spells a component name, with nothing else behind it.
 *
 * The grammar registration is held to, offered as a predicate so a host
 * deciding what a name may be does not restate it. It answers about spelling
 * alone: a name that passes may still be structural syntax, a reserved
 * registration, or a name nothing supplies.
 *
 * A leaf, so a consumer validating a retained name — a stored workflow
 * definition checking its component bundle — does not load the registration
 * machinery, or the engine behind it, to ask one question about a string.
 */

const SEGMENT = /^[A-Z][A-Za-z0-9_]*$/;

export function isComponentName(name: string): boolean {
  return name.length > 0 && name.split(".").every((segment) => SEGMENT.test(segment));
}
