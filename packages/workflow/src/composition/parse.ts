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
