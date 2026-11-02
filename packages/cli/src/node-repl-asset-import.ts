import { copyFile, link, mkdir, mkdtemp, realpath } from "node:fs/promises";
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

function* destinationPath(
  root: string,
  destination: string,
  native: typeof nativeOperations,
): Operation<string> {
  if (destination.length === 0 || isAbsolute(destination)) {
    throw new ImportRefusal("Choose a nonempty workspace-relative import destination.");
  }
  const target = resolve(root, destination);
  if (target === root || !inside(root, target)) {
    throw new ImportRefusal("Choose an import destination inside the session workspace.");
  }
  let parent = dirname(target);
  while (true) {
    try {
      const actual = yield* joined(() => native.realpath(parent));
      if (!inside(root, actual)) {
        throw new ImportRefusal(
          "The import destination parent leaves the session workspace. Choose another destination.",
        );
      }
      break;
    } catch (error) {
      if (!code(error, "ENOENT")) {
        throw error;
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
      message: `Source: ${source}\nDestination: ${target}\nWorkspace path after import: ${destination}\nImport copies this file into your session workspace.`,
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
