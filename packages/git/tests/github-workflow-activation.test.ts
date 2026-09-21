/**
 * The real host assembly, with every outward boundary refusing.
 *
 * The companion to `github-activation.test.ts`. What is here drives the
 * assemblies a command actually installs — the ordinary-run profile, and a
 * retained source-bundle run through the Workflow host — rather than the
 * adapters on their own. Both reach Workflow's storage adapter and so
 * `node:sqlite`, which Bun does not have and Node keeps behind a flag, so this
 * file is Deno's alone and the portable ordering cases stay next door.
 *
 * Installing any of it must read no variable, obtain no credential and open no
 * socket. The boundaries here therefore *throw* rather than count: a crossing
 * fails where it happens.
 *
 * Syntax and Plan are the CLI's own surfaces and are exercised for real in
 * `packages/cli/tests/github-zero-effect.test.ts`, which renders the catalog
 * and describes the Plan component under the same refusing boundary.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { scoped } from "effection";
import type { Operation } from "effection";
import { API, useHostFiles } from "@executablemd/runtime";
import { useRunComposition } from "../src/deno/run-composition/provider.ts";
import { gitPlugin } from "../src/plugin.ts";
import { collect, inlineSource } from "@executablemd/core";
import { executeInstalled } from "@executablemd/core/host";
import { InMemoryStream } from "@executablemd/durable-streams";
import { useTempDirectory } from "@executablemd/test-support/temp";
import type { GitHubSource } from "../src/deno/composition/github.ts";
import { runWorkflowDocument } from "./support/composition.ts";
import {
  BUNDLE_SOURCE,
  sourceBundleCreation,
  useStorageRoot,
  withExecutorRun,
  withRunHost,
} from "../../workflow/tests/support/storage.ts";

/** A transport factory that refuses to be built at all. */
function forbidden(): GitHubSource {
  throw new Error("a GitHub transport was built");
}

/** A host whose configuration boundary refuses to be read. */
function* refusing(): Operation<void> {
  yield* API.Env.around(
    {
      *env([name], next): Operation<string | undefined> {
        if (name.startsWith("XMD_WORKFLOW_GITHUB")) {
          throw new Error(`configuration was read: ${name}`);
        }
        return yield* next(name);
      },
    },
    { at: "min" },
  );
}

/** One document, executed with the bundled Plugin installed and nothing else. */
function* document(source: string): Operation<unknown> {
  const stream = new InMemoryStream();
  const install = gitPlugin.install;
  if (install === undefined) {
    throw new Error("the Git Plugin installed nothing");
  }
  const contribution = yield* install.call(gitPlugin, { command: "run", args: ["run"] });
  return yield* collect(
    yield* executeInstalled({ ...inlineSource(source), stream }, [
      { admissions: [...(contribution?.admissions ?? [])] },
    ]),
  );
}

describe("the bundled profile, assembled", () => {
  it("installs the whole ordinary-run profile without reading any of it", function* () {
    // The real assembly this time, not the adapters alone: `useRunComposition`
    // is what `xmd run` installs, and it brings the repository provider, the
    // Git capability, both GitHub adapters and the retained lifecycles with it.
    // Every outward boundary refuses, so installing any of them wrongly is a
    // failure here rather than a count checked afterwards.
    const rendered = yield* scoped(function* () {
      yield* refusing();
      yield* useRunComposition({
        root: yield* useTempDirectory("xmd-zero-root"),
        cwd: yield* useTempDirectory("xmd-zero-cwd"),
        gitHubIssues: { host: forbidden },
        gitHubPullRequests: { host: forbidden },
      });
      return yield* document("a plain document that reaches nothing\n");
    });
    expect(String(rendered)).toContain("a plain document that reaches nothing");
  });

  it("does local Git work without reading any GitHub configuration", function* () {
    // `<Dir>` is Git's own and reaches no service. A profile that read GitHub
    // configuration to do local work would be reading it for every run.
    const rendered = yield* scoped(function* () {
      yield* refusing();
      yield* useHostFiles();
      yield* useRunComposition({
        root: yield* useTempDirectory("xmd-zero-root"),
        cwd: yield* useTempDirectory("xmd-zero"),
        gitHubIssues: { host: forbidden },
        gitHubPullRequests: { host: forbidden },
      });
      return yield* document('<Dir path="notes">local work only</Dir>\n');
    });
    expect(String(rendered)).toContain("local work only");
  });

  it("runs a version-2 source-bundle workflow outside Git without reaching GitHub", function* () {
    // The real lifecycle, not a test-shaped run: a source-bundle creation
    // begun through the same transitions `xmd workflow start` uses, so what
    // executes below is a retained version-2 definition rather than a v1 Git
    // run that happens to render.
    const root = yield* useStorageRoot();
    yield* withRunHost(root, function* (transitions) {
      const creation = yield* sourceBundleCreation();
      return yield* withExecutorRun(
        transitions,
        { runId: "outside-git", action: "start", creation },
        function* (begun) {
          // Pinned so this cannot regress to a v1 run silently. A v1 record
          // would render the same and prove nothing about the bundle path.
          expect(begun.database.record.definition.version).toBe(2);

          const rendered = yield* scoped(function* () {
            yield* refusing();
            return yield* runWorkflowDocument(begun.database, BUNDLE_SOURCE, {
              gitHubIssues: { host: forbidden },
              gitHubPullRequests: { host: forbidden },
            });
          });

          expect(String(rendered)).toContain("this run retains these exact bytes");
          // The run really executed: a document that never ran would render
          // nothing and satisfy every refusal above by doing nothing at all.
          expect(yield* begun.database.journal.readAll()).not.toEqual([]);
        },
      );
    });
  });
});
