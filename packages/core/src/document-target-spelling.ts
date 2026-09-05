/**
 * How an exact document target is spelled, with no host and no parser behind
 * it.
 *
 * Percent-encoding a label, decoding one, normalizing it, and asking whether a
 * fragment is already canonical are string arithmetic. They live apart from the
 * catalog and selector machinery that uses them because a consumer that only
 * needs to validate a retained target — a stored workflow definition checking
 * the one it kept — should not have to load a Markdown parser, or a runtime
 * that has one, to do it.
 */

const UNRESERVED = /^[A-Za-z0-9\-._~]$/;
const HEX = /^[0-9A-Fa-f]$/;

const ENCODER = new TextEncoder();

function encodeCharacter(character: string): string {
  let encoded = "";
  for (const byte of ENCODER.encode(character)) {
    encoded += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return encoded;
}

/**
 * Percent-encode one canonical label. Everything outside RFC 3986's unreserved
 * set is escaped, so `/`, `*`, `#`, and `%` inside a heading cannot be read as
 * hierarchy or operator syntax.
 */
export function encodeTargetLabel(label: string): string {
  let encoded = "";
  for (const character of label) {
    encoded += UNRESERVED.test(character) ? character : encodeCharacter(character);
  }
  return encoded;
}

/**
 * Percent-encode a decoded filesystem path. Separators survive as raw `/`; a
 * `/` that is part of a filename cannot be told apart from one afterwards, so
 * this is a formatter for paths the caller already holds, not a round trip.
 */
export function encodeDocumentPath(path: string): string {
  let encoded = "";
  for (const character of path) {
    encoded +=
      character === "/" || UNRESERVED.test(character) ? character : encodeCharacter(character);
  }
  return encoded;
}

/**
 * Decode one percent-encoded chunk, or `undefined` when it is not decodable.
 *
 * Malformed escapes, byte sequences that are not UTF-8, and NUL are all
 * refused rather than repaired: a selector that cannot be read exactly is not a
 * selector this can match against. `+` is an ordinary character — this is URI
 * path syntax, not a form encoding.
 */
export function decodePercentEncoded(text: string): string | undefined {
  const characters = Array.from(text);
  const bytes: number[] = [];
  for (let index = 0; index < characters.length; index++) {
    const character = characters[index]!;
    if (character !== "%") {
      for (const byte of ENCODER.encode(character)) {
        bytes.push(byte);
      }
      continue;
    }
    const high = characters[index + 1];
    const low = characters[index + 2];
    if (high === undefined || low === undefined || !HEX.test(high) || !HEX.test(low)) {
      return undefined;
    }
    bytes.push(Number.parseInt(`${high}${low}`, 16));
    index += 2;
  }
  try {
    // `ignoreBOM` is stated rather than defaulted: it is already false
    // everywhere this runs, and Cloudflare's own type declares both options
    // required, so saying it keeps one spelling readable to every runtime.
    const decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
      new Uint8Array(bytes),
    );
    return decoded.includes("\u0000") ? undefined : decoded;
  } catch {
    return undefined;
  }
}

/**
 * The canonical form of rendered heading text: NFC, every run of Unicode
 * whitespace collapsed to one ASCII space, trimmed, case preserved.
 */
export function normalizeLabel(text: string): string {
  return text.normalize("NFC").replace(/\s+/gu, " ").trim();
}

/**
 * Whether a fragment is already an exact canonical target.
 *
 * A level is canonical only when decoding it, normalizing the label, and
 * re-encoding that label reproduce the level byte for byte. Requiring the whole
 * round trip is what makes this total: it rejects a wildcard operator, an empty
 * level, a lowercase escape, a raw `#`, an NFD spelling, a tab, and leading,
 * trailing, or uncollapsed whitespace without naming any of them, because none
 * of them is what this module would have written.
 */
export function isCanonicalTarget(target: string): boolean {
  if (target.length === 0) {
    return false;
  }
  return target.split("/").every((level) => {
    const decoded = decodePercentEncoded(level);
    if (decoded === undefined || decoded.length === 0) {
      return false;
    }
    const label = normalizeLabel(decoded);
    return label === decoded && encodeTargetLabel(label) === level;
  });
}
