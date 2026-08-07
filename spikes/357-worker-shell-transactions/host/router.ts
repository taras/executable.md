import { type Operation, until } from "effection";
import type { WorkspaceFsShim } from "./workspace-fs.ts";
import type { EffectTransaction } from "./storage.ts";

export interface FsReply {
  kind: "fs-reply";
  id: number;
  value?: unknown;
  error?: string;
}

interface FsCall {
  kind: "fs-call";
  id: number;
  effectId: string;
  invocationId: string;
  operation: string;
  arguments: unknown[];
}

export interface RouterOptions {
  onMutation?: (operation: string) => void;
}

export class EffectFsRouter {
  #fs: WorkspaceFsShim;
  #transaction: EffectTransaction;
  #invocationId: string;
  #state: "active" | "completed" | "cancelled" = "active";
  #onMutation: ((operation: string) => void) | undefined;

  constructor(
    fs: WorkspaceFsShim,
    transaction: EffectTransaction,
    invocationId: string,
    options: RouterOptions = {},
  ) {
    this.#fs = fs;
    this.#transaction = transaction;
    this.#invocationId = invocationId;
    this.#onMutation = options.onMutation;
  }

  get invocationId(): string {
    return this.#invocationId;
  }

  get effectId(): string {
    return this.#transaction.effectId;
  }

  complete(): void {
    this.#state = "completed";
  }

  cancel(): void {
    this.#state = "cancelled";
  }

  *route(value: unknown): Operation<FsReply> {
    const call = parseCall(value);
    this.#assertRoute(call);
    const result = yield* this.#dispatch(call);
    if (isMutation(call.operation)) {
      this.#onMutation?.(call.operation);
    }
    return { kind: "fs-reply", id: call.id, value: result };
  }

  #assertRoute(call: FsCall): void {
    if (this.#state === "completed") {
      throw new Error(`effect transaction ${this.effectId} is completed`);
    }
    if (this.#state === "cancelled") {
      throw new Error(`effect transaction ${this.effectId} is cancelled`);
    }
    this.#transaction.assertMutationOwner(call.effectId);
    if (call.invocationId !== this.#invocationId) {
      throw new Error(
        `stale invocation ${call.invocationId}; active invocation is ${this.#invocationId}`,
      );
    }
  }

  *#dispatch(call: FsCall): Operation<unknown> {
    const args = call.arguments;
    switch (call.operation) {
      case "readFile": {
        const path = stringArgument(args, 0, "path");
        const encoding = args[1];
        if (encoding === "utf8") {
          return yield* until(this.#fs.readFile(path, "utf8"));
        }
        if (encoding !== undefined && encoding !== null) {
          throw new Error("readFile encoding must be utf8 or absent");
        }
        const stream = yield* until(this.#fs.readFile(path));
        const buffer = yield* until(new Response(stream).arrayBuffer());
        return new Uint8Array(buffer);
      }
      case "exists":
        return yield* until(this.#fs.exists(stringArgument(args, 0, "path")));
      case "stat":
        return yield* until(this.#fs.stat(stringArgument(args, 0, "path")));
      case "statOrNull":
        return yield* until(
          this.#fs.statOrNull(stringArgument(args, 0, "path")),
        );
      case "lstat":
        return yield* until(this.#fs.lstat(stringArgument(args, 0, "path")));
      case "lstatOrNull":
        return yield* until(
          this.#fs.lstatOrNull(stringArgument(args, 0, "path")),
        );
      case "readdir":
        return yield* until(this.#fs.readdir(stringArgument(args, 0, "path")));
      case "find":
        return yield* until(
          this.#fs.find(
            stringArgument(args, 0, "directory"),
            optionalStringArgument(args, 1, "pattern"),
          ),
        );
      case "ls":
        return yield* until(this.#fs.ls(stringArgument(args, 0, "prefix")));
      case "grep":
        return yield* until(
          this.#fs.grep(
            stringArgument(args, 0, "pattern"),
            stringArgument(args, 1, "path"),
            grepOptions(args[2]),
          ),
        );
      case "readlink":
        return yield* until(this.#fs.readlink(stringArgument(args, 0, "path")));
      case "writeFile":
        yield* until(
          this.#fs.writeFile(
            stringArgument(args, 0, "path"),
            contentArgument(args, 1),
          ),
        );
        return undefined;
      case "mkdir":
        yield* until(
          this.#fs.mkdir(
            stringArgument(args, 0, "path"),
            recursiveOptions(args[1]),
          ),
        );
        return undefined;
      case "rm":
        yield* until(
          this.#fs.rm(
            stringArgument(args, 0, "path"),
            recursiveOptions(args[1]),
          ),
        );
        return undefined;
      case "chmod":
        yield* until(
          this.#fs.chmod(
            stringArgument(args, 0, "path"),
            numberArgument(args, 1, "mode"),
          ),
        );
        return undefined;
      case "symlink":
        yield* until(
          this.#fs.symlink(
            stringArgument(args, 0, "target"),
            stringArgument(args, 1, "path"),
          ),
        );
        return undefined;
      default:
        throw new Error(`unsupported filesystem operation: ${call.operation}`);
    }
  }
}

