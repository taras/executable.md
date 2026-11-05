import { ensure, scoped, until } from "effection";
import type { Operation } from "effection";
import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
interface NativeTextHandle {
  read(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: null,
  ): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
}

export function readFinite(
  path: string,
  limit: number,
  acquire: (path: string) => Promise<NativeTextHandle> = (selected) => open(selected, "r"),
): Operation<string> {
  return scoped(function* () {
    let opening: Promise<NativeTextHandle> | undefined;
    let reading: Promise<unknown> | undefined;
    yield* ensure(function* () {
      if (opening === undefined) {
        return;
      }
      if (reading !== undefined) {
        yield* until(reading.then(ignore, ignore));
      }
      const handle = yield* until(opening.then((value) => value, ignore));
      if (handle !== undefined) {
        yield* until(handle.close());
      }
    });
    // @effectionx/fs has no incremental handle reader.
    opening = acquire(path);
    const handle = yield* until(opening);
    const buffer = new Uint8Array(limit + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const pending = handle.read(buffer, offset, Math.min(65_536, buffer.length - offset), null);
      reading = pending;
      const result = yield* until(pending);
      reading = undefined;
      if (result.bytesRead === 0) {
        break;
      }
      offset += result.bytesRead;
    }
    if (offset > limit) {
      throw new Error("Ticket text exceeds its UTF-8 capacity.");
    }
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      buffer.subarray(0, offset),
    );
  });
}

function ignore(): undefined {
  return undefined;
}

export function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
