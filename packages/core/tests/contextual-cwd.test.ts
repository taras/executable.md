/**
 * Tier CW — contextual working directory (spec §1.2).
 *
 * `exec` and `daemon` launch processes in the contextual `Env.cwd`, so a
 * component can decide where its content runs. These drive `execute()` with
 * the real modifier registry and read the answer from the shell itself: what
 * they assert is the subprocess's own working directory, not an argument
 * handed to a stub.
 *
 * The boundary is a fixture component rather than a shipped one — no public
 * component rebinds `Env.cwd` yet, and this contract is what the first one
 * will rest on.
 */

import { describe, it, beforeAll } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, resource, scoped, until } from "effection";
import type { Operation } from "effection";
import { exists, readTextFile, rm, writeTextFile } from "@effectionx/fs";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { Json } from "@executablemd/durable-streams";
import { execute } from "../src/execute.ts";
import { collect } from "../src/collect.ts";
import { useTempFileCompiler } from "../src/temp-file-compiler.ts";
import { mkdtemp, realpath, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

/**
 * The boundary under test: a component that installs a directory as the
 * contextual `Env.cwd` for its content, and nothing else.
 *
 * Written to disk rather than injected, so the whole path a document takes —
 * resolution, invocation, projection — is the one being measured.
 */
const IN_DIRECTORY = [
  'import { useContent } from "@executablemd/core";',
  'import { API } from "@executablemd/runtime";',
  "",
  "export const props = {",
  '  type: "object",',
  '  properties: { path: { type: "string" } },',
  '  required: ["path"],',
  "  additionalProperties: false,",
  "};",
  "",
  "export default function*(props) {",
  "  yield* API.Env.around({ *cwd() { return props.path; } }, { at: 'min' });",
  "  return yield* useContent();",
  "}",
].join("\n");

/**
 * A fixture project, not a bare directory. The boundary component is imported
 * by absolute file URL, so Node and Bun resolve it the way they resolve any
 * file: the nearest `package.json` decides its module type and bare specifiers
 * resolve through the nearest `node_modules`. Under the system temp directory
 * there is neither, so the component would load as CommonJS and fail to find
 * `@executablemd/core`. Deno needs neither, because its import map is
 * process-wide.
 *
 * `mkdtemp`, `realpath` and `symlink` have no `@effectionx/fs` equivalent;
 * everything else goes through it. Removing the fixture unlinks the symlink
 * rather than following it.
 */
interface Fixture {
  /** Where the document and its component live. */
  root: string;
  /** The directory the boundary installs — distinct from `root`. */
  target: string;
}

const REPOSITORY = fileURLToPath(new URL("../../../", import.meta.url));

function useFixture(): Operation<Fixture> {
  return resource(function* (provide) {
    const root = yield* until(realpath(yield* until(mkdtemp(join(tmpdir(), "cw-test-")))));
    yield* ensure(() => rm(root, { recursive: true, force: true }));
    const target = yield* until(realpath(yield* until(mkdtemp(join(tmpdir(), "cw-target-")))));
    yield* ensure(() => rm(target, { recursive: true, force: true }));

    yield* writeTextFile(join(root, "package.json"), JSON.stringify({ type: "module" }));
    yield* until(symlink(join(REPOSITORY, "node_modules"), join(root, "node_modules"), "dir"));
    yield* writeTextFile(join(root, "InDirectory.ts"), IN_DIRECTORY);

    yield* provide({ root, target });
  });
}

function writeDocument(fixture: Fixture, source: string): Operation<void> {
  return writeTextFile(join(fixture.root, "doc.md"), source);
}

/** One bounded run, so every scope closes before effects are read. */
function run(fixture: Fixture): Operation<Json> {
  return scoped(function* () {
    return yield* collect(
      yield* execute({
        path: join(fixture.root, "doc.md"),
        stream: new InMemoryStream(),
        componentDirs: [fixture.root],
      }),
    );
  });
}

function lines(output: Json): string[] {
  return String(output)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

const PWD = "```sh exec\npwd\n```";

describe("Tier CW — Contextual working directory", () => {
  beforeAll(() => useTempFileCompiler());

  // CW1: the contract a component rebinding `Env.cwd` depends on.
  it("CW1: an exec block inside the boundary runs in the contextual directory", function* () {
    const fixture = yield* useFixture();
    yield* writeDocument(fixture, `<InDirectory path="${fixture.target}">\n${PWD}\n</InDirectory>`);

    expect(lines(yield* run(fixture))).toEqual([fixture.target]);
  });

  // CW2: the boundary ends where the element does.
  it("CW2: an exec block after the boundary runs in the original directory", function* () {
    const fixture = yield* useFixture();
    yield* writeDocument(
      fixture,
      `<InDirectory path="${fixture.target}">\n${PWD}\n</InDirectory>\n\n${PWD}`,
    );

    const reported = lines(yield* run(fixture));
    expect(reported[0]).toBe(fixture.target);
    expect(reported[1]).toBe(yield* until(realpath(process.cwd())));
  });

  // CW3: a daemon starts in the contextual directory and is stopped by
  // structured teardown. Both answers come from the process: it records its
  // own `pwd` and pid outside the directory under test, and the pid is probed
  // once the execution has finished.
  it("CW3: a daemon starts in the contextual directory and is stopped afterwards", function* () {
    const fixture = yield* useFixture();
    const marker = join(fixture.root, "daemon.txt");
    yield* writeDocument(
      fixture,
      [
        `<InDirectory path="${fixture.target}">`,
        "```bash daemon exec",
        `pwd > ${marker}; echo $$ >> ${marker}; sleep 30`,
        "```",
        "```sh exec",
        "sleep 0.5",
        "```",
        "</InDirectory>",
      ].join("\n"),
    );

    yield* run(fixture);

    const [reported, pid] = (yield* readTextFile(marker)).trim().split("\n");
    expect(reported).toBe(fixture.target);
    // Structured teardown stopped it: nothing survives the execution.
    expect(() => process.kill(Number(pid), 0)).toThrow();
  });

  // CW4: with no boundary in the document, both kinds of process run where
  // they always did.
  it("CW4: without an override both exec and daemon use the process directory", function* () {
    const fixture = yield* useFixture();
    const marker = join(fixture.root, "plain.txt");
    yield* writeDocument(
      fixture,
      [
        PWD,
        "```bash daemon exec",
        `pwd > ${marker}; sleep 30`,
        "```",
        "```sh exec",
        "sleep 0.5",
        "```",
      ].join("\n"),
    );

    const here = yield* until(realpath(process.cwd()));
    expect(lines(yield* run(fixture))[0]).toBe(here);
    expect((yield* readTextFile(marker)).trim()).toBe(here);
    // The fixture's own directories were never involved.
    expect(yield* exists(fixture.target)).toBe(true);
  });
});
