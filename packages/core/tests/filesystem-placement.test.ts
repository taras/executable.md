import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { admitDocumentHostPath, authoredOperation } from "../src/filesystem-placement.ts";
import { R1_WIN32 } from "../../test-support/mount-fixture.ts";

describe("document component preservation", () => {
  it("R1-WIN32 refuses the unnormalized authored backslash operand", function* () {
    const f = R1_WIN32;
    expect(
      admitDocumentHostPath("win32", f.operand, f.target, f.destination, f.source, f.target).ok,
    ).toBe(false);
    expect(admitDocumentHostPath("win32", "..", f.target, "/", "C:\\", "/")).toEqual({
      ok: true,
      value: "C:\\",
    });
    const operation = authoredOperation("dir-ensure", "occurrence", "..", {
      authoredDirectory: "/reference",
      actualDirectory: "/work/manuals/docs",
      namespace: "document",
      interpreting: true,
    });
    expect(operation.path).toBe("..");
    expect(operation.destination).toBe("/");
  });
});

import { API, cwd, fileWriteSuccess } from "@executablemd/runtime";
import { Ok, ensure, spawn, suspend, withResolvers } from "effection";
import { collect, inlineSource } from "@executablemd/core";
import { Component } from "../src/component-api.ts";
import { executeInstalled } from "../host.ts";
import { workspaceMountInstallation } from "../../cli/src/repl/workspace-mount-installation.ts";
import { mountPolicy } from "../../cli/src/repl/mount-files.ts";
import { InMemoryStream } from "@executablemd/durable-streams";
import { ordinaryGeneratedSelection } from "../../cli/src/evaluation-profile.ts";

