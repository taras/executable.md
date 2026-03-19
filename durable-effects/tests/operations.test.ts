// deno-lint-ignore-file require-yield

import { describe, it } from "@effectionx/bdd/node";
import {
  DivergenceError,
  type DurableEvent,
  InMemoryStream,
  type Json,
  type Workflow,
  durableRun,
} from "@executablemd/durable-streams";
import type { Operation } from "effection";
import { expect } from "@effectionx/bdd/expect";
import { API } from "@executablemd/runtime";
import { type EvalResult, durableEval } from "../durable-eval.ts";
import { type ExecResult, durableExec } from "../durable-exec.ts";
import { type FetchResult, durableFetch } from "../durable-fetch.ts";
import { type GlobResult, durableGlob } from "../durable-glob.ts";
import { type ReadFileResult, durableReadFile } from "../durable-read-file.ts";
import { durableEnv, durableNow, durableResolve, durableUUID } from "../durable-resolve.ts";

function warmupEvents(): DurableEvent[] {
  return [
    {
      type: "yield",
      coroutineId: "root",
      description: {
        type: "resolve",
        name: "now",
        kind: "current_time",
      },
      result: { status: "ok", value: "2026-03-16T00:00:00.000Z" },
    },
  ];
}

function* expectDivergence(workflow: () => Workflow<Json>, event: DurableEvent): Operation<void> {
  const stream = new InMemoryStream([event]);
  try {
    yield* durableRun(workflow, { stream });
    throw new Error("expected divergence");
  } catch (error) {
    expect(error).toBeInstanceOf(DivergenceError);
  }
}

