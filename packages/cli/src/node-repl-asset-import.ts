import { copyFile, link, mkdir, mkdtemp, open, realpath, type FileHandle } from "node:fs/promises";
import { constants } from "node:fs";
import { Buffer } from "node:buffer";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { lstat, rm, stat } from "@effectionx/fs";
import { elicit, isJsonObject } from "@executablemd/core";
import { cwd } from "@executablemd/runtime";
import { Permissions } from "@executablemd/runtime/api";
import { ensure, Err, Ok, scoped, until } from "effection";
import type { Operation, Result } from "effection";
import { ReplHost } from "./repl/host.ts";
import type { AssetImportRequest } from "./repl/host.ts";

const nativeOperations = {
  copyFile,
  link,
  mkdir: (path: string, options: { recursive: true }) => mkdir(path, options),
  mkdtemp: (path: string) => mkdtemp(path),
  realpath: (path: string) => realpath(path),
};

export function* useNodeReplAssetImport(native = nativeOperations): Operation<void> {
  yield* ReplHost.around(
    {
      importAsset: ([request]) => importAsset(request, native),
      readAsset: ([workspace, path, maxBytes]) => readAsset(workspace, path, maxBytes, native),
    },
    { at: "min" },
  );
}

function joined<T>(start: () => Promise<T>, adopt: (value: T) => void = () => {}): Operation<T> {
  return scoped(function* () {
    let pending: Promise<T> | undefined;
    yield* ensure(function* () {
      if (pending !== undefined) {
        yield* until(
          pending.then(
            () => undefined,
            () => undefined,
          ),
        );
      }
    });
    pending = start().then((value) => {
      adopt(value);
      return value;
    });
    return yield* until(pending);
  });
}

function* allowed(): Operation<void> {
  if (
    !(yield* Permissions.operations.files("read")) ||
    !(yield* Permissions.operations.files("write"))
  ) {
    throw new ImportRefusal("Asset import requires effective file read and write permission.");
  }
}

