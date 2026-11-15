/**
 * Reading one history file a chunk at a time, and never as one string.
 *
 * A history can outgrow the longest string a JavaScript engine will build,
 * and long before it does, holding it as one string beside its parsed records
 * keeps a second copy of everything it says. So nothing here reads a whole
 * file. Bytes arrive in fixed chunks; a line ends at its newline byte, which
 * UTF-8 never uses inside a multi-byte character, so a line is found without
 * decoding anything; and each line is decoded, handed over and released before
 * the next one is read.
 *
 * Fingerprints are of the file's own bytes, read the same way. Nothing here
 * re-encodes a record to measure it.
 *
 * `@effectionx/fs` reads whole files only, so the file is opened through
 * `node:fs/promises`, whose handle every runtime this CLI ships on provides.
 * The handle is this module's resource: it is released when its owner ends,
 * after any read still in flight has settled, however the owner ended.
 */

import { ensure, resource, scoped, until } from "effection";
import type { Operation } from "effection";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { constants, open, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";

type BigIntStats = Extract<Awaited<ReturnType<typeof stat>>, { size: bigint }>;

/** How much of a file is read at once. */
export const READ_CHUNK = 1 << 20;

const NEWLINE = 0x0a;

/**
 * One file's bytes, in order, a chunk at a time.
 *
 * Each chunk is a view of the one buffer this reader owns, so a chunk is what
 * the file held until the next one is asked for. Every consumer here reads it
 * at once — hashing it, scanning it for a record boundary, decoding it — and
 * one that needs to keep bytes copies them. A buffer per read would allocate
 * the whole file again in a megabyte at a time, which is what reading a
 * half-gigabyte history used to do on top of reading it.
 */
interface FileChunks {
  /** The next chunk, or nothing once the file has been read to its end. */
  next(): Operation<Uint8Array | undefined>;
}

function useFileChunks(
  path: string,
  range?: { readonly start: number; readonly end: number },
): Operation<FileChunks> {
  return resource(function* (provide) {
    let opening: Promise<FileHandle> | undefined;
    let reading: Promise<unknown> | undefined;
    // Registered before the open is asked for, so an owner halted while either
    // the open or a read is still pending leaves no handle behind. The pending
    // read is joined before the close, because closing under it would end
    // native work this resource started without waiting for it.
    yield* ensure(function* () {
      if (opening === undefined) {
        return;
      }
      if (reading !== undefined) {
        yield* until(reading.then(ignore, ignore));
      }
      const handle = yield* until(opening.then((opened) => opened, ignore));
      if (handle !== undefined) {
        yield* until(handle.close());
      }
    });
    opening = open(path, "r");
    const handle = yield* until(opening);
    const buffer = new Uint8Array(READ_CHUNK);
    let position = range?.start ?? 0;
    yield* provide({
      *next(): Operation<Uint8Array | undefined> {
        const length =
          range === undefined ? READ_CHUNK : Math.min(READ_CHUNK, range.end - position);
        if (length === 0) {
          return undefined;
        }
        const read = handle.read(buffer, 0, length, position);
        reading = read;
        const { bytesRead } = yield* until(read);
        reading = undefined;
        position += bytesRead;
        return bytesRead === 0 ? undefined : buffer.subarray(0, bytesRead);
      },
    });
  });
}

function ignore(): undefined {
  return undefined;
}

/** What a line reader refuses with, in its caller's own words. */
export interface LineRefusals {
  /** The file's last line has no newline, so it was never finished writing. */
  unterminated(): Error;
  /** A line is not UTF-8, when decoding is strict. */
  undecodable?(): Error;
}

/** A bound on one decoded line, including its newline. */
export interface LineBound {
  readonly units: number;
  exceeded(record: number): Error;
}

export interface LineOptions {
  readonly recordLimit?: LineBound;
  /** Refuse bytes that are not UTF-8, rather than replacing them. */
  readonly strict?: boolean;
  readonly refusals: LineRefusals;
  /** Sees each chunk's raw bytes, in order, before any of it is decoded. */
  readonly observe?: (chunk: Uint8Array) => void;
  /** Sees the raw fragments of a record, including its newline. */
  readonly recordBytes?: (fragment: Uint8Array) => void;
  readonly range?: { readonly start: number; readonly end: number };
}

/**
 * Hand each complete line of one file, decoded, to `visit`, and return how many
 * there were.
 *
 * A line is released once `visit` returns, so what stays in memory is what the
 * visitor kept. A last line with no newline is refused after every complete
 * line before it has been visited: a reader that has already acted on those
 * lines is refusing the file whole all the same.
 */
export function forEachLine(
  path: string,
  options: LineOptions,
  visit: (line: string) => Operation<void>,
): Operation<number> {
  return scoped(function* (): Operation<number> {
    const chunks = yield* useFileChunks(path, options.range);
    // One decoder for the whole file. A leading byte order mark is kept, as a
    // whole-file read keeps it, so a file that begins with one reads the same.
    const decoder = new TextDecoder("utf-8", {
      fatal: options.strict === true,
      ignoreBOM: true,
    });
    const bound = options.recordLimit;
    let pieces: string[] = [];
    let units = 0;
    let lines = 0;
    let unfinished = false;

    const decode = (bytes: Uint8Array, stream: boolean): void => {
      let text: string;
      try {
        text = decoder.decode(bytes, { stream });
      } catch (error) {
        throw options.refusals.undecodable?.() ?? error;
      }
      units += text.length;
      if (bound !== undefined && units > bound.units) {
        throw bound.exceeded(lines + 1);
      }
      if (text.length > 0) {
        pieces.push(text);
      }
    };

    for (let chunk = yield* chunks.next(); chunk !== undefined; chunk = yield* chunks.next()) {
      options.observe?.(chunk);
      let start = 0;
      for (let end = chunk.indexOf(NEWLINE); end >= 0; end = chunk.indexOf(NEWLINE, start)) {
        // Not streamed, so a multi-byte sequence the line left unfinished is
        // settled here rather than carried into the next line.
        options.recordBytes?.(chunk.subarray(start, end + 1));
        decode(chunk.subarray(start, end), false);
        units += 1;
        if (bound !== undefined && units > bound.units) {
          throw bound.exceeded(lines + 1);
        }
        const line = pieces.join("");
        pieces = [];
        units = 0;
        lines += 1;
        unfinished = false;
        start = end + 1;
        yield* visit(line);
      }
      if (start < chunk.length) {
        options.recordBytes?.(chunk.subarray(start));
        decode(chunk.subarray(start), true);
        unfinished = true;
      }
    }
    if (unfinished) {
      throw options.refusals.unterminated();
    }
    return lines;
  });
}

/** A byte count and the SHA-256 of exactly those bytes. */
export interface ByteFingerprint {
  readonly bytes: number;
  readonly sha256: string;
}

/** The byte count and digest of one whole file, as it is on disk. */
export function fileFingerprint(path: string): Operation<ByteFingerprint> {
  return scoped(function* (): Operation<ByteFingerprint> {
    const chunks = yield* useFileChunks(path);
    const hash = createHash("sha256");
    let bytes = 0;
    for (let chunk = yield* chunks.next(); chunk !== undefined; chunk = yield* chunks.next()) {
      hash.update(chunk);
      bytes += chunk.length;
    }
    return { bytes, sha256: hash.digest("hex") };
  });
}

/** What one pass over a file's lines measured. */
export interface LinePrefix {
  /** How many newline-terminated lines the file holds. */
  readonly records: number;
  /** Whether the file is empty or ends with a newline. */
  readonly terminated: boolean;
  /**
   * The fingerprint of the first `count` lines, newlines included, or of the
   * whole file when no count was asked for or it holds fewer lines than that.
   */
  readonly prefix: ByteFingerprint;
}

/**
 * Count one file's lines and fingerprint the first `count` of them.
 *
 * Byte-exact and record-bounded: a prefix ends at a newline, so it never takes
 * part of the next record's bytes into its digest. The whole file is still read
 * to the end, because how many records it holds and whether its last one was
 * finished are facts about all of it.
 */
export function measureLines(path: string, count?: number): Operation<LinePrefix> {
  return scoped(function* (): Operation<LinePrefix> {
    const chunks = yield* useFileChunks(path);
    const hash = createHash("sha256");
    let hashing = count === undefined || count > 0;
    let hashed = 0;
    let records = 0;
    let last: number | undefined;
    for (let chunk = yield* chunks.next(); chunk !== undefined; chunk = yield* chunks.next()) {
      let from = 0;
      for (let end = chunk.indexOf(NEWLINE); end >= 0; end = chunk.indexOf(NEWLINE, end + 1)) {
        records += 1;
        if (hashing && records === count) {
          hash.update(chunk.subarray(from, end + 1));
          hashed += end + 1 - from;
          hashing = false;
          from = chunk.length;
        }
      }
      if (hashing) {
        hash.update(chunk.subarray(from));
        hashed += chunk.length - from;
      }
      last = chunk[chunk.length - 1];
    }
    return {
      records,
      terminated: last === undefined || last === NEWLINE,
      prefix: { bytes: hashed, sha256: hash.digest("hex") },
    };
  });
}

/** A local file identity and the metadata that changes when it is written. */
export interface JournalVersion {
  readonly device: bigint;
  readonly inode: bigint;
  readonly size: bigint;
  readonly modified: bigint;
  readonly changed: bigint;
}

export class JournalChangedError extends Error {
  constructor(options?: { cause: unknown }) {
    super(
      "this execution's journal changed after it was opened. Reopen the execution to continue.",
      options,
    );
    this.name = "JournalChangedError";
  }
}

function versionOf(facts: BigIntStats): JournalVersion {
  if (!facts.isFile()) {
    throw new JournalChangedError();
  }
  return {
    device: facts.dev,
    inode: facts.ino,
    size: facts.size,
    modified: facts.mtimeNs,
    changed: facts.ctimeNs,
  };
}

export function* journalVersion(path: string): Operation<JournalVersion> {
  try {
    return versionOf(yield* until(stat(path, { bigint: true })));
  } catch (cause) {
    throw new JournalChangedError({ cause });
  }
}

export function sameJournal(left: JournalVersion, right: JournalVersion): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.size === right.size &&
    left.modified === right.modified &&
    left.changed === right.changed
  );
}

