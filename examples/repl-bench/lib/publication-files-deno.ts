import { lstat } from "@effectionx/fs";
import { ensure, scoped, until, type Operation } from "effection";
import { constants } from "node:fs";
import { open, link, writeFile } from "node:fs/promises";
import process from "node:process";
import { crc32, Inflate, inflateSync } from "node:zlib";
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

const MAX_FILTERED_PNG_BYTES = 64 * 1024 * 1024;

const pngColorTypes: ReadonlyMap<number, { samples: number; depths: number[] }> = new Map([
  [0, { samples: 1, depths: [1, 2, 4, 8, 16] }],
  [2, { samples: 3, depths: [8, 16] }],
  [3, { samples: 1, depths: [1, 2, 4, 8] }],
  [4, { samples: 2, depths: [8, 16] }],
  [6, { samples: 4, depths: [8, 16] }],
]);

const adam7 = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
];

function validScanlines(header: DataView, compressed: Uint8Array): boolean {
  const width = header.getUint32(16);
  const height = header.getUint32(20);
  const depth = header.getUint8(24);
  const layout = pngColorTypes.get(header.getUint8(25));
  const interlace = header.getUint8(28);
  if (
    layout === undefined ||
    !layout.depths.includes(depth) ||
    header.getUint8(26) !== 0 ||
    header.getUint8(27) !== 0 ||
    interlace > 1
  ) {
    return false;
  }

  let expected = 0;
  const passes = [];
  for (const [x, y, dx, dy] of interlace === 0 ? [[0, 0, 1, 1]] : adam7) {
    if (x >= width || y >= height) {
      continue;
    }
    const columns = Math.ceil((width - x) / dx);
    const rows = Math.ceil((height - y) / dy);
    const stride = 1 + Math.ceil((columns * layout.samples * depth) / 8);
    if (rows > (MAX_FILTERED_PNG_BYTES - expected) / stride) {
      return false;
    }
    passes.push({ rows, stride });
    expected += rows * stride;
  }

  try {
    const decoded: unknown = inflateSync(compressed, { maxOutputLength: expected, info: true });
    if (
      typeof decoded !== "object" ||
      decoded === null ||
      !("buffer" in decoded) ||
      !(decoded.buffer instanceof Uint8Array) ||
      !("engine" in decoded) ||
      !(decoded.engine instanceof Inflate) ||
      decoded.engine.bytesWritten !== compressed.length ||
      decoded.buffer.length !== expected
    ) {
      return false;
    }
    let offset = 0;
    for (const { rows, stride } of passes) {
      for (let row = 0; row < rows; row++, offset += stride) {
        if (decoded.buffer[offset] > 4) {
          return false;
        }
      }
    }
    return true;
  } catch {
    return false;
  }
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
  const compressed = new Uint8Array(bytes.length);
  let compressedLength = 0;
  for (let at = 8; at + 12 <= bytes.length; ) {
    const length = view.getUint32(at);
    const type = view.getUint32(at + 4);
    const end = at + length + 12;
    if (end > bytes.length || crc32(bytes.subarray(at + 4, end - 4)) !== view.getUint32(end - 4)) {
      return false;
    }
    if (type === 0x49444154 && length > 0) {
      compressed.set(bytes.subarray(at + 8, end - 4), compressedLength);
      compressedLength += length;
    }
    if (type === 0x49454e44) {
      return (
        compressedLength > 0 &&
        length === 0 &&
        end === bytes.length &&
        validScanlines(view, compressed.subarray(0, compressedLength))
      );
    }
    at = end;
  }
  return false;
}