function inside(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return (
    suffix === "" || (!isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`))
  );
}

function code(error: unknown, name: string): boolean {
  return error instanceof Error && "code" in error && error.code === name;
}

function* vacant(path: string): Operation<void> {
  try {
    yield* lstat(path);
  } catch (error) {
    if (code(error, "ENOENT")) {
      return;
    }
    throw error;
  }
  throw new ImportRefusal(
    "The import destination is occupied. Choose another explicit destination and obtain new approval.",
  );
}

function destinationTarget(root: string, destination: string): string {
  if (destination.length === 0 || isAbsolute(destination)) {
    throw new ImportRefusal("Choose a session-relative import destination beneath assets/.");
  }
  const target = resolve(root, destination);
  const assets = join(root, "assets");
  if (target === assets || !inside(assets, target)) {
    throw new ImportRefusal("Choose an import destination beneath this session's assets/.");
  }
  return target;
}

function* destinationPath(
  root: string,
  destination: string,
  native: typeof nativeOperations,
): Operation<string> {
  const target = destinationTarget(root, destination);
  const assets = join(root, "assets");
  let parent = dirname(target);
  while (true) {
    try {
      const actual = yield* joined(() => native.realpath(parent));
      if (parent === root ? actual !== root : !inside(assets, actual)) {
        throw new ImportRefusal(
          "The import destination parent leaves this session's assets/. Choose another destination.",
        );
      }
      break;
    } catch (error) {
      if (!code(error, "ENOENT")) {
        throw error;
      }
      let present = false;
      try {
        yield* lstat(parent);
        present = true;
      } catch (missing) {
        if (!code(missing, "ENOENT")) {
          throw missing;
        }
      }
      if (present) {
        throw new ImportRefusal("The import destination parent cannot be resolved inside assets/.");
      }
      const next = dirname(parent);
      if (next === parent) {
        throw error;
      }
      parent = next;
    }
  }
  yield* vacant(target);
  return target;
}

function importAsset(
  request: AssetImportRequest,
  native: typeof nativeOperations,
): Operation<Result<string>> {
  const { workspace, source: offeredSource, destination } = request;
  return scoped(function* () {
    let source: string;
    let root: string;
    let target: string;
    try {
      if (
        typeof offeredSource !== "string" ||
        offeredSource.length === 0 ||
        typeof destination !== "string" ||
        typeof workspace !== "string" ||
        workspace.length === 0
      ) {
        throw new ImportRefusal(
          "Import requires a source, a destination and this session's workspace.",
        );
      }
      yield* allowed();
      destinationTarget(resolve(workspace), destination);
      const current = yield* cwd();
      source = yield* joined(() => native.realpath(resolve(current, offeredSource)));
      if (!(yield* stat(source)).isFile()) {
        throw new ImportRefusal("Choose a regular source file to import.");
      }
      root = yield* joined(() => native.realpath(workspace));
      target = yield* destinationPath(root, destination, native);
    } catch (error) {
      return refused(error);
    }
    const answer = yield* elicit({
      schema: {
        type: "object",
        properties: {
          decision: { type: "string", title: "Import this file?", enum: ["Import", "Decline"] },
        },
        required: ["decision"],
        additionalProperties: false,
      },
      message: `Source: ${source}\nDestination: ${target}\nWorkspace path after import: ${destination}\nImport copies this file into your session assets folder.`,
    });
    if (!isJsonObject(answer) || answer.decision !== "Import") {
      return Err(new Error("Asset import declined. No file was copied."));
    }
    let temporary: string | undefined;
    yield* ensure(function* () {
      if (temporary !== undefined) {
        yield* rm(temporary, { recursive: true, force: true });
      }
    });
    try {
      yield* allowed();
      if (!(yield* stat(source)).isFile()) {
        throw new ImportRefusal(
          "The approved source is no longer a regular file. Request a new import.",
        );
      }
      target = yield* destinationPath(root, destination, native);
      yield* joined(() => native.mkdir(dirname(target), { recursive: true }));
      yield* joined(
        () => native.mkdtemp(join(dirname(target), ".xmd-import-")),
        (path) => {
          temporary = path;
        },
      );
      if (temporary === undefined) {
        throw new Error("Asset import staging was not acquired.");
      }
      const payload = join(temporary, "payload");
      yield* joined(() => native.copyFile(source, payload));
      yield* allowed();
      target = yield* destinationPath(root, destination, native);
      try {
        yield* joined(() => native.link(payload, target));
      } catch (error) {
        if (code(error, "EEXIST")) {
          return Err(
            new Error(
              "The import destination became occupied. Choose another explicit destination and obtain new approval.",
            ),
          );
        }
        throw new PublicationError(error);
      }
    } catch (error) {
      if (error instanceof PublicationError) {
        throw error;
      }
      return refused(error);
    }
    return Ok(destination);
  });
}

class PublicationError extends Error {
  constructor(cause: unknown) {
    super(
      "Asset import publication could not be established. Inspect the destination before requesting another import.",
      { cause },
    );
  }
}

class ImportRefusal extends Error {}

function refused(error: unknown): Result<never> {
  if (
    error instanceof ImportRefusal ||
    (error instanceof Error && "code" in error && typeof error.code === "string")
  ) {
    return Err(error);
  }
  throw error;
}

function* readAsset(
  workspace: string,
  path: string,
  maxBytes: number,
  native: typeof nativeOperations,
): Operation<Uint8Array> {
  if (
    path.includes("\\") ||
    path.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error("Choose a path relative to the session's assets directory.");
  }
  if (!(yield* Permissions.operations.files("read"))) {
    throw new Error("Reading a session asset requires Files read permission.");
  }
  const root = yield* joined(() => native.realpath(workspace));
  const target = destinationTarget(root, join("assets", path));
  const source = yield* joined(() => native.realpath(target));
  if (source !== target) {
    throw new Error("Choose an asset stored under the session assets directory without symlinks.");
  }
  return yield* scoped(function* () {
    let pending: Promise<FileHandle> | undefined;
    yield* ensure(function* () {
      if (pending === undefined) {
        return;
      }
      const handle = yield* until(pending.catch(() => undefined));
      if (handle !== undefined) {
        yield* until(handle.close());
      }
    });
    pending = open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const handle = yield* until(pending);
    const info = yield* until(handle.stat());
    if (!info.isFile() || info.size > maxBytes) {
      throw new Error(`Choose a regular session asset of at most ${maxBytes} bytes.`);
    }
    const bytes = Buffer.alloc(info.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = yield* until(handle.read(bytes, offset, bytes.length - offset, offset));
      if (bytesRead === 0) {
        break;
      }
      offset += bytesRead;
    }
    if (offset !== info.size) {
      throw new Error("The session asset size changed while reading it. Try again.");
    }
    return bytes.subarray(0, offset);
  });
}