export interface JournalAppend {
  readonly version: JournalVersion;
  readonly sha256: string;
  permit(): void;
  acknowledged(version: JournalVersion): void;
}

/** Check and append through the same descriptor, without creating a missing file. */
export function appendCheckedRecord(
  path: string,
  record: string,
  check: JournalAppend,
): Operation<void> {
  return scoped(function* () {
    let opening: Promise<FileHandle> | undefined;
    let pending: Promise<unknown> | undefined;
    yield* ensure(function* () {
      if (pending !== undefined) {
        yield* until(pending.then(ignore, ignore));
      }
      if (opening !== undefined) {
        const handle = yield* until(opening.then((file) => file, ignore));
        if (handle !== undefined) {
          yield* until(handle.close());
        }
      }
    });
    function* complete<T>(operation: Promise<T>): Operation<T> {
      pending = operation;
      const value = yield* until(operation);
      pending = undefined;
      return value;
    }
    try {
      opening = open(path, constants.O_RDWR | constants.O_APPEND);
      const handle = yield* until(opening);
      const before = versionOf(yield* complete(handle.stat({ bigint: true })));
      if (!sameJournal(before, check.version)) {
        throw new JournalChangedError();
      }
      const hash = createHash("sha256");
      const buffer = new Uint8Array(READ_CHUNK);
      for (let offset = 0; BigInt(offset) < before.size; ) {
        const length = Math.min(READ_CHUNK, Number(before.size) - offset);
        const { bytesRead } = yield* complete(handle.read(buffer, 0, length, offset));
        if (bytesRead === 0) {
          throw new JournalChangedError();
        }
        hash.update(buffer.subarray(0, bytesRead));
        offset += bytesRead;
      }
      const verified = versionOf(yield* complete(handle.stat({ bigint: true })));
      if (
        hash.digest("hex") !== check.sha256 ||
        !sameJournal(before, verified) ||
        !sameJournal(verified, yield* journalVersion(path))
      ) {
        throw new JournalChangedError();
      }
      check.permit();
      yield* complete(handle.writeFile(record, "utf8"));
      const written = versionOf(yield* complete(handle.stat({ bigint: true })));
      if (
        written.size !== before.size + BigInt(Buffer.byteLength(record)) ||
        !sameJournal(written, yield* journalVersion(path))
      ) {
        throw new JournalChangedError();
      }
      check.acknowledged(written);
    } catch (cause) {
      if (cause instanceof JournalChangedError) {
        throw cause;
      }
      throw new JournalChangedError({ cause });
    }
  });
}
