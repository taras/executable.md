import { workerMain } from "@effectionx/worker";
import { type Operation, until, useScope } from "effection";
import { Bash } from "just-bash";
import {
  type WorkspaceFs,
  WorkspaceFsAdapter,
} from "../../351-worker-backends/vendor/worker-shell/adapter.ts";

export interface ShellWorkerData {
  effectId: string;
  invocationId: string;
  command: string;
  cwd: string;
  env: Record<string, string>;
  maxCommandCount?: number;
  maxLoopIterations?: number;
}

export interface ShellWorkerResult {
  outcome: "exit" | "interpreter-error";
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface FsCall {
  kind: "fs-call";
  id: number;
  effectId: string;
  invocationId: string;
  operation: string;
  arguments: unknown[];
}

export interface FsResponse {
  value?: unknown;
  error?: { message: string; code?: string };
}

class WorkerWorkspaceFs implements WorkspaceFs {
  #effectId: string;
  #invocationId: string;
  #send: (call: FsCall) => Promise<FsResponse>;
  #sequence = 0;

  constructor(
    effectId: string,
    invocationId: string,
    send: (call: FsCall) => Promise<FsResponse>,
  ) {
    this.#effectId = effectId;
    this.#invocationId = invocationId;
    this.#send = send;
  }

  readFile(path: string): Promise<ReadableStream<Uint8Array>>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
  readFile(
    path: string,
    options: { encoding?: "utf8" | null },
  ): Promise<string | ReadableStream<Uint8Array>>;
  readFile(
    path: string,
    options?: "utf8" | { encoding?: "utf8" | null },
  ): Promise<string | ReadableStream<Uint8Array>> {
    const encoding = options === "utf8" || options?.encoding === "utf8"
      ? "utf8"
      : undefined;
    return this.#call("readFile", [path, encoding]).then((value) => {
      if (encoding === "utf8") {
        if (typeof value !== "string") {
          throw new Error("readFile text reply was not a string");
        }
        return value;
      }
      if (!(value instanceof Uint8Array)) {
        throw new Error("readFile byte reply was not bytes");
      }
      return new ReadableStream({
        start(controller) {
          controller.enqueue(value);
          controller.close();
        },
      });
    });
  }

  exists(path: string): Promise<boolean> {
    return this.#call("exists", [path]).then(booleanReply);
  }

  stat(path: string): Promise<WorkspaceFsStat> {
    return this.#call("stat", [path]).then(statReply);
  }

  statOrNull(path: string): Promise<WorkspaceFsStat | null> {
    return this.#call("statOrNull", [path]).then(nullableStatReply);
  }

  lstat(path: string): Promise<WorkspaceFsStat> {
    return this.#call("lstat", [path]).then(statReply);
  }

  lstatOrNull(path: string): Promise<WorkspaceFsStat | null> {
    return this.#call("lstatOrNull", [path]).then(nullableStatReply);
  }

  readdir(path: string): Promise<WorkspaceDirent[]> {
    return this.#call("readdir", [path]).then(direntReply);
  }

  find(directory: string, pattern?: string): Promise<WorkspaceFound[]> {
    return this.#call("find", [directory, pattern]).then(foundReply);
  }

  ls(prefix: string): Promise<string[]> {
    return this.#call("ls", [prefix]).then(stringArrayReply);
  }

  grep(
    pattern: string,
    path: string,
    options?: { recursive?: boolean; ignoreCase?: boolean },
  ): Promise<WorkspaceGrep[]> {
    return this.#call("grep", [pattern, path, options]).then(grepReply);
  }

  readlink(path: string): Promise<string> {
    return this.#call("readlink", [path]).then(stringReply);
  }

  writeFile(
    path: string,
    content: string | Uint8Array | ReadableStream<Uint8Array>,
  ): Promise<void> {
    if (content instanceof ReadableStream) {
      return Promise.reject(
        new Error("streaming shell writes are outside this transaction proof"),
      );
    }
    return this.#call("writeFile", [path, content]).then(voidReply);
  }

  mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    return this.#call("mkdir", [path, options]).then(voidReply);
  }

  rm(
    path: string,
    options?: { recursive?: boolean; force?: boolean },
  ): Promise<void> {
    return this.#call("rm", [path, options]).then(voidReply);
  }

  chmod(path: string, mode: number): Promise<void> {
    return this.#call("chmod", [path, mode]).then(voidReply);
  }

  symlink(target: string, path: string): Promise<void> {
    return this.#call("symlink", [target, path]).then(voidReply);
  }

  #call(operation: string, arguments_: unknown[]): Promise<unknown> {
    const response = this.#send({
      kind: "fs-call",
      id: ++this.#sequence,
      effectId: this.#effectId,
      invocationId: this.#invocationId,
      operation,
      arguments: arguments_,
    });
    return response.then((reply) => {
      if (reply.error !== undefined) {
        const error = new Error(reply.error.message);
        if (reply.error.code !== undefined) {
          Object.defineProperty(error, "code", { value: reply.error.code });
        }
        throw error;
      }
      return reply.value;
    });
  }
}

