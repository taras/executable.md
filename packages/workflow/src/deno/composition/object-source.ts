/**
 * The authorized way one push reaches this run's Git objects, and nothing more.
 *
 * Never the selected checkout itself. A checkout carries a `.git/config` the
 * Workspace retains and a document can write, and several ordinary settings in
 * one name a program or a destination: `remote.origin.pushurl`, a
 * `url.<base>.pushInsteadOf` rewrite, a `pre-push` hook, a credential helper,
 * `gpg.program`. Running the transport there would let retained document data
 * choose where this run publishes and what else runs while it happens.
 *
 * So the transport runs in a bare repository this provider created, configured
 * by nothing but its own creation, which reads the checkout's object database
 * through a read-only alternate. Same objects, different door — and the door
 * this run owns.
 *
 * ## The door is not the whole of what is behind it
 *
 * Pointing that alternate at the checkout's object database says where Git
 * starts reading, not where it stops. An object database names further ones in
 * `objects/info/alternates`, Git follows that chain transitively, and every
 * file in the chain is inside the Workspace this run restores — so a document
 * that writes one is choosing which objects a push may publish. A symbolic link
 * anywhere under `objects/` does the same thing without a chain at all: the
 * operating system resolves it before Git reports anything about it.
 *
 * Neither is repaired here. Deleting an authored alternate would publish from a
 * database this run edited on the author's behalf, and ignoring one would
 * publish from a database that is not the one it verified. The graph is
 * *rejected*: everything Git may traverse has to resolve inside the object
 * database this run authenticated, and a graph that leaves it is not a source
 * this push has an authorized way to read.
 *
 * ## Why it is lazy
 *
 * Nothing here runs until a live provider first needs the source, which is
 * before its first remote observation and after every local authority check. An
 * execution that replays a completed push reaches no provider at all: the
 * shared engine hands back the retained record, so no control repository is
 * built, no object graph is walked and no Git runs for the push.
 */

import { type Operation, until } from "effection";
import { ensureDir, lstat, readdir, readTextFile, writeTextFile } from "@effectionx/fs";
import { realpath } from "node:fs/promises";
import type { Stats } from "node:fs";
import { GitOperationInfrastructureError } from "../../composition/errors.ts";
import type { GitObjectFormat } from "../../composition/records.ts";
import { commonDirectory, gitSession, initControlPlane, type GitSession } from "./git.ts";
import type { RepositoryHost } from "./host.ts";
import type { GitCheckout } from "./operations.ts";

/**
 * A source the transport may read, once something needs it.
 *
 * `ready()` answers with the control repository, having proven on its first
 * call that the object graph behind it is contained. Later calls answer with
 * the same one: a source is validated once per invocation, and the invocation
 * owns it.
 */
export interface PushObjectSource {
  readonly git: GitSession;
  ready(): Operation<string>;
}

/**
 * A containment failure, said without saying what it found.
 *
 * The path an author wrote is untrusted input, and a diagnostic is the last
 * place it should reappear. Nothing that reaches here quotes one — and the
 * Git-host boundary withholds even this sentence, because a provider's failure
 * is not something a document may read.
 */
function uncontained(operation: string, reason: string): never {
  throw new GitOperationInfrastructureError(operation, reason);
}

/** What the host holds at this path, or `undefined` when it holds nothing. */
function* entry(path: string): Operation<Stats | undefined> {
  try {
    return yield* lstat(path);
  } catch (error) {
    const code = error instanceof Error ? Reflect.get(error, "code") : undefined;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return undefined;
    }
    throw error;
  }
}

/**
 * Every entry beneath the object database is one the operating system will not
 * redirect.
 *
 * `lstat` throughout, so a symbolic link answers as itself rather than as
 * whatever it points at. A link under `objects/` — `objects/pack` is the one
 * worth planting — makes an external directory the thing Git reads packs from,
 * and no question asked about the object database afterwards would say so,
 * because every one of them would already have followed it.
 */
