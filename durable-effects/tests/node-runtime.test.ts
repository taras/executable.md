// deno-lint-ignore-file require-yield

/**
 * Tests for nodeRuntime() — Node.js DurableRuntime implementation.
 */

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import { describe, it } from "@effectionx/bdd/node";
import { expect } from "@std/expect";
import { call } from "effection";
import { nodeRuntime } from "../node-runtime.ts";

async function startServer(
  handler: http.RequestListener,
): Promise<{ server: http.Server; url: string }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to determine server address");
  }
  return {
    server,
    url: `http://127.0.0.1:${address.port}`,
  };
}

async function stopServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

describe("nodeRuntime", () => {
  const runtime = nodeRuntime();

  describe("exec", () => {
    it("runs a command and captures stdout", function* () {
      const result = yield* runtime.exec({
        command: ["echo", "hello world"],
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("hello world");
      expect(result.stderr).toBe("");
    });

    it("captures stderr", function* () {
      const result = yield* runtime.exec({
        command: ["node", "-e", "console.error('oops')"],
      });
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain("oops");
    });

    it("returns non-zero exit code", function* () {
      const result = yield* runtime.exec({
        command: ["node", "-e", "process.exit(42)"],
      });
      expect(result.exitCode).toBe(42);
    });

    it("supports cwd option", function* () {
      const cwd = os.tmpdir();
      const result = yield* runtime.exec({
        command: ["node", "-e", "console.log(process.cwd())"],
        cwd,
      });
      // os.tmpdir() may resolve symlinks (e.g., /tmp → /private/tmp on macOS)
      const actual = result.stdout.trim();
      const expected = fs.realpathSync(cwd);
      expect(actual).toBe(expected);
    });

    it("enforces timeout", function* () {
      try {
        yield* runtime.exec({
          command: ["node", "-e", "setTimeout(() => console.log('late'), 250)"],
          timeout: 25,
        });
        expect(true).toBe(false);
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain("timed out after 25ms");
      }
    });
  });

  describe("readTextFile", () => {
    it("reads a text file", function* () {
      const content = yield* runtime.readTextFile(
        "durable-effects/deno.json",
      );
      expect(content).toContain("@executablemd/durable-effects");
    });

    it("throws on missing file", function* () {
      try {
        yield* runtime.readTextFile("nonexistent-file.txt");
        expect(true).toBe(false); // should not reach
      } catch (err) {
        expect(err).toBeInstanceOf(Error);
      }
    });
  });

  describe("stat", () => {
    it("returns exists and isFile for an existing file", function* () {
      const result = yield* runtime.stat("durable-effects/deno.json");
      expect(result).toEqual({
        exists: true,
        isFile: true,
        isDirectory: false,
      });
    });

    it("returns exists and isDirectory for an existing directory", function* () {
      const result = yield* runtime.stat("durable-effects");
      expect(result).toEqual({
        exists: true,
        isFile: false,
        isDirectory: true,
      });
    });

    it("returns all false for a missing path", function* () {
      const result = yield* runtime.stat("nonexistent-path.txt");
      expect(result).toEqual({
        exists: false,
        isFile: false,
        isDirectory: false,
      });
    });
  });

  describe("glob", () => {
    it("finds files matching a pattern", function* () {
      const results = yield* runtime.glob({
        patterns: ["*.ts"],
        root: "durable-effects",
      });
      expect(results.length).toBeGreaterThan(0);
      expect(results.every((r: { path: string }) => r.path.endsWith(".ts"))).toBe(
        true,
      );
      expect(results.every((r: { isFile: boolean }) => r.isFile)).toBe(true);
    });

    it("returns empty for no matches", function* () {
      const results = yield* runtime.glob({
        patterns: ["*.nonexistent"],
        root: "durable-effects",
      });
      expect(results).toEqual([]);
    });
  });

  describe("fetch", () => {
    it("fetches a response body", function* () {
      const { server, url } = yield* call(() =>
        startServer((_req, res) => {
          res.writeHead(200, { "Content-Type": "text/plain" });
          res.end("hello");
        })
      );

      try {
        const response = yield* runtime.fetch(url);
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toContain("text/plain");
        const body = yield* response.text();
        expect(body).toBe("hello");
      } finally {
        yield* call(() => stopServer(server));
      }
    });

    it("enforces timeout for slow responses", function* () {
      const { server, url } = yield* call(() =>
        startServer((_req, res) => {
          setTimeout(() => {
            res.writeHead(200, { "Content-Type": "text/plain" });
            res.end("slow body");
          }, 250);
        })
      );

      try {
        try {
          yield* runtime.fetch(url, { timeout: 25 });
          expect(true).toBe(false);
        } catch (error) {
          expect(error).toBeInstanceOf(Error);
          expect((error as Error).message).toContain("timed out after 25ms");
        }
      } finally {
        yield* call(() => stopServer(server));
      }
    });
  });

  describe("env", () => {
    it("reads an environment variable", function* () {
      const path = runtime.env("PATH");
      expect(path).toBeDefined();
      expect(typeof path).toBe("string");
    });

    it("returns undefined for unset variable", function* () {
      const val = runtime.env("DEFINITELY_NOT_SET_12345");
      expect(val).toBeUndefined();
    });
  });

  describe("platform", () => {
    it("returns os and arch", function* () {
      const { os, arch } = runtime.platform();
      expect(typeof os).toBe("string");
      expect(typeof arch).toBe("string");
      expect(os.length).toBeGreaterThan(0);
      expect(arch.length).toBeGreaterThan(0);
    });
  });
});
