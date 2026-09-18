/**
 * Admitting a Git locator, and naming one without publishing it.
 *
 * A locator is ordinary document input: it arrives from a prop or an
 * expression, and nothing about it has been checked. Two questions are asked
 * here and they are different questions. **Admission** decides whether this
 * provider will hand the string to Git at all. **Fingerprinting** produces the
 * stable name the journal, the record and every compatibility comparison use,
 * so a changed locator diverges without the bytes of either one being retained
 * outside the single column that holds them.
 *
 * Admission is a closed allowlist rather than a search for bad shapes. Git's
 * locator grammar reaches well past URLs — `ext::sh -c …` runs a command, a
 * leading `-` is read as an option, and a transport helper is whatever is on
 * `PATH` — so anything not recognized as one of the five admitted forms is
 * refused. Credentials in the string are refused rather than stripped: a
 * locator that carries one is a secret the caller put in a durable input, and
 * quietly editing it would retain a run nobody asked for.
 */

import { createHash } from "node:crypto";

/** Schemes this provider hands to Git. Everything else is refused. */
const SCHEMES = new Set(["https", "http", "ssh", "git", "file"]);

/** `user@host:path`, Git's scp-like form. A colon in the userinfo is a password. */
const SCP_LIKE = /^([^/@:]+)@([^/@:]+):(.+)$/;

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
}

function admitUrl(locator: string): string | undefined {
  let url: URL;
  try {
    url = new URL(locator);
  } catch {
    return undefined;
  }
  const scheme = url.protocol.replace(/:$/, "");
  if (!SCHEMES.has(scheme)) {
    return undefined;
  }
  if (url.username !== "" || url.password !== "") {
    return undefined;
  }
  // A query or a fragment is refused whole rather than searched for credentials.
  // `?access_token=…` is the ordinary way a token is written into a URL, and a
  // rule that named the parameters worth refusing would be a list of the ones
  // somebody thought of — the same open-ended guessing this module rejects
  // everywhere else. Git is given a repository's location, and neither part
  // carries any of that location for the transports admitted here.
  if (url.search !== "" || url.hash !== "") {
    return undefined;
  }
  return locator;
}

/**
 * The locator this string is, or `undefined` when this provider will not use it.
 *
 * The answer is the original bytes, never a rewritten form: what is admitted is
 * what Git is given and what the fingerprint names, so the three cannot drift.
 */
export function admitLocator(locator: string): string | undefined {
  if (locator === "" || hasControlCharacters(locator) || /\s/.test(locator)) {
    return undefined;
  }
  if (locator.startsWith("-")) {
    return undefined;
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(locator)) {
    return admitUrl(locator);
  }
  const scpLike = SCP_LIKE.exec(locator);
  if (scpLike !== null) {
    return locator;
  }
  // A local path. Absolute only: a relative one would name a different
  // repository depending on which directory the host happened to run in, and a
  // workflow's retained identity must not depend on that.
  if (locator.startsWith("/")) {
    return locator;
  }
  return undefined;
}

/** The stable name an admitted locator is known by everywhere but its own column. */
export function locatorFingerprint(locator: string): string {
  return createHash("sha256").update(locator, "utf8").digest("hex");
}
