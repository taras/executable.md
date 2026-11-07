import { API, parseFilesFailure, parseFileWriteSuccess } from "@executablemd/runtime";
import { scanSecrets, secretPolicy } from "@executablemd/core";
import { scoped } from "effection";
import type { Operation } from "effection";
import { z } from "zod";
import { digest, readFinite } from "./native-node.ts";

export const textLimit = 8_388_608;
export const stateLimit = 1_048_576;
export const descriptor = z
  .object({
    path: z.string().min(1),
    utf8Bytes: z.number().int().min(0).max(textLimit),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export const snapshot = descriptor
  .extend({ snapshot: z.string().startsWith("/"), observation: z.enum(["file", "supplied"]) })
  .strict();

export function describe(path: string, text: string) {
  const bytes = new TextEncoder().encode(text);
  return { path, utf8Bytes: bytes.length, sha256: digest(bytes) };
}

export function* clear(text: string): Operation<void> {
  if (!(yield* secretPolicy()).enabled || (yield* scanSecrets(text)).length !== 0) {
    throw new Error("Ticket text did not clear enabled protection.");
  }
}

function address(repository: string, path: string) {
  if (!path.startsWith("/")) {
    return { cwd: repository, path };
  }
  const slash = path.lastIndexOf("/");
  return { cwd: path.slice(0, slash) || "/", path: path.slice(slash + 1) };
}

export function read(repository: string, path: string, limit = textLimit): Operation<string> {
  return scoped(function* () {
    yield* API.Fs.around({
      *readTextFile([selected]) {
        return yield* readFinite(selected, limit);
      },
    });
    const result = yield* API.Files.operations.readTextFile(address(repository, path));
    if (!result.ok) {
      throw result.error;
    }
    yield* clear(result.value);
    return result.value;
  });
}

export function* write(repository: string, path: string, text: string): Operation<void> {
  yield* clear(text);
  const result = yield* API.Files.operations.writeTextFile({
    ...address(repository, path),
    content: text,
  });
  if (!result.ok) {
    throw result.error;
  }
  if (parseFileWriteSuccess(result.value)?.publication !== "host-committed") {
    throw new Error("Ticket publication requires a confirmed native host write.");
  }
}

export function unused(repository: string, path: string): Operation<boolean> {
  return scoped(function* () {
    yield* API.Fs.around({
      *readTextFile([selected]) {
        return yield* readFinite(selected, 1);
      },
    });
    const result = yield* API.Files.operations.readTextFile(address(repository, path));
    return !result.ok && parseFilesFailure(result.error)?.reason === "missing";
  });
}
