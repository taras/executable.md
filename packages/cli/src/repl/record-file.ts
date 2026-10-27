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
import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";

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

function useFileChunks(path: string): Operation<FileChunks> {
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
    yield* provide({
      *next(): Operation<Uint8Array | undefined> {
        const read = handle.read(buffer, 0, READ_CHUNK, null);
        reading = read;
        const { bytesRead } = yield* until(read);
        reading = undefined;
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
  /** The file holds more text than `limit` allows. */
  exceeded(): Error;
  /** A line is not UTF-8, when decoding is strict. */
  undecodable?(): Error;
}

export interface LineOptions {
  /**
   * The most UTF-16 code units the file may decode to, newlines included.
   *
   * Counted as the file is read and checked before each piece of a line joins
   * the rest, so a file past the limit is refused without building a string
   * past it. Code units rather than bytes, because the ceiling this guards is a
   * string length and a byte count is a different number for the same text.
   */
  readonly limit: number;
  /** Refuse bytes that are not UTF-8, rather than replacing them. */
  readonly strict?: boolean;
  readonly refusals: LineRefusals;
  /** Sees each chunk's raw bytes, in order, before any of it is decoded. */
  readonly observe?: (chunk: Uint8Array) => void;
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
    const chunks = yield* useFileChunks(path);
    // One decoder for the whole file. A leading byte order mark is kept, as a
    // whole-file read keeps it, so a file that begins with one reads the same.
    const decoder = new TextDecoder("utf-8", {
      fatal: options.strict === true,
      ignoreBOM: true,
    });
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
      if (units > options.limit) {
        throw options.refusals.exceeded();
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
        decode(chunk.subarray(start, end), false);
        units += 1;
        if (units > options.limit) {
          throw options.refusals.exceeded();
        }
        const line = pieces.join("");
        pieces = [];
        lines += 1;
        unfinished = false;
        start = end + 1;
        yield* visit(line);
      }
      if (start < chunk.length) {
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