class JustBashWorkspaceFsAdapter extends WorkspaceFsAdapter {
  override readFile(path: string, options?: unknown): Promise<string> {
    return super.readFile(path, options === "utf8" ? "utf8" : undefined);
  }
}

interface WorkspaceFsStat {
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
  mode: number;
  size: number;
  mtime: number;
}

interface WorkspaceDirent {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink?: boolean;
}

interface WorkspaceFound {
  path: string;
  type: "file" | "dir";
}

interface WorkspaceGrep {
  path: string;
  line: number;
  text: string;
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function booleanReply(value: unknown): boolean {
  if (typeof value !== "boolean") {
    throw new Error("filesystem reply was not a boolean");
  }
  return value;
}

function stringReply(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("filesystem reply was not a string");
  }
  return value;
}

function stringArrayReply(value: unknown): string[] {
  if (
    !Array.isArray(value) || !value.every((entry) => typeof entry === "string")
  ) {
    throw new Error("filesystem reply was not a string array");
  }
  return value;
}

function statReply(value: unknown): WorkspaceFsStat {
  if (
    typeof value !== "object" || value === null || !("isFile" in value) ||
    typeof value.isFile !== "boolean" || !("isDirectory" in value) ||
    typeof value.isDirectory !== "boolean" || !("isSymbolicLink" in value) ||
    typeof value.isSymbolicLink !== "boolean" || !("mode" in value) ||
    typeof value.mode !== "number" || !("size" in value) ||
    typeof value.size !== "number" || !("mtime" in value) ||
    typeof value.mtime !== "number"
  ) {
    throw new Error("filesystem stat reply has an invalid shape");
  }
  return {
    isFile: value.isFile,
    isDirectory: value.isDirectory,
    isSymbolicLink: value.isSymbolicLink,
    mode: value.mode,
    size: value.size,
    mtime: value.mtime,
  };
}

function nullableStatReply(value: unknown): WorkspaceFsStat | null {
  return value === null ? null : statReply(value);
}

function direntReply(value: unknown): WorkspaceDirent[] {
  if (!Array.isArray(value)) {
    throw new Error("readdir reply was not an array");
  }
  return value.map(parseDirent);
}

function parseDirent(value: unknown): WorkspaceDirent {
  if (
    typeof value !== "object" || value === null || !("name" in value) ||
    typeof value.name !== "string" || !("isFile" in value) ||
    typeof value.isFile !== "boolean" || !("isDirectory" in value) ||
    typeof value.isDirectory !== "boolean"
  ) {
    throw new Error("directory entry reply has an invalid shape");
  }
  const entry: WorkspaceDirent = {
    name: value.name,
    isFile: value.isFile,
    isDirectory: value.isDirectory,
  };
  if ("isSymbolicLink" in value && typeof value.isSymbolicLink === "boolean") {
    entry.isSymbolicLink = value.isSymbolicLink;
  }
  return entry;
}

function foundReply(value: unknown): WorkspaceFound[] {
  if (!Array.isArray(value)) {
    throw new Error("find reply was not an array");
  }
  return value.map((entry) => {
    if (
      typeof entry !== "object" || entry === null || !("path" in entry) ||
      typeof entry.path !== "string" || !("type" in entry) ||
      (entry.type !== "file" && entry.type !== "dir")
    ) {
      throw new Error("find reply has an invalid shape");
    }
    return { path: entry.path, type: entry.type };
  });
}

function grepReply(value: unknown): WorkspaceGrep[] {
  if (!Array.isArray(value)) {
    throw new Error("grep reply was not an array");
  }
  return value.map((entry) => {
    if (
      typeof entry !== "object" || entry === null || !("path" in entry) ||
      typeof entry.path !== "string" || !("line" in entry) ||
      typeof entry.line !== "number" || !("text" in entry) ||
      typeof entry.text !== "string"
    ) {
      throw new Error("grep reply has an invalid shape");
    }
    return { path: entry.path, line: entry.line, text: entry.text };
  });
}

function voidReply(_value: unknown): void {}

await workerMain<
  never,
  never,
  ShellWorkerResult,
  ShellWorkerData,
  FsCall,
  FsResponse
>(
  function* ({ data, send }): Operation<ShellWorkerResult> {
    const scope = yield* useScope();
    const fs = new WorkerWorkspaceFs(
      data.effectId,
      data.invocationId,
      (call) => scope.run(() => send(call)),
    );
    const bash = new Bash({
      fs: new JustBashWorkspaceFsAdapter(fs),
      cwd: data.cwd,
      defenseInDepth: { enabled: false },
      executionLimits: {
        maxOutputSize: 1024 * 1024,
        maxCommandCount: data.maxCommandCount,
        maxLoopIterations: data.maxLoopIterations,
      },
    });

    try {
      const result = yield* until(
        bash.exec(data.command, { cwd: data.cwd, env: data.env }),
      );
      return {
        outcome: "exit",
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      };
    } catch (error) {
      return {
        outcome: "interpreter-error",
        stdout: "",
        stderr: `${errorMessage(error)}\n`,
        exitCode: 1,
      };
    }
  },
);