function parseCall(value: unknown): FsCall {
  if (typeof value !== "object" || value === null) {
    throw new Error("filesystem RPC must be an object");
  }
  if (!("kind" in value) || value.kind !== "fs-call") {
    throw new Error("message is not a filesystem RPC");
  }
  if (!("id" in value) || typeof value.id !== "number") {
    throw new Error("filesystem RPC is missing its request id");
  }
  if (!("effectId" in value) || typeof value.effectId !== "string") {
    throw new Error("filesystem RPC is missing its effect identity");
  }
  if (!("invocationId" in value) || typeof value.invocationId !== "string") {
    throw new Error("filesystem RPC is missing its invocation identity");
  }
  if (!("operation" in value) || typeof value.operation !== "string") {
    throw new Error("filesystem RPC is missing its operation");
  }
  if (!("arguments" in value) || !Array.isArray(value.arguments)) {
    throw new Error("filesystem RPC arguments must be an array");
  }
  return {
    kind: "fs-call",
    id: value.id,
    effectId: value.effectId,
    invocationId: value.invocationId,
    operation: value.operation,
    arguments: value.arguments,
  };
}

function stringArgument(args: unknown[], index: number, name: string): string {
  const value = args[index];
  if (typeof value !== "string") {
    throw new Error(`${name} must be a string`);
  }
  return value;
}

function optionalStringArgument(
  args: unknown[],
  index: number,
  name: string,
): string | undefined {
  const value = args[index];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`${name} must be a string`);
  }
  return value;
}

function numberArgument(args: unknown[], index: number, name: string): number {
  const value = args[index];
  if (typeof value !== "number") {
    throw new Error(`${name} must be a number`);
  }
  return value;
}

function contentArgument(args: unknown[], index: number): string | Uint8Array {
  const value = args[index];
  if (typeof value === "string" || value instanceof Uint8Array) {
    return value;
  }
  throw new Error("writeFile content must be text or bytes");
}

function recursiveOptions(value: unknown): { recursive?: boolean } | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "object") {
    throw new Error("filesystem options must be an object");
  }
  if (!("recursive" in value) || value.recursive === undefined) {
    return {};
  }
  if (typeof value.recursive !== "boolean") {
    throw new Error("recursive must be a boolean");
  }
  return { recursive: value.recursive };
}

function grepOptions(
  value: unknown,
): { recursive?: boolean; ignoreCase?: boolean } | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "object") {
    throw new Error("grep options must be an object");
  }
  const options: { recursive?: boolean; ignoreCase?: boolean } = {};
  if ("recursive" in value && typeof value.recursive === "boolean") {
    options.recursive = value.recursive;
  }
  if ("ignoreCase" in value && typeof value.ignoreCase === "boolean") {
    options.ignoreCase = value.ignoreCase;
  }
  return options;
}

function isMutation(operation: string): boolean {
  return operation === "writeFile" || operation === "mkdir" ||
    operation === "rm" || operation === "chmod" || operation === "symlink";
}
