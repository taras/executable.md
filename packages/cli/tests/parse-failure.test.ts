/**
 * `xmd run` over a document whose `<Parse>` content is invalid (spec §6.12).
 *
 * Shells out, so what is measured is what a caller of the command sees: the
 * exit status, both streams, and whether the later block's file was written.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { runCli } from "@executablemd/test-support/launch";
import { ensure, until } from "effection";
import type { Operation } from "effection";
import { exists, rm, writeTextFile } from "@effectionx/fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCHEMA = '{{ type: "object", properties: { a: { type: "string" } }, required: ["a"] }}';

function document(content: string): string {
  return [
    "PREFIX",
    "",
    `<Parse schema=${SCHEMA} as="v">${content}</Parse>`,
    "",
    "```sh exec",
    "touch LATER_MARKER",
    "```",
    "",
  ].join("\n");
}

function* useWorkspace(source: string): Operation<string> {
  const root = yield* until(mkdtemp(join(tmpdir(), "xmd-parse-failure-")));
  yield* ensure(() => rm(root, { recursive: true, force: true }));
  yield* writeTextFile(join(root, "doc.md"), source);
  return root;
}

describe("xmd run: an invalid Parse", { sanitizeOps: false, sanitizeResources: false }, () => {
  for (const [kind, content, diagnostic] of [
    ["malformed JSON", "nope", "content is not JSON"],
    ["content the schema rejects", '{ "a": 1 }', "must be string"],
  ]) {
    it(`fails the run on ${kind} and starts no later block`, function* () {
      const root = yield* useWorkspace(document(content));
      const { code, stdout, stderr } = yield* runCli(["run", "doc.md", "--raw"], {
        cwd: root,
      }).join();

      expect(code).not.toBe(0);
      const streams = `${stdout}\n${stderr}`;
      expect(streams).toContain("Parse");
      expect(streams).toContain(diagnostic);
      expect(stdout).toContain("PREFIX");
      expect(yield* exists(join(root, "LATER_MARKER"))).toBe(false);
    });
  }

  it("runs the later block when the content is valid", function* () {
    const root = yield* useWorkspace(document('{ "a": "x" }'));
    const { code, stdout } = yield* runCli(["run", "doc.md", "--raw"], { cwd: root }).join();

    expect(code).toBe(0);
    expect(stdout).toContain("PREFIX");
    expect(yield* exists(join(root, "LATER_MARKER"))).toBe(true);
  });
});
