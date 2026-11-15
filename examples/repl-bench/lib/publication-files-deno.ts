import { lstat } from "@effectionx/fs";
import { ensure, scoped, until, type Operation } from "effection";
import { constants } from "node:fs";
import { open, link, writeFile } from "node:fs/promises";
import process from "node:process";
import { crc32 } from "node:zlib";
import { dirname, join } from "node:path";
import { useTempDirectory } from "../../../scripts/lib/temp-directory.ts";

export function inheritedEnvironment(overrides: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries({ ...process.env, ...overrides }).flatMap(([name, value]) =>
      typeof value === "string" ? [[name, value]] : [],
    ),
  );
}

export function readRegular(path: string, limit: number): Operation<Uint8Array> {
  return scoped(function* () {
    const selected = yield* lstat(path);
    if (!selected.isFile() || selected.size > limit) {
      throw new Error("Use a readable, regular evidence file within the size limit.");
    }
    let opening: ReturnType<typeof open> | undefined;
    yield* ensure(function* () {
      const file = opening === undefined ? undefined : yield* until(opening.catch(() => undefined));
      if (file !== undefined) {
        yield* until(file.close());
      }
    });
    opening = open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const file = yield* until(opening);
    const observed = yield* until(file.stat());
    if (
      !observed.isFile() ||
      selected.ino !== observed.ino ||
      selected.dev !== observed.dev ||
      observed.size > limit
    ) {
      throw new Error("The selected evidence file changed during opening.");
    }
    const buffer = new Uint8Array(observed.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = yield* until(file.read({ buffer, offset }));
      if (bytesRead === 0) {
        break;
      }
      offset += bytesRead;
    }
    if (offset !== observed.size) {
      throw new Error("The selected evidence file changed during reading.");
    }
    return buffer.subarray(0, offset);
  });
}

export function writeExclusive(path: string, contents: string | Uint8Array): Operation<void> {
  return scoped(function* () {
    let writing: ReturnType<typeof writeFile> | undefined;
    yield* ensure(function* () {
      if (writing !== undefined) {
        yield* until(writing.catch(() => undefined));
      }
    });
    writing = writeFile(path, contents, { flag: "wx", mode: 0o600 });
    yield* until(writing);
  });
}

export function recordDraft(path: string, value: string): Operation<void> {
  return scoped(function* () {
    const directory = yield* useTempDirectory(".repl-ui-draft-", { dir: dirname(path) });
    const file = join(directory, "draft.json");
    yield* writeExclusive(file, value);
    let linking: ReturnType<typeof link> | undefined;
    yield* ensure(function* () {
      if (linking !== undefined) {
        yield* until(linking.catch(() => undefined));
      }
    });
    try {
      linking = link(file, path);
      yield* until(linking);
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") {
        throw error;
      }
      const previous = yield* readRegular(path, 4096);
      if (new TextDecoder().decode(previous) !== value) {
        throw new Error("The requested draft record already names a different publication.");
      }
    }
  });
}

export function png(bytes: Uint8Array): boolean {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 45 || !signature.every((byte, index) => bytes[index] === byte)) {
    return false;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    view.getUint32(8) !== 13 ||
    view.getUint32(12) !== 0x49484452 ||
    view.getUint32(16) === 0 ||
    view.getUint32(20) === 0
  ) {
    return false;
  }
  let hasImageData = false;
  for (let at = 8; at + 12 <= bytes.length; ) {
    const length = view.getUint32(at);
    const type = view.getUint32(at + 4);
    const end = at + length + 12;
    if (end > bytes.length || crc32(bytes.subarray(at + 4, end - 4)) !== view.getUint32(end - 4)) {
      return false;
    }
    if (type === 0x49444154 && length > 0) {
      hasImageData = true;
    }
    if (type === 0x49454e44) {
      return hasImageData && length === 0 && end === bytes.length;
    }
    at = end;
  }
  return false;
}
