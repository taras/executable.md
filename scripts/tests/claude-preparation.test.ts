import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { scoped, spawn, suspend, until, withResolvers } from "effection";
import { readTextFile, writeTextFile, readdir } from "@effectionx/fs";
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { Buffer } from "node:buffer";
import { useTempDirectory } from "@executablemd/test-support/temp";
import { ClaudeRecipe, recipeInputsSha256 } from "../lib/claude-recipe.ts";
import { publishClaude, verifyHash } from "../lib/prepare-claude.ts";
import { FileWrites } from "../lib/staged-write.ts";
import { claudeSnapshotModule, sha256 } from "../lib/claude-snapshot-module.ts";

function recipe(bytes: Uint8Array): ClaudeRecipe {
  const parsed = ClaudeRecipe.parse({
    format: 1,
    inputsSha256: "0".repeat(64),
    metadata: {},
    source: { url: "https://example.com/source", sha256: "0".repeat(64), bytes: 1 },
    sdk: { url: "https://example.com/sdk", sha256: "0".repeat(64), bytes: 1, integrity: "test" },
    upstreamCommit: "test",
    upstreamTree: "test",
    reviewedProducer: "test",
    compiler: { version: "6.0.3", resolved: "https://example.com/ts", integrity: "test" },
    sourceLockSha256: "0".repeat(64),
    patchSha256: "0".repeat(64),
    transformSha256: "0".repeat(64),
    preimages: {},
    postimages: {},
    runtime: {},
    sdkModuleSha256: "0".repeat(64),
    sdkDeclarationsSha256: "0".repeat(64),
    noticeSha256: "0".repeat(64),
    files: [],
    expected: {
      sha256: sha256(bytes),
      byteLength: bytes.length,
      moduleSha256: sha256(claudeSnapshotModule(bytes)),
    },
  });
  parsed.inputsSha256 = recipeInputsSha256(parsed);
  return parsed;
}

describe("Claude preparation publication", () => {
  it("hashes recipe inputs independently of expected outputs", function* () {
    const value = recipe(Buffer.from("input"));
    const expected = value.inputsSha256;
    value.expected.moduleSha256 = "f".repeat(64);
    expect(recipeInputsSha256(value)).toBe(expected);
    value.metadata.description = "changed";
    expect(recipeInputsSha256(value)).not.toBe(expected);
  });
  it("refuses mismatched output before replacing a complete module", function* () {
    const root = yield* useTempDirectory("claude-refusal-");
    const output = pathToFileURL(`${root}/claude.ts`);
    yield* writeTextFile(output, "previous complete module");
    let failure: unknown;
    try {
      yield* publishClaude(output, Buffer.from("bad"), recipe(Buffer.from("good")));
    } catch (error) {
      failure = error;
    }
    expect(String(failure)).toContain("Claude archive: expected SHA-256");
    expect(yield* readTextFile(output)).toBe("previous complete module");
    expect(yield* readdir(root)).toEqual(["claude.ts"]);
    expect(() => verifyHash("input", "changed", sha256("original"))).toThrow(
      "input: expected SHA-256",
    );
  });
  it("joins a cancelled staged write and preserves a sibling's staging", function* () {
    const root = yield* useTempDirectory("claude-held-write-");
    const output = pathToFileURL(`${root}/claude.ts`);
    yield* writeTextFile(output, "previous");
    yield* writeTextFile(`${root}/sibling.staged`, "owned elsewhere");
    const started = withResolvers<void>();
    let release = (): void => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const settled = withResolvers<void>();
    const bytes = Buffer.from("complete");
    const order: string[] = [];
    yield* FileWrites.with(
      (path, text) => {
        order.push("write:start");
        started.resolve();
        return held
          .then(() => writeFile(path, text))
          .then(() => {
            order.push("write:settle");
            settled.resolve();
          });
      },
      function* () {
        try {
          const task = yield* spawn(() =>
            scoped(() => publishClaude(output, bytes, recipe(bytes))),
          );
          yield* started.operation;
          const haltStarted = withResolvers<void>();
          let halted = false;
          const halt = yield* spawn(function* () {
            const completion = task.halt();
            order.push("halt:start");
            haltStarted.resolve();
            yield* completion;
            order.push("halt:return");
            halted = true;
          });
          yield* haltStarted.operation;
          expect(halted).toBe(false);
          expect(order).toEqual(["write:start", "halt:start"]);
          release();
          yield* halt;
          yield* settled.operation;
        } finally {
          release();
        }
      },
    );
    expect(order).toEqual(["write:start", "halt:start", "write:settle", "halt:return"]);
    expect(yield* readTextFile(output)).toBe("previous");
    expect((yield* readdir(root)).sort()).toEqual(["claude.ts", "sibling.staged"]);
    expect(yield* readTextFile(`${root}/sibling.staged`)).toBe("owned elsewhere");
  });
  it("leaves complete output without readiness when halted after publication", function* () {
    const root = yield* useTempDirectory("claude-published-");
    const output = pathToFileURL(`${root}/claude.ts`);
    const published = withResolvers<void>();
    const bytes = Buffer.from("complete");
    const task = yield* spawn(function* () {
      yield* publishClaude(output, bytes, recipe(bytes));
      published.resolve();
      yield* suspend();
      yield* writeTextFile(`${root}/ready`, "ready");
    });
    yield* published.operation;
    yield* task.halt();
    expect(yield* readTextFile(output)).toBe(claudeSnapshotModule(bytes));
    expect(yield* readdir(root)).toEqual(["claude.ts"]);
  });
});

describe("Claude preparation tool ownership", () => {
  it("retains scratch until a failed real tool closes and starts no later work", function* () {
    const { ProcessApi } = yield* until(import("@effectionx/process"));
    const { createServer } = yield* until(import("node:net"));
    const { ensure } = yield* until(import("effection"));
    const { once } = yield* until(import("@effectionx/node/events"));
    const { exists } = yield* until(import("@effectionx/fs"));
    const { buildClaudePayload } = yield* until(import("../lib/prepare-claude.ts"));
    const connected = withResolvers<import("node:net").Socket>();
    const server = createServer();
    const handler = (socket: import("node:net").Socket): void => {
      connected.resolve(socket);
    };
    yield* ensure(function* () {
      server.off("connection", handler);
      yield* until(new Promise<void>((resolve) => server.close(() => resolve())));
    });
    server.on("connection", handler);
    server.listen(0, "127.0.0.1");
    yield* once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("No gate address");
    }
    let scratch = "";
    let calls = 0;
    yield* ProcessApi.around({
      *exec([_command, options], next) {
        calls++;
        scratch = options.cwd ?? "";
        return yield* next("node", {
          cwd: scratch,
          arguments: [
            "-e",
            `require("node:net").connect(${address.port}, "127.0.0.1").on("data", function() { this.end(); process.exitCode = 7; });`,
          ],
        });
      },
    });
    let failure: unknown;
    const task = yield* spawn(function* () {
      try {
        yield* scoped(() =>
          buildClaudePayload(new URL("../../", import.meta.url), recipe(Buffer.from("x"))),
        );
      } catch (error) {
        failure = error;
      }
    });
    const socket = yield* connected.operation;
    expect(yield* exists(scratch)).toBe(true);
    socket.end("release");
    yield* task;
    expect(failure).toBeInstanceOf(Error);
    expect(calls).toBe(1);
    expect(yield* exists(scratch)).toBe(false);
  });
});
