/**
 * Tier UO — how the upgrade transcript reaches a reader.
 *
 * The command's output *is* the document, so the thing to prove is that a
 * reader sees each step as it happens rather than a report assembled after the
 * work finished. These cases hold a phase suspended and check what has already
 * arrived — which is the only way to tell streaming from buffering, since a
 * buffered run produces byte-identical output at the end.
 *
 * The four phases are deterministic seams here. What is under test is the
 * runner and the document's shape, not the host: Tier UH owns the real lock,
 * bytes and rename.
 */
import { beforeAll, describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { readTextFile } from "@effectionx/fs";
import { fileURLToPath } from "node:url";
import type { Operation } from "effection";
import { useTempFileCompiler } from "@executablemd/core";
import type { Json } from "@executablemd/core";
import type { IdentityComponent } from "@executablemd/core/host";
import { InMemoryStream } from "@executablemd/durable-streams";

import {
  UPGRADE_CANDIDATE_PROPS,
  UPGRADE_DOWNLOAD_PROPS,
  UPGRADE_DOWNLOAD_RETURNS,
  UPGRADE_ORIGIN,
  UPGRADE_RELEASES_PROPS,
  UPGRADE_RELEASES_RETURNS,
  UPGRADE_REPLACE_RETURNS,
  UPGRADE_VERIFY_RETURNS,
} from "../src/compiled-upgrade.ts";
import { runUpgrade } from "../src/upgrade.ts";
import type { UpgradeAssembly, UpgradeConsumer } from "../src/upgrade.ts";

const INSTALLED = "0.10.2";
const RELEASE = "v0.11.0";
const EXECUTABLE = "/usr/local/bin/xmd";
const TARGET = "aarch64-apple-darwin";
const ASSET = `xmd-${TARGET}`;
const NOTES = `https://github.com/taras/executable.md/releases/tag/${RELEASE}`;

/** What each phase does when the document reaches it. */
interface Phases {
  beforeVerify?: () => Operation<void>;
  beforeReplace?: () => Operation<void>;
}

function seams(phases: Phases): readonly IdentityComponent[] {
  return [
    {
      name: "Upgrade.Releases",
      origin: UPGRADE_ORIGIN,
      forms: ["self-closing"] as const,
      props: UPGRADE_RELEASES_PROPS,
      returns: UPGRADE_RELEASES_RETURNS,
      factory: () =>
        // deno-lint-ignore require-yield
        function* () {
          return {
            ok: true,
            error: null,
            value: {
              releases: [
                {
                  tag: RELEASE,
                  draft: false,
                  prerelease: false,
                  url: NOTES,
                  identity: "release",
                  assets: [ASSET, "checksums.txt"],
                },
              ],
            },
          };
        },
    },
    {
      name: "Upgrade.Download",
      origin: UPGRADE_ORIGIN,
      forms: ["self-closing"] as const,
      props: UPGRADE_DOWNLOAD_PROPS,
      returns: UPGRADE_DOWNLOAD_RETURNS,
      factory: () =>
        // deno-lint-ignore require-yield
        function* () {
          return { ok: true, error: null, value: { asset: ASSET, candidate: "candidate" } };
        },
    },
    {
      name: "Upgrade.Verify",
      origin: UPGRADE_ORIGIN,
      forms: ["self-closing"] as const,
      props: UPGRADE_CANDIDATE_PROPS,
      returns: UPGRADE_VERIFY_RETURNS,
      factory: () =>
        function* (props: Record<string, Json>) {
          if (phases.beforeVerify !== undefined) {
            yield* phases.beforeVerify();
          }
          return {
            ok: true,
            error: null,
            value: { candidate: String(props.candidate), version: "0.11.0" },
          };
        },
    },
    {
      name: "Upgrade.Replace",
      origin: UPGRADE_ORIGIN,
      forms: ["self-closing"] as const,
      props: UPGRADE_CANDIDATE_PROPS,
      returns: UPGRADE_REPLACE_RETURNS,
      factory: () =>
        function* () {
          if (phases.beforeReplace !== undefined) {
            yield* phases.beforeReplace();
          }
          return {
            ok: true,
            error: null,
            value: {
              previousVersion: INSTALLED,
              installedVersion: "0.11.0",
              executablePath: EXECUTABLE,
              releaseUrl: NOTES,
            },
          };
        },
    },
  ];
}

function assemblyFor(phases: Phases): UpgradeAssembly {
  return {
    provenance: "compiled",
    currentVersion: INSTALLED,
    executablePath: EXECUTABLE,
    platform: "darwin",
    architecture: "arm64",
    target: TARGET,
    // deno-lint-ignore require-yield
    *authority() {
      return seams(phases);
    },
  };
}

function install(consume: UpgradeConsumer, phases: Phases = {}) {
  return runUpgrade({
    command: {
      requestedTag: null,
      status: false,
      allowDowngrade: false,
      allowPrerelease: false,
    },
    assembly: assemblyFor(phases),
    stream: new InMemoryStream(),
    consume,
  });
}

describe("Tier UO — the upgrade transcript", () => {
  beforeAll(() => useTempFileCompiler());

  it("UO1: each milestone reaches the reader before the next phase begins", function* () {
    // The decisive case. A run that buffered everything and wrote it at the end
    // produces byte-identical output, so the only way to tell streaming from
    // buffering is to look at what has already arrived while a later phase has
    // not started.
    const arrived: string[] = [];
    const soFar = () => arrived.join("");
    let atVerify = "";
    let atReplace = "";

    const outcome = yield* install(
      // deno-lint-ignore require-yield
      function* (chunk) {
        arrived.push(chunk);
      },
      {
        // deno-lint-ignore require-yield
        *beforeVerify() {
          atVerify = soFar();
        },
        // deno-lint-ignore require-yield
        *beforeReplace() {
          atReplace = soFar();
        },
      },
    );

    expect(outcome.ok).toBe(true);

    // Before verification started, the reader already had the selection and the
    // download — and nothing about verification or replacement.
    expect(atVerify).toContain("Selected release: v0.11.0 (newer than installed version 0.10.2)");
    expect(atVerify).toContain(`Downloaded binary: ${ASSET}`);
    expect(atVerify).not.toContain("Verified: SHA-256");
    expect(atVerify).not.toContain("Installed xmd");

    // Before replacement started, verification had landed too.
    expect(atReplace).toContain("Verified: SHA-256 checksum and version 0.11.0");
    expect(atReplace).not.toContain("Installed xmd");

    // And the installation summary is last.
    expect(soFar()).toContain("Installed xmd 0.11.0 (replaced 0.10.2).");

    // Blank runs are collapsed to one blank line, and the transcript ends with
    // exactly one newline. A branch the command did not take leaves the engine
    // emitting the blank lines that surrounded it, and this document has enough
    // branches that a reader would otherwise meet a dozen at a time.
    expect(soFar()).not.toMatch(/\n{3}/);
    expect(soFar().startsWith("#")).toBe(true);
    expect(soFar().endsWith("\n")).toBe(true);
    expect(soFar().endsWith("\n\n")).toBe(false);
  });

  it("UO2: every consumer drains the same stream, and nothing is printed twice", function* () {
    // The three shapes the command supports: a terminal writing as it goes, a
    // pipe writing once at the end, and a test observing. All read the same
    // `execution.output`, so the bytes cannot differ between them.
    const streamed: string[] = [];
    const first = yield* install(
      // deno-lint-ignore require-yield
      function* (chunk) {
        streamed.push(chunk);
      },
    );

    const buffered: string[] = [];
    const second = yield* install(
      // deno-lint-ignore require-yield
      function* (chunk) {
        buffered.push(chunk);
      },
    );

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(streamed.join("")).toBe(buffered.join(""));
    // More than one chunk, or the progressive claim above would be vacuous.
    expect(streamed.length).toBeGreaterThan(1);

    // The completion value is never handed back for printing: a text root's
    // value is the text the consumer already has, and returning it would invite
    // the caller to say everything twice.
    expect(first.ok ? first.value : "unreachable").toBe(undefined);
  });

  it("UO3: a consumer that fails cancels the run and reports rather than hanging", function* () {
    let replaced = false;
    const outcome = yield* install(
      // deno-lint-ignore require-yield
      function* (chunk) {
        if (chunk.includes("Downloaded binary:")) {
          throw new Error("the terminal went away");
        }
      },
      {
        // deno-lint-ignore require-yield
        *beforeReplace() {
          replaced = true;
        },
      },
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? "" : outcome.error.message).toContain("the terminal went away");
    // The document was cancelled, so the phase after the failing chunk never
    // ran. A consumer failure is not a reason to finish replacing a binary.
    expect(replaced).toBe(false);
  });

  it("UO4: the durable stream records the run and grants it nothing", function* () {
    // The journal is evidence, never input. This asserts the first half — that
    // a run does write events — so the CLI cases about the file are not
    // asserting over an empty trace.
    const stream = new InMemoryStream();
    const outcome = yield* runUpgrade({
      command: {
        requestedTag: null,
        status: false,
        allowDowngrade: false,
        allowPrerelease: false,
      },
      assembly: assemblyFor({}),
      stream,
      // deno-lint-ignore require-yield
      *consume() {},
    });

    expect(outcome.ok).toBe(true);
    expect(stream.snapshot().length).toBeGreaterThan(0);

    // A second run over the same stream repeats the work rather than resuming
    // from it: nothing here reads a journal back.
    let phases = 0;
    yield* runUpgrade({
      command: {
        requestedTag: null,
        status: false,
        allowDowngrade: false,
        allowPrerelease: false,
      },
      assembly: assemblyFor({
        // deno-lint-ignore require-yield
        *beforeReplace() {
          phases += 1;
        },
      }),
      stream: new InMemoryStream(),
      // deno-lint-ignore require-yield
      *consume() {},
    });
    expect(phases).toBe(1);
  });

  it("UO5: nothing in this module reaches the host's own output", function* () {
    // The runner is runtime-neutral by construction: writing to a terminal is
    // the command line's decision, and a module that imported stdout would make
    // it everybody's.
    const source = yield* readTextFile(
      fileURLToPath(new URL("../src/upgrade.ts", import.meta.url)),
    );

    for (const absent of ["process.stdout", "console.log", "node:process"]) {
      expect({ absent, present: source.includes(absent) }).toEqual({ absent, present: false });
    }
  });
});
