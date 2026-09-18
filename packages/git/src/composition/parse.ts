/**
 * Reading a value that arrived from outside as the shape it claims to be.
 *
 * Every record these components retain comes back through the journal or a
 * database column, so nothing about it is this package's own word by the time it
 * is read. These are the three questions every parser here asks — is this an
 * object with exactly these members, is this a non-empty string, is this one or
 * null — and they are exact on purpose: a value carrying more or fewer members
 * than the record declares describes something other than that record, and
 * reading it as one would silently accept a shape a later version wrote.
 */

export function members(
  value: unknown,
  expected: readonly string[],
): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record: Record<string, unknown> = Object.fromEntries(Object.entries(value));
  if (Object.keys(record).length !== expected.length) {
    return undefined;
  }
  return expected.every((member) => Object.hasOwn(record, member)) ? record : undefined;
}

export function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

export function optionalText(value: unknown): string | null | undefined {
  if (value === null) {
    return null;
  }
  return text(value);
}

/**
 * The one place beneath the Workspace root this string names, or `undefined`.
 *
 * Absolute, and made of ordinary segments: no empty one, no `.`, no `..`. It is
 * a property of the string, decided before any host call, which is what makes it
 * a proof rather than a check of what a filesystem happened to resolve — a
 * `realpath` after the fact has already followed a link by the time it answers.
 */
export function canonicalWorkspacePath(value: unknown): string | undefined {
  const candidate = text(value);
  if (candidate === undefined || !candidate.startsWith("/")) {
    return undefined;
  }
  for (const segment of candidate.slice(1).split("/")) {
    if (segment === "" || segment === "." || segment === "..") {
      return undefined;
    }
  }
  return candidate;
}

/** Whether `path` is `root` itself or one place beneath it, by whole segments. */
export function beneath(root: string, path: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

/**
 * Whether this string is text a host can carry without changing it.
 *
 * A JavaScript string is UTF-16 code units and is not required to be well-formed
 * text: an unpaired surrogate is a value a document can write. Every boundary a
 * value like that crosses on its way to a program — a process argument list, a
 * filesystem path — is UTF-8, and encoding an unpaired surrogate as UTF-8
 * replaces it with U+FFFD. What arrives is then a different string from the one
 * that was asked for, while the run's own history still holds the original.
 *
 * So values that must reach a program exactly as written are held to this first.
 * U+FFFD itself is ordinary text and passes: what is refused is the string that
 * would silently become it.
 */
export function wellFormedText(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit < 0xd800 || unit > 0xdfff) {
      continue;
    }
    // A trailing surrogate with nothing leading it, or a leading one with no
    // trailing one after it, is half of a character that was never written.
    if (unit > 0xdbff) {
      return false;
    }
    const following = value.charCodeAt(index + 1);
    if (!(following >= 0xdc00 && following <= 0xdfff)) {
      return false;
    }
    index += 1;
  }
  return true;
}