function* containedTree(directory: string, operation: string): Operation<void> {
  for (const name of yield* readdir(directory)) {
    const path = `${directory}/${name}`;
    const info = yield* entry(path);
    if (info === undefined) {
      continue;
    }
    if (info.isSymbolicLink()) {
      uncontained(
        operation,
        "its object database holds a symbolic link, so what native Git would read is not what " +
          "this run retained",
      );
    }
    if (info.isDirectory()) {
      yield* containedTree(path, operation);
      continue;
    }
    if (!info.isFile()) {
      uncontained(
        operation,
        "its object database holds an entry that is neither a file nor a directory",
      );
    }
  }
}

/**
 * What one alternates entry turns out to be.
 *
 * `ignored` is a comment or an empty entry, which Git skips. `path` is an
 * object directory Git will traverse. `undecidable` is an entry this reading
 * cannot say the exact path of — and an entry whose path cannot be named
 * exactly cannot be held to containment, so it is refused rather than guessed.
 */
type AlternateEntry =
  | { readonly kind: "ignored" }
  | { readonly kind: "path"; readonly value: string }
  | { readonly kind: "undecidable" };

/** The one-character escapes Git's C-style unquoting understands. */
const ESCAPES: ReadonlyMap<string, number> = new Map([
  ["a", 0x07],
  ["b", 0x08],
  ["f", 0x0c],
  ["n", 0x0a],
  ["r", 0x0d],
  ["t", 0x09],
  ["v", 0x0b],
  ["\\", 0x5c],
  ['"', 0x22],
]);

/**
 * Git's octal escape grammar, which is narrower than "three octal digits".
 *
 * `unquote_c_style()` cases the leading digit as `0`–`3` and nothing else, so
 * `\\4` through `\\7` are escapes it does not know: quoting fails and
 * `parse_alt_odb_entry()` reads the whole entry as ordinary literal text. The
 * reason is arithmetic — an escape names one byte, and `\\400` is already
 * 256 — so a reader that accepted a wider leading digit would be computing a
 * value no byte can hold.
 *
 * Accepting one is not a near miss. `\\457` is 303, and 303 truncated into a
 * byte is 47, which is `/`: a reader that wrapped it would see a path separator
 * where Git sees an invalid escape, and the two would then resolve entirely
 * different object directories from the same entry.
 */
const OCTAL_LEAD = /^[0-3]$/;
const OCTAL = /^[0-7]$/;

/**
 * One byte of an unquoted path, or `undefined` when the value is not one.
 *
 * Git's own grammar already keeps every value it accepts inside a byte, and
 * this is what makes that a property this reading checks rather than one it
 * assumes: nothing here reaches a typed array that would quietly truncate a
 * value into a different character.
 */
function pathByte(value: number): number | undefined {
  return Number.isInteger(value) && value >= 0 && value <= 0xff ? value : undefined;
}

type Unquoted =
  /** The path the quoting names, and where the closing quote left off. */
  | { readonly kind: "path"; readonly value: string; readonly end: number }
  /** Quoting Git's own reader rejects, which it then reads as ordinary text. */
  | { readonly kind: "literal" }
  /** Bytes this host cannot name a path with, so the exact path is unknown. */
  | { readonly kind: "undecidable" };

/** The path these bytes name, or `undefined` when they name none. */
function decodePath(bytes: readonly number[]): string | undefined {
  if (bytes.includes(0)) {
    return undefined;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes));
  } catch {
    return undefined;
  }
}

/**
 * Read a C-style quoted alternates entry the way Git's own unquoting reads one.
 *
 * Bytes rather than characters, because that is what Git unquotes into and what
 * it hands the operating system: an octal escape names one byte, and three of
 * them can name one character. Assembling bytes and decoding once is what keeps
 * the path this produces the path Git would open.
 *
 * Quoting Git rejects — an unterminated string, an escape it does not know, a
 * short octal escape, an octal escape whose leading digit is `4` or higher — is
 * not an error here either. Git falls back to reading
 * the line as ordinary text, so this says `literal` and the caller does the
 * same, which is what keeps a broken-looking line safely classified rather than
 * quietly resolved as something it is not.
 */