describe("durable operations", () => {
  describe("durableExec", () => {
    it("golden run: executes command and records yield/close", function* () {
      const stream = new InMemoryStream();

      yield* API.Process.around({
        *exec([options], _next) {
          expect(options.command).toEqual(["tsc"]);
          return { exitCode: 0, stdout: "compiled", stderr: "" };
        },
      });

      function* workflow(): Workflow<Json> {
        return (yield* durableExec("compile", {
          command: ["tsc"],
        })) as unknown as Json;
      }

      const result = (yield* durableRun(workflow, {
        stream,
      })) as unknown as ExecResult;
      expect(result).toEqual({ exitCode: 0, stdout: "compiled", stderr: "" });

      const events = stream.snapshot();
      expect(events.length).toBe(2);
      expect(events[0]!.type).toBe("yield");
      if (events[0]!.type === "yield") {
        expect(events[0]!.description).toEqual({
          type: "exec",
          name: "compile",
          command: ["tsc"],
          timeout: 300000,
          throwOnError: true,
        });
        expect(events[0]!.result).toEqual({
          status: "ok",
          value: { exitCode: 0, stdout: "compiled", stderr: "" },
        });
      }
      expect(events[1]!.type).toBe("close");
    });

    it("full replay: returns stored exec result without live runtime", function* () {
      const stored: ExecResult = {
        exitCode: 0,
        stdout: "from-journal",
        stderr: "",
      };
      const events: DurableEvent[] = [
        {
          type: "yield",
          coroutineId: "root",
          description: {
            type: "exec",
            name: "compile",
            command: ["tsc"],
            timeout: 300000,
          },
          result: { status: "ok", value: stored as unknown as Json },
        },
        {
          type: "close",
          coroutineId: "root",
          result: { status: "ok", value: stored as unknown as Json },
        },
      ];
      const stream = new InMemoryStream(events);

      function* workflow(): Workflow<Json> {
        return (yield* durableExec("compile", {
          command: ["will", "not", "run"],
        })) as unknown as Json;
      }

      const result = (yield* durableRun(workflow, {
        stream,
      })) as unknown as ExecResult;
      expect(result).toEqual(stored);
      expect(stream.appendCount).toBe(0);
    });

    it("error propagation: exec failure bubbles through durableRun", function* () {
      const stream = new InMemoryStream();

      yield* API.Process.around({
        *exec(_args, _next) {
          throw new Error("boom");
        },
      });

      function* workflow(): Workflow<Json> {
        return (yield* durableExec("compile", {
          command: ["tsc"],
        })) as unknown as Json;
      }

      try {
        yield* durableRun(workflow, { stream });
        throw new Error("expected durableRun to throw");
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain("boom");
      }

      const events = stream.snapshot();
      expect(events.length).toBe(2);
      expect(events[0]!.type).toBe("yield");
      if (events[0]!.type === "yield") {
        expect(events[0]!.result.status).toBe("err");
      }
      expect(events[1]!.type).toBe("close");
      if (events[1]!.type === "close") {
        expect(events[1]!.result.status).toBe("err");
      }
    });

    it("partial replay: warmup replays, exec runs live", function* () {
      const stream = new InMemoryStream(warmupEvents());
      let execCalls = 0;

      yield* API.Process.around({
        *exec(_args, _next) {
          execCalls += 1;
          return { exitCode: 0, stdout: "partial", stderr: "" };
        },
      });

      function* workflow(): Workflow<Json> {
        yield* durableNow();
        return (yield* durableExec("compile", {
          command: ["tsc"],
        })) as unknown as Json;
      }

      const result = (yield* durableRun(workflow, { stream })) as unknown as ExecResult;
      expect(result.stdout).toBe("partial");
      expect(execCalls).toBe(1);
    });

    it("divergence: mismatched exec name throws", function* () {
      yield* expectDivergence(
        function* (): Workflow<Json> {
          return (yield* durableExec("compile", {
            command: ["tsc"],
          })) as unknown as Json;
        },
        {
          type: "yield",
          coroutineId: "root",
          description: { type: "exec", name: "other" },
          result: { status: "ok", value: { exitCode: 0, stdout: "", stderr: "" } },
        },
      );
    });
  });

  describe("durableReadFile", () => {
    it("golden run: reads content and stores contentHash", function* () {
      const stream = new InMemoryStream();

      yield* API.Fs.around({
        *readTextFile([path], _next) {
          expect(path).toBe("src/input.txt");
          return "hello durable world";
        },
      });

      function* workflow(): Workflow<Json> {
        return (yield* durableReadFile("read-input", "src/input.txt")) as unknown as Json;
      }

      const result = (yield* durableRun(workflow, {
        stream,
      })) as unknown as ReadFileResult;
      expect(result.content).toBe("hello durable world");
      expect(result.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);

      const events = stream.snapshot();
      expect(events.length).toBe(2);
      expect(events[0]!.type).toBe("yield");
      if (events[0]!.type === "yield") {
        expect(events[0]!.description).toEqual({
          type: "read_file",
          name: "read-input",
          path: "src/input.txt",
          encoding: "utf-8",
        });
      }
    });

    it("full replay: returns stored read result without reading disk", function* () {
      const stored: ReadFileResult = {
        content: "journaled content",
        contentHash: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
      };
      const stream = new InMemoryStream([
        {
          type: "yield",
          coroutineId: "root",
          description: {
            type: "read_file",
            name: "read-input",
            path: "src/input.txt",
            encoding: "utf-8",
          },
          result: { status: "ok", value: stored as unknown as Json },
        },
        {
          type: "close",
          coroutineId: "root",
          result: { status: "ok", value: stored as unknown as Json },
        },
      ]);

      function* workflow(): Workflow<Json> {
        return (yield* durableReadFile("read-input", "different/path.txt")) as unknown as Json;
      }

      const result = (yield* durableRun(workflow, {
        stream,
      })) as unknown as ReadFileResult;
      expect(result).toEqual(stored);
      expect(stream.appendCount).toBe(0);
    });

    it("partial replay: warmup replays, read file runs live", function* () {
      const stream = new InMemoryStream(warmupEvents());
      let reads = 0;

      yield* API.Fs.around({
        *readTextFile(_args, _next) {
          reads += 1;
          return "partial read";
        },
      });

      function* workflow(): Workflow<Json> {
        yield* durableNow();
        return (yield* durableReadFile("read-input", "src/input.txt")) as unknown as Json;
      }

      const result = (yield* durableRun(workflow, { stream })) as unknown as ReadFileResult;
      expect(result.content).toBe("partial read");
      expect(reads).toBe(1);
    });

    it("divergence: mismatched read_file name throws", function* () {
      yield* expectDivergence(
        function* (): Workflow<Json> {
          return (yield* durableReadFile("read-input", "src/input.txt")) as unknown as Json;
        },
        {
          type: "yield",
          coroutineId: "root",
          description: { type: "read_file", name: "other" },
          result: { status: "ok", value: { content: "x", contentHash: "sha256:1" } },
        },
      );
    });
  });

  describe("durableGlob", () => {
    it("golden run: discovers files, hashes contents, computes scanHash", function* () {
      const stream = new InMemoryStream();

      yield* API.Fs.around({
        *glob([options], _next) {
          expect(options.patterns).toEqual(["**/*.ts"]);
          expect(options.root).toBe("project");
          expect(options.exclude).toEqual(["**/*.test.ts"]);
          return [
            { path: "src/b.ts", isFile: true },
            { path: "src/a.ts", isFile: true },
            { path: "src/dir", isFile: false },
            { path: "src/a.ts", isFile: true },
          ];
        },
        *readTextFile([path], _next) {
          if (path === "project/src/a.ts") return "A";
          if (path === "project/src/b.ts") return "B";
          throw new Error(`unexpected file: ${path}`);
        },
      });

      function* workflow(): Workflow<Json> {
        return (yield* durableGlob("scan", {
          baseDir: "project",
          include: ["**/*.ts"],
          exclude: ["**/*.test.ts"],
        })) as unknown as Json;
      }

      const result = (yield* durableRun(workflow, {
        stream,
      })) as unknown as GlobResult;
      expect(result.matches.map((m) => m.path)).toEqual(["src/a.ts", "src/b.ts"]);
      for (const match of result.matches) {
        expect(match.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
      }
      expect(result.scanHash).toMatch(/^sha256:[0-9a-f]{64}$/);

      const events = stream.snapshot();
      expect(events.length).toBe(2);
      expect(events[0]!.type).toBe("yield");
      if (events[0]!.type === "yield") {
        expect(events[0]!.description).toEqual({
          type: "glob",
          name: "scan",
          baseDir: "project",
          include: ["**/*.ts"],
          exclude: ["**/*.test.ts"],
        });
      }
    });

    it("full replay: returns stored glob result without scanning", function* () {
      const stored: GlobResult = {
        matches: [
          {
            path: "src/main.ts",
            contentHash: "sha256:2222222222222222222222222222222222222222222222222222222222222222",
          },
        ],
        scanHash: "sha256:3333333333333333333333333333333333333333333333333333333333333333",
      };
      const stream = new InMemoryStream([
        {
          type: "yield",
          coroutineId: "root",
          description: {
            type: "glob",
            name: "scan",
            baseDir: "project",
            include: ["**/*.ts"],
            exclude: [],
          },
          result: { status: "ok", value: stored as unknown as Json },
        },
        {
          type: "close",
          coroutineId: "root",
          result: { status: "ok", value: stored as unknown as Json },
        },
      ]);

      function* workflow(): Workflow<Json> {
        return (yield* durableGlob("scan", {
          baseDir: "ignored",
          include: ["ignored"],
        })) as unknown as Json;
      }

      const result = (yield* durableRun(workflow, {
        stream,
      })) as unknown as GlobResult;
      expect(result).toEqual(stored);
      expect(stream.appendCount).toBe(0);
    });

    it("partial replay: warmup replays, glob runs live", function* () {
      const stream = new InMemoryStream(warmupEvents());
      let scans = 0;

      yield* API.Fs.around({
        *glob(_args, _next) {
          scans += 1;
          return [{ path: "src/a.ts", isFile: true }];
        },
        *readTextFile(_args, _next) {
          return "A";
        },
      });

      function* workflow(): Workflow<Json> {
        yield* durableNow();
        return (yield* durableGlob("scan", {
          baseDir: "project",
          include: ["**/*.ts"],
        })) as unknown as Json;
      }

      const result = (yield* durableRun(workflow, { stream })) as unknown as GlobResult;
      expect(result.matches.map((match) => match.path)).toEqual(["src/a.ts"]);
      expect(scans).toBe(1);
    });

    it("divergence: mismatched glob name throws", function* () {
      yield* expectDivergence(
        function* (): Workflow<Json> {
          return (yield* durableGlob("scan", {
            baseDir: "project",
            include: ["**/*.ts"],
          })) as unknown as Json;
        },
        {
          type: "yield",
          coroutineId: "root",
          description: { type: "glob", name: "other" },
          result: { status: "ok", value: { matches: [], scanHash: "sha256:1" } },
        },
      );
    });
  });

  describe("durableFetch", () => {
    it("golden run: fetches body and records selected headers", function* () {
      const stream = new InMemoryStream();

      let capturedUrl: string | undefined;
      let capturedInit:
        | {
            method?: string;
            headers?: Record<string, string>;
            body?: string;
            timeout?: number;
          }
        | undefined;

      yield* API.Fetch.around({
        *fetch([url, init], _next) {
          capturedUrl = url;
          capturedInit = init;
          return {
            status: 200,
            headers: {
              get: (key: string) =>
                key === "content-type" ? "text/plain" : key === "etag" ? '"v1"' : null,
            },
            *text() {
              return "response body";
            },
          };
        },
      });

      function* workflow(): Workflow<Json> {
        return (yield* durableFetch("download", {
          url: "https://example.com/data",
          method: "POST",
          headers: { accept: "text/plain" },
          body: "payload",
          timeout: 1234,
        })) as unknown as Json;
      }

      const result = (yield* durableRun(workflow, {
        stream,
      })) as unknown as FetchResult;
      expect(capturedUrl).toBe("https://example.com/data");
      expect(capturedInit).toEqual({
        method: "POST",
        headers: { accept: "text/plain" },
        body: "payload",
        timeout: 1234,
      });
      expect(result.status).toBe(200);
      expect(result.headers).toEqual({
        "content-type": "text/plain",
        etag: '"v1"',
      });
      expect(result.body).toBe("response body");
      expect(result.bodyHash).toMatch(/^sha256:[0-9a-f]{64}$/);

      const events = stream.snapshot();
      expect(events.length).toBe(2);
      expect(events[0]!.type).toBe("yield");
      if (events[0]!.type === "yield") {
        expect(events[0]!.description).toEqual({
          type: "fetch",
          name: "download",
          url: "https://example.com/data",
          method: "POST",
          // Only safe headers are recorded with values; others are redacted
          headers: { accept: "text/plain" },
          bodyHash: "len:7",
        });
      }
    });

    it("full replay: returns stored fetch result without network", function* () {
      const stored: FetchResult = {
        status: 200,
        headers: { "content-type": "application/json" },
        body: '{"ok":true}',
        bodyHash: "sha256:4444444444444444444444444444444444444444444444444444444444444444",
      };
      const stream = new InMemoryStream([
        {
          type: "yield",
          coroutineId: "root",
          description: {
            type: "fetch",
            name: "download",
            url: "https://example.com/data",
            method: "GET",
            headers: {},
          },
          result: { status: "ok", value: stored as unknown as Json },
        },
        {
          type: "close",
          coroutineId: "root",
          result: { status: "ok", value: stored as unknown as Json },
        },
      ]);

      function* workflow(): Workflow<Json> {
        return (yield* durableFetch("download", {
          url: "https://ignored.invalid",
        })) as unknown as Json;
      }

      const result = (yield* durableRun(workflow, {
        stream,
      })) as unknown as FetchResult;
      expect(result).toEqual(stored);
      expect(stream.appendCount).toBe(0);
    });

    it("partial replay: warmup replays, fetch runs live", function* () {
      const stream = new InMemoryStream(warmupEvents());
      let fetchCalls = 0;

      yield* API.Fetch.around({
        *fetch(_args, _next) {
          fetchCalls += 1;
          return {
            status: 200,
            headers: { get: () => null },
            *text() {
              return "partial fetch";
            },
          };
        },
      });

      function* workflow(): Workflow<Json> {
        yield* durableNow();
        return (yield* durableFetch("download", {
          url: "https://example.com/data",
        })) as unknown as Json;
      }

      const result = (yield* durableRun(workflow, { stream })) as unknown as FetchResult;
      expect(result.body).toBe("partial fetch");
      expect(fetchCalls).toBe(1);
    });

    it("divergence: mismatched fetch name throws", function* () {
      yield* expectDivergence(
        function* (): Workflow<Json> {
          return (yield* durableFetch("download", {
            url: "https://example.com/data",
          })) as unknown as Json;
        },
        {
          type: "yield",
          coroutineId: "root",
          description: { type: "fetch", name: "other" },
          result: {
            status: "ok",
            value: { status: 200, headers: {}, body: "", bodyHash: "sha256:1" },
          },
        },
      );
    });
  });

  describe("durableEval", () => {
    it("golden run: evaluates source and records hashes", function* () {
      const stream = new InMemoryStream();

      let evaluatorCalls = 0;
      function* evaluator(source: string, bindings: Record<string, Json>) {
        evaluatorCalls += 1;
        expect(source).toBe("x + y");
        expect(bindings).toEqual({ x: 1, y: 2 });
        return { sum: 3 } as Json;
      }

      function* workflow(): Workflow<Json> {
        return (yield* durableEval("compute", evaluator, {
          source: "x + y",
          language: "js",
          bindings: { x: 1, y: 2 },
        })) as unknown as Json;
      }

      const result = (yield* durableRun(workflow, {
        stream,
      })) as unknown as EvalResult;
      expect(evaluatorCalls).toBe(1);
      expect(result.value).toEqual({ sum: 3 });
      expect(result.sourceHash).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(result.bindingsHash).toMatch(/^sha256:[0-9a-f]{64}$/);

      const events = stream.snapshot();
      expect(events.length).toBe(2);
      expect(events[0]!.type).toBe("yield");
      if (events[0]!.type === "yield") {
        expect(events[0]!.description).toEqual({
          type: "eval",
          name: "compute",
          language: "js",
        });
      }
    });

    it("full replay: returns stored eval result without invoking evaluator", function* () {
      const stored: EvalResult = {
        value: { answer: 42 },
        sourceHash: "sha256:5555555555555555555555555555555555555555555555555555555555555555",
        bindingsHash: "sha256:6666666666666666666666666666666666666666666666666666666666666666",
      };
      const stream = new InMemoryStream([
        {
          type: "yield",
          coroutineId: "root",
          description: { type: "eval", name: "compute", language: "js" },
          result: { status: "ok", value: stored as unknown as Json },
        },
        {
          type: "close",
          coroutineId: "root",
          result: { status: "ok", value: stored as unknown as Json },
        },
      ]);

      function* workflow(): Workflow<Json> {
        return (yield* durableEval(
          "compute",
          function* () {
            throw new Error("evaluator should not run on replay");
          },
          { source: "ignored", bindings: {} },
        )) as unknown as Json;
      }

      const result = (yield* durableRun(workflow, {
        stream,
      })) as unknown as EvalResult;
      expect(result).toEqual(stored);
      expect(stream.appendCount).toBe(0);
    });

    it("partial replay: warmup replays, eval runs live", function* () {
      const stream = new InMemoryStream(warmupEvents());
      let evaluatorCalls = 0;

      function* workflow(): Workflow<Json> {
        yield* durableNow();
        return (yield* durableEval(
          "compute",
          function* () {
            evaluatorCalls += 1;
            return { ok: true } as Json;
          },
          { source: "1+1", bindings: {} },
        )) as unknown as Json;
      }

      const result = (yield* durableRun(workflow, { stream })) as unknown as EvalResult;
      expect(result.value).toEqual({ ok: true });
      expect(evaluatorCalls).toBe(1);
    });

    it("divergence: mismatched eval name throws", function* () {
      yield* expectDivergence(
        function* (): Workflow<Json> {
          return (yield* durableEval(
            "compute",
            function* () {
              return 1 as Json;
            },
            { source: "1", bindings: {} },
          )) as unknown as Json;
        },
        {
          type: "yield",
          coroutineId: "root",
          description: { type: "eval", name: "other" },
          result: {
            status: "ok",
            value: { value: 1, sourceHash: "sha256:1", bindingsHash: "sha256:2" },
          },
        },
      );
    });
  });

  describe("durableResolve", () => {
    it("golden run: resolves platform through runtime", function* () {
      const stream = new InMemoryStream();

      yield* API.Env.around({
        *platform(_args, _next) {
          return { os: "darwin", arch: "arm64" };
        },
      });

      function* workflow(): Workflow<Json> {
        return (yield* durableResolve("platform-info", {
          kind: "platform",
        })) as unknown as Json;
      }

      const result = (yield* durableRun(workflow, { stream })) as unknown as {
        os: string;
        arch: string;
      };
      expect(result).toEqual({ os: "darwin", arch: "arm64" });

      const events = stream.snapshot();
      expect(events.length).toBe(2);
      expect(events[0]!.type).toBe("yield");
      if (events[0]!.type === "yield") {
        expect(events[0]!.description).toEqual({
          type: "resolve",
          name: "platform-info",
          kind: "platform",
        });
      }
    });

    it("full replay: returns stored resolved value without runtime calls", function* () {
      const stored = { os: "linux", arch: "x64" };
      const stream = new InMemoryStream([
        {
          type: "yield",
          coroutineId: "root",
          description: {
            type: "resolve",
            name: "platform-info",
            kind: "platform",
          },
          result: { status: "ok", value: stored as unknown as Json },
        },
        {
          type: "close",
          coroutineId: "root",
          result: { status: "ok", value: stored as unknown as Json },
        },
      ]);

      function* workflow(): Workflow<Json> {
        return (yield* durableResolve("platform-info", {
          kind: "platform",
        })) as unknown as Json;
      }

      const result = (yield* durableRun(workflow, { stream })) as unknown as {
        os: string;
        arch: string;
      };
      expect(result).toEqual(stored);
      expect(stream.appendCount).toBe(0);
    });

    it("partial replay: warmup replays, resolve runs live", function* () {
      const stream = new InMemoryStream(warmupEvents());
      let platformCalls = 0;

      yield* API.Env.around({
        *platform(_args, _next) {
          platformCalls += 1;
          return { os: "linux", arch: "x64" };
        },
      });

      function* workflow(): Workflow<Json> {
        yield* durableNow();
        return (yield* durableResolve("platform-info", {
          kind: "platform",
        })) as unknown as Json;
      }

      const result = (yield* durableRun(workflow, { stream })) as unknown as {
        os: string;
        arch: string;
      };
      expect(result).toEqual({ os: "linux", arch: "x64" });
      expect(platformCalls).toBe(1);
    });

    it("divergence: mismatched resolve name throws", function* () {
      yield* expectDivergence(
        function* (): Workflow<Json> {
          return (yield* durableResolve("platform-info", {
            kind: "platform",
          })) as unknown as Json;
        },
        {
          type: "yield",
          coroutineId: "root",
          description: { type: "resolve", name: "other" },
          result: { status: "ok", value: { os: "linux", arch: "x64" } },
        },
      );
    });
  });

  describe("convenience wrappers", () => {
    it("durableNow returns an ISO string and writes resolve event", function* () {
      const stream = new InMemoryStream();

      function* workflow(): Workflow<string> {
        return yield* durableNow();
      }

      const result = yield* durableRun(workflow, { stream });
      expect(result).toMatch(/\d{4}-\d{2}-\d{2}T/);

      const events = stream.snapshot();
      expect(events.length).toBe(2);
      expect(events[0]!.type).toBe("yield");
      if (events[0]!.type === "yield") {
        expect(events[0]!.description).toEqual({
          type: "resolve",
          name: "now",
          kind: "current_time",
        });
      }
    });

    it("durableUUID returns a UUID and writes resolve event", function* () {
      const stream = new InMemoryStream();

      function* workflow(): Workflow<string> {
        return yield* durableUUID();
      }

      const result = yield* durableRun(workflow, { stream });
      expect(result).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );

      const events = stream.snapshot();
      expect(events.length).toBe(2);
      expect(events[0]!.type).toBe("yield");
      if (events[0]!.type === "yield") {
        expect(events[0]!.description).toEqual({
          type: "resolve",
          name: "uuid",
          kind: "uuid",
        });
      }
    });

    it("durableEnv resolves an environment variable through runtime", function* () {
      const stream = new InMemoryStream();

      yield* API.Env.around({
        *env([name], _next) {
          return name === "API_KEY" ? "secret-value" : undefined;
        },
      });

      function* workflow(): Workflow<string | null> {
        return yield* durableEnv("API_KEY");
      }

      const result = yield* durableRun(workflow, { stream });
      expect(result).toBe("secret-value");

      const events = stream.snapshot();
      expect(events.length).toBe(2);
      expect(events[0]!.type).toBe("yield");
      if (events[0]!.type === "yield") {
        expect(events[0]!.description).toEqual({
          type: "resolve",
          name: "env:API_KEY",
          kind: "env_var",
          varName: "API_KEY",
        });
      }
    });
  });
});