describe("mapped canonical component expansion", () => {
  it("delivers actual cwd to all existing consumers and follows the authored parent", function* () {
    const seen: unknown[] = [];
    yield* API.Env.around(
      {
        *cwd() {
          return "/host";
        },
      },
      { at: "min" },
    );
    yield* API.Files.around(
      {
        *checkFilePath([input]) {
          seen.push(["check", input]);
          return Ok(undefined);
        },
        *ensureDirectory([input]) {
          seen.push(["ensure", input]);
          return Ok(undefined);
        },
        *readTextFile([input]) {
          seen.push(["read", input]);
          return Ok("read");
        },
        *writeTextFile([input]) {
          seen.push(["write", input]);
          return Ok(fileWriteSuccess("host-committed"));
        },
        *deleteFile([input]) {
          seen.push(["delete", input]);
          return Ok(undefined);
        },
        *globFiles([input]) {
          seen.push(["glob", input]);
          return Ok([]);
        },
      },
      { at: "min" },
    );
    yield* API.Process.around({
      *exec([options]) {
        seen.push(["process", options]);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    const source = [
      '<Dir path="/reference">',
      '<File path="one.md" />',
      '<File path="two.md">text</File>',
      '<File.Delete path="three.md" />',
      '<Dir path="..">',
      '<File path="next.md" />',
      '<Glob include={["*.md"]} exclude={["skip.md"]} as="paths" />',
      "```bash exec",
      "printf unchanged",
      "```",
      "</Dir>",
      '<File path="restored.md" />',
      "</Dir>",
      '<File path="outer.md" />',
    ].join("\n");
    yield* collect(
      yield* executeInstalled(
        { ...inlineSource(source), includes: [], stream: new InMemoryStream() },
        [workspaceMountInstallation([{ source: "/work/manuals/docs", target: "/reference" }])],
      ),
    );
    expect(seen).toContainEqual(["ensure", { cwd: "/work/manuals/docs", path: "/" }]);
    expect(seen).toContainEqual(["read", { cwd: "/", path: "next.md" }]);
    expect(seen).toContainEqual(["glob", { cwd: "/", include: ["*.md"], exclude: ["skip.md"] }]);
    expect(seen).toContainEqual([
      "write",
      { cwd: "/work/manuals/docs", path: "two.md", content: "text" },
    ]);
    expect(seen).toContainEqual(["delete", { cwd: "/work/manuals/docs", path: "three.md" }]);
    expect(seen).toContainEqual(["read", { cwd: "/work/manuals/docs", path: "restored.md" }]);
    expect(seen).toContainEqual(["read", { cwd: "/host", path: "outer.md" }]);
    const process = seen.find((one) => Array.isArray(one) && one[0] === "process");
    expect(process).toEqual([
      "process",
      expect.objectContaining({ cwd: "/", command: ["bash", "-c", "printf unchanged\n"] }),
    ]);
    expect(yield* cwd()).toBe("/host");
  });
  it("rejects R1-WIN32 before any ensure or child and preserves the ordinary '..' case", function* () {
    const f = R1_WIN32;
    const policy = mountPolicy([{ source: f.source, target: f.target }], "C:\\host", "win32");
    const entered = policy.prepareDirectory(
      authoredOperation("dir-ensure", "initial", f.target, policy.root),
      policy.root,
    );
    expect(entered.ok && entered.value.request.path).toBe(f.source);
    let calls = 0;
    const installation = {
      *filesystem(
        deliver: Parameters<
          NonNullable<import("../host.ts").ExecutionInstallation["filesystem"]>
        >[0],
      ) {
        deliver({
          root: {
            authoredDirectory: f.target,
            actualDirectory: f.source,
            namespace: "document",
            interpreting: true,
          },
          prepareDirectory: policy.prepareDirectory,
          *ensure() {
            calls++;
            return Ok(undefined);
          },
          *read() {
            calls++;
            return Ok("unexpected");
          },
        });
      },
    };
    let failure: unknown;
    yield* API.Env.around(
      {
        *cwd() {
          return f.source;
        },
      },
      { at: "min" },
    );
    try {
      yield* collect(
        yield* executeInstalled(
          {
            ...inlineSource(`<Dir path=${JSON.stringify(f.operand)}><File path="never" /></Dir>`),
            includes: [],
            stream: new InMemoryStream(),
          },
          [installation],
        ),
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(calls).toBe(0);
  });
  it("carries the private frame through generated File forms", function* () {
    const seen: string[] = [];
    yield* API.Env.around(
      {
        *cwd() {
          return "/host";
        },
      },
      { at: "min" },
    );
    yield* API.Files.around(
      {
        *ensureDirectory() {
          return Ok(undefined);
        },
        *readTextFile([input]) {
          seen.push(input.cwd);
          return Ok("generated");
        },
      },
      { at: "min" },
    );
    const install = {
      *install() {
        yield* Component.around({ generated: () => ordinaryGeneratedSelection() });
      },
    };
    const source = '<Dir path="/reference"><Evaluate text={\'<File path="one.md" />\'} /></Dir>';
    const output = yield* collect(
      yield* executeInstalled(
        { ...inlineSource(source), includes: [], stream: new InMemoryStream() },
        [install, workspaceMountInstallation([{ source: "/external", target: "/reference" }])],
      ),
    );
    expect(output).toContain("generated");
    expect(seen).toEqual(["/external"]);
  });
});

describe("mapped scope exits", () => {
  it("restores both enclosing levels after a nested child failure", function* () {
    const seen: string[] = [];
    let fail = true;
    yield* API.Env.around(
      {
        *cwd() {
          return "/host";
        },
      },
      { at: "min" },
    );
    yield* API.Files.around(
      {
        *ensureDirectory() {
          return Ok(undefined);
        },
        *readTextFile([input]) {
          seen.push(input.cwd);
          return Ok("read");
        },
      },
      { at: "min" },
    );
    yield* Component.around({
      *expand([request], next) {
        if (request.expansion.name === "File" && fail) {
          fail = false;
          expect(yield* cwd()).toBe("/");
          throw new Error("owned child failure");
        }
        yield* next(request);
      },
    });
    const output = yield* collect(
      yield* executeInstalled(
        {
          ...inlineSource(
            '<Dir path="/reference"><PrintErrors><Dir path=".."><File path="bad" /></Dir></PrintErrors><File path="within" /></Dir><File path="after" />',
          ),
          includes: [],
          stream: new InMemoryStream(),
        },
        [workspaceMountInstallation([{ source: "/external", target: "/reference" }])],
      ),
    );
    expect(output).toContain("owned child failure");
    expect(seen).toEqual(["/external", "/host"]);
    expect(yield* cwd()).toBe("/host");
  });
  it("joins cancelled child work and restores the caller's cwd", function* () {
    const entered = withResolvers<void>();
    let released = false;
    yield* API.Env.around(
      {
        *cwd() {
          return "/host";
        },
      },
      { at: "min" },
    );
    yield* API.Files.around(
      {
        *ensureDirectory() {
          return Ok(undefined);
        },
      },
      { at: "min" },
    );
    yield* Component.around({
      *expand([request], next) {
        if (request.expansion.name === "File") {
          expect(yield* cwd()).toBe("/external");
          yield* ensure(() => {
            released = true;
          });
          entered.resolve();
          yield* suspend();
        }
        yield* next(request);
      },
    });
    const task = yield* spawn(function* () {
      return yield* collect(yield* execute());
    });
    function* execute() {
      return yield* executeInstalled(
        {
          ...inlineSource('<Dir path="/reference"><File path="pending" /></Dir>'),
          includes: [],
          stream: new InMemoryStream(),
        },
        [workspaceMountInstallation([{ source: "/external", target: "/reference" }])],
      );
    }
    yield* entered.operation;
    yield* task.halt();
    expect(released).toBe(true);
    expect(yield* cwd()).toBe("/host");
  });
});