function unquoteCStyle(text: string): Unquoted {
  const encoder = new TextEncoder();
  const bytes: number[] = [];
  let index = 1;

  for (;;) {
    let plain = index;
    while (plain < text.length && text[plain] !== '"' && text[plain] !== "\\") {
      plain += 1;
    }
    for (const byte of encoder.encode(text.slice(index, plain))) {
      bytes.push(byte);
    }
    index = plain;
    if (index >= text.length) {
      return { kind: "literal" };
    }

    const delimiter = text[index];
    index += 1;
    if (delimiter === '"') {
      const value = decodePath(bytes);
      return value === undefined ? { kind: "undecidable" } : { kind: "path", value, end: index };
    }

    const escape = text[index];
    index += 1;
    if (escape === undefined) {
      return { kind: "literal" };
    }
    const simple = ESCAPES.get(escape);
    if (simple !== undefined) {
      bytes.push(simple);
      continue;
    }
    const second = text[index];
    const third = text[index + 1];
    if (
      !OCTAL_LEAD.test(escape) ||
      second === undefined ||
      third === undefined ||
      !OCTAL.test(second) ||
      !OCTAL.test(third)
    ) {
      return { kind: "literal" };
    }
    const octal = pathByte((Number(escape) << 6) | (Number(second) << 3) | Number(third));
    if (octal === undefined) {
      return { kind: "literal" };
    }
    index += 2;
    bytes.push(octal);
  }
}

/**
 * The next entry an alternates file holds, and what is left after it.
 *
 * This is Git's `parse_alt_odb_entry`, and being Git's is the whole point. A
 * line is not the unit: a `#` line is a comment, a line beginning with `"` is a
 * **quoted** path that Git unquotes before it resolves anything — and a quoted
 * string may contain the separator, so where an entry ends is decided by the
 * quoting rather than by the next newline. Everything else is ordinary text.
 *
 * Reading a quoted entry literally is what a validator must not do. The two
 * spellings resolve to different places on purpose: `"/elsewhere/objects"` is
 * an external database to Git and a relative path with quote characters in its
 * name to anything comparing strings, so a directory of that literal name sits
 * inside the authenticated database and answers for a traversal that never goes
 * there.
 *
 * A closing quote with more text after it on its line is the one shape this
 * refuses. Git consumes it in a way no containment check can restate as a
 * single path, and an entry whose exact path cannot be named cannot be proven
 * contained.
 */
function nextAlternateEntry(text: string): { entry: AlternateEntry; rest: string } {
  const separator = text.indexOf("\n");
  const line = separator < 0 ? text.length : separator;
  const after = (end: number): string => (end < text.length ? text.slice(end + 1) : "");

  if (text.startsWith("#")) {
    return { entry: { kind: "ignored" }, rest: after(line) };
  }

  if (text.startsWith('"')) {
    const unquoted = unquoteCStyle(text);
    if (unquoted.kind === "undecidable") {
      return { entry: { kind: "undecidable" }, rest: "" };
    }
    if (unquoted.kind === "path") {
      const trailing = text[unquoted.end];
      if (trailing !== undefined && trailing !== "\n") {
        return { entry: { kind: "undecidable" }, rest: "" };
      }
      return { entry: { kind: "path", value: unquoted.value }, rest: after(unquoted.end) };
    }
    // Broken quoting. Git reads the line as ordinary text, and so does this.
  }

  const literal = text.slice(0, line);
  return {
    entry: literal === "" ? { kind: "ignored" } : { kind: "path", value: literal },
    rest: after(line),
  };
}

/**
 * Every object directory one alternates file names, resolved as Git resolves it.
 *
 * A relative entry is relative to the object directory that named it, which is
 * what Git's own `relative_base` makes it.
 */
function alternatePaths(content: string, from: string, operation: string): string[] {
  const paths: string[] = [];
  let rest = content;
  while (rest !== "") {
    const scanned = nextAlternateEntry(rest);
    rest = scanned.rest;
    const entry = scanned.entry;
    if (entry.kind === "undecidable") {
      uncontained(
        operation,
        "its object database holds an alternates entry whose object directory this run " +
          "cannot name exactly, so it cannot be proven to stay inside the database this run " +
          "authenticated",
      );
    }
    if (entry.kind === "ignored") {
      continue;
    }
    paths.push(entry.value.startsWith("/") ? entry.value : `${from}/${entry.value}`);
  }
  return paths;
}

/**
 * Walk the alternates chain, and refuse a graph that leaves the database.
 *
 * Transitive, because Git's is: an alternate may name a database that names
 * another. Cycles are the author's to write and this one's to survive, so a
 * directory already walked is not walked again.
 *
 * Containment is decided on the resolved path. `realpath` is what a traversal
 * actually reaches, and a relative entry, a `..` entry and a link at the far
 * end all arrive at the same question — is what Git would read part of the
 * object database this run authenticated?
 */
function* containedAlternates(
  objects: string,
  directory: string,
  seen: Set<string>,
  operation: string,
): Operation<void> {
  if (seen.has(directory)) {
    return;
  }
  seen.add(directory);

  const file = `${directory}/info/alternates`;
  if ((yield* entry(file))?.isFile() !== true) {
    return;
  }
  for (const named of alternatePaths(yield* readTextFile(file), directory, operation)) {
    let resolved: string;
    try {
      resolved = yield* until(realpath(named));
    } catch {
      uncontained(
        operation,
        "its object database names an alternate object directory that does not resolve",
      );
    }
    if (resolved !== objects && !resolved.startsWith(`${objects}/`)) {
      uncontained(
        operation,
        "its object database names an alternate object directory outside the database this " +
          "run authenticated, so a push from it could publish objects this run does not hold",
      );
    }
    if ((yield* entry(resolved))?.isDirectory() !== true) {
      uncontained(
        operation,
        "its object database names an alternate that is not a real object directory",
      );
    }
    yield* containedAlternates(objects, resolved, seen, operation);
  }
}

/**
 * The object database this checkout publishes from, once it is contained.
 *
 * Three questions in one order, and the order is what makes each answerable.
 * The database has to be the retained Repository's own — a linked worktree
 * shares it, which is why one proof covers both kinds of checkout. It has to be
 * a real directory that resolves to itself, so the walk below is walking the
 * export rather than somewhere a link led. And then everything Git may traverse
 * from it — every entry beneath it, and every object directory the alternates
 * chain names — has to resolve inside it.
 */
function* containedObjectDatabase(checkout: GitCheckout, operation: string): Operation<string> {
  const administration = `${checkout.repositoryDirectory}/.git`;
  if ((yield* commonDirectory(checkout.git, checkout.directory)) !== administration) {
    uncontained(
      operation,
      "the checkout it ran in does not share the retained repository's object database",
    );
  }

  const objects = `${administration}/objects`;
  if ((yield* entry(objects))?.isDirectory() !== true) {
    uncontained(operation, "the retained repository holds no object database to publish from");
  }
  if ((yield* until(realpath(objects))) !== objects) {
    uncontained(
      operation,
      "its object database does not resolve inside the checkout this run materialized",
    );
  }

  yield* containedTree(objects, operation);
  yield* containedAlternates(objects, objects, new Set<string>(), operation);
  return objects;
}

/**
 * A source for one push, built the first time something needs to read it.
 *
 * The directory is acquired by the caller's scope, so it is removed with the
 * push whether or not anything was ever built inside it. What is deferred is
 * every Git command and every filesystem walk: on a completed replay none of
 * them happens, because no provider is reached to ask.
 */
export function objectSource(
  host: RepositoryHost,
  root: string,
  checkout: GitCheckout,
  format: GitObjectFormat,
  operation: string,
): PushObjectSource {
  const git = gitSession(host, root);
  const directory = `${root}/control`;
  let built = false;
  return {
    git,
    *ready(): Operation<string> {
      if (!built) {
        const objects = yield* containedObjectDatabase(checkout, operation);
        yield* initControlPlane(git, root, directory, format);
        yield* ensureDir(`${directory}/objects/info`);
        yield* writeTextFile(`${directory}/objects/info/alternates`, `${objects}\n`);
        built = true;
      }
      return directory;
    },
  };
}
