/**
 * Tier GO — the four local Git observations, against real repositories.
 *
 * `<Git.Files>`, `<Git.Changes>`, `<Git.Diff>` and `<Git.File>` read a checkout
 * a Repository selected and change nothing in it. Every assertion here runs
 * against a real checkout with real commits and real `git`: what a read has to
 * get right is which repository it addressed, which data it preserved, and what
 * it left exactly as it found it, and none of those is a question a substituted
 * repository can answer.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import type { Json } from "@executablemd/durable-streams";
import { InMemoryStream } from "@executablemd/durable-streams";
import { scoped, until } from "effection";
import { join } from "node:path";
import { utimes } from "node:fs/promises";
import { lstat } from "@effectionx/fs";
import { collect, execute, inlineSource, registerComponents } from "@executablemd/core";
import { canonicalJson } from "@executablemd/workflow";
import { COMPOSITION_ORIGIN } from "../src/composition/definitions.ts";
import {
  COMPOSITION_REGISTRATIONS,
  useCompositionComponents,
} from "../src/composition/installation.ts";
import {
  DEFAULT_RECORD_LIMIT,
  DEFAULT_TEXT_LIMIT,
  GIT_COMPARE_MODES,
  changesProps,
  changesReturns,
  diffProps,
  diffReturns,
  fileProps,
  fileReturns,
  filesProps,
  filesReturns,
} from "../src/composition/observation-api.ts";
import {
  ASTRAL,
  AWKWARD_PATH,
  LONG_BLOB,
  MAGIC_PATH,
  actionProbe,
  capturingProbe,
  useConflictedCheckout,
  useFileFixture,
  useGeneratedFixture,
  fingerprintCheckout,
  indexFingerprints,
  useLinkedWorktree,
  useObservationFixture,
  useSentinelConfiguration,
  useUnbornCheckout,
  writeFixtureFile,
} from "./support/observations.ts";
import {
  commonDirectoryOf,
  countingOrdinaryHost,
  raised,
  runOrdinaryDocument,
  subcommands,
  useHostCheckout,
  useManagedRoot,
} from "./support/run-composition.ts";
import { useBareRemote } from "./support/git-remotes.ts";
import { REMOTE } from "./support/run-composition-tier.ts";
import { exists } from "@effectionx/fs";

import type { HostCheckout } from "./support/run-composition.ts";
import type { ComponentRegistration } from "@executablemd/core";
import type { Operation } from "effection";
import { cwd } from "@executablemd/runtime";
import { selectedRepository } from "../src/composition/context.ts";
import {
  GitObservationError,
  GitObservationProviderError,
  GitOperationAdmissionError,
} from "../src/composition/errors.ts";
import { GitQuery, Repository } from "@executablemd/git/api";
import type {
  GitChangesInvocation,
  GitChangesResult,
  GitDiffInvocation,
  GitDiffResult,
  GitFileInvocation,
  GitFileResult,
  GitFilesInvocation,
  GitFilesResult,
  GitInvocationPlace,
  GitObservationRequest,
  RepositorySelection,
} from "@executablemd/git/api";
import { denoRepositoryHost } from "../src/deno/composition/host.ts";
import type { GitInvocation, RepositoryHost } from "../src/deno/composition/host.ts";
import { performGitObservation } from "../src/deno/composition/observations.ts";
import type { ObservationPlace } from "../src/deno/composition/observations.ts";

/**
 * The place a native read runs in, for a case that drives the performer itself.
 *
 * The identity's members beyond the object format are what a cursor carries;
 * the format is what decides which empty tree an unborn comparison names.
 */
function observationPlaceOf(checkout: HostCheckout): ObservationPlace {
  return {
    repository: {
      name: "fixture",
      locatorFingerprint: "0".repeat(64),
      requestedBase: null,
      creationCommit: "0".repeat(40),
      primaryBranch: "main",
      objectFormat: "sha1",
    },
    root: checkout.root,
    commonDirectory: commonDirectoryOf(checkout),
  };
}

/**
 * A component that performs a read loop at the place a document wrote it.
 *
 * Several of these cases follow a continuation to its end, which is more pages
 * than a document should have to spell. The loop reaches the ordinary
 * contextual operation with the two observations a component makes, so what it
 * drives is the installed provider rather than a shortcut around it.
 */
function followingProbe(
  name: string,
  run: (place: GitInvocationPlace) => Operation<void>,
): ComponentRegistration {
  return {
    name,
    origin: `test://${name.toLowerCase()}`,
    props: { type: "object", properties: {}, additionalProperties: false },
    *fn(): Operation<string> {
      const repository = yield* selectedRepository();
      if (repository === undefined) {
        throw new Error("the probe is written outside every repository");
      }
      yield* run({ repository, workingDirectory: yield* cwd() });
      return "";
    },
  };
}

/**
 * A host that records every scratch directory a read acquired.
 *
 * The directory is what the observation owns, so whether it is gone afterwards
 * is the whole of the teardown claim. A wrapper is the only place to learn its
 * name: the production host hands it to the read and to nobody else.
 */
function recordingDirectories(inner: RepositoryHost, created: string[]): RepositoryHost {
  const capture = inner.gitBytes;
  const authenticate = inner.useAuthentication;
  return {
    git: (invocation: GitInvocation) => inner.git(invocation),
    *useDirectory(): Operation<string> {
      const directory = yield* inner.useDirectory();
      created.push(directory);
      return directory;
    },
    ...(capture === undefined
      ? {}
      : { gitBytes: (invocation: GitInvocation) => capture(invocation) }),
    ...(authenticate === undefined
      ? {}
      : { useAuthentication: (locator: string) => authenticate(locator) }),
  };
}

/**
 * How this refusal is classified, in the vocabulary a case can state.
 *
 * The reads own `GitObservationError`; a missing binding, an unknown prop and a
 * limit the schema rejects are the engine's own refusals, and what matters
 * about those is that they happened before a provider was asked.
 */
function refusalKind(value: unknown): string {
  if (value instanceof GitObservationError) {
    return value.reason;
  }
  return value === undefined ? "bound" : "refused";
}

/** The property names one schema declares. */
function propertiesOf(schema: Json): Record<string, Json> {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
    throw new Error("expected a schema object");
  }
  const properties = schema.properties;
  if (typeof properties !== "object" || properties === null || Array.isArray(properties)) {
    throw new Error("expected a schema with properties");
  }
  return properties;
}

/** The four reads, with the smallest invocation each one accepts. */
const FOUR_ELEMENTS: readonly { readonly name: string; readonly source: string }[] = [
  { name: "Git.Files", source: '<Git.Files as="bound" />' },
  { name: "Git.Changes", source: '<Git.Changes compare="staged" as="bound" />' },
  { name: "Git.Diff", source: '<Git.Diff compare="staged" as="bound" />' },
  { name: "Git.File", source: '<Git.File commit="HEAD" path="a.ts" as="bound" />' },
];

/** A selection a host hands over without any native checkout behind it. */
const SUPPLIED_SELECTION: RepositorySelection = Object.freeze({
  selection: "supplied",
  name: "supplied",
  identity: Object.freeze({
    name: "supplied",
    locatorFingerprint: "1".repeat(64),
    requestedBase: null,
    creationCommit: "0".repeat(40),
    primaryBranch: "main",
    objectFormat: "sha1" as const,
  }),
  checkoutPath: "/nowhere",
});

interface NeutralOptions {
  /** Whether a Repository provider answers, without any read provider. */
  readonly repository?: boolean;
  /** When present, the four reads are supplied and their requests recorded. */
  readonly reads?: string[];
  readonly components?: readonly ComponentRegistration[];
}

/**
 * One document on a host that installs no native repository provider.
 *
 * The vocabulary is declared, because declaring it reaches nothing. What a case
 * adds is exactly what it is about: a Repository that answers and no reads, or
 * reads supplied through the same contextual Api a native host answers.
 */
function runNeutralDocument(source: string, options: NeutralOptions = {}): Operation<Json> {
  return scoped(function* () {
    yield* useCompositionComponents();
    if (options.components !== undefined) {
      yield* registerComponents([...options.components]);
    }
    if (options.repository === true) {
      yield* Repository.around(
        // deno-lint-ignore require-yield
        { *ambient(): Operation<RepositorySelection | undefined> {
            return SUPPLIED_SELECTION;
          } },
        { at: "min" },
      );
    }
    const asked = options.reads;
    if (asked !== undefined) {
      yield* GitQuery.around(suppliedReads(asked), { at: "min" });
    }
    return yield* collect(
      yield* execute({ ...inlineSource(source), stream: new InMemoryStream() }),
    );
  });
}

/**
 * The four reads, answered by a host rather than by a native checkout.
 *
 * Every method records the normalized request it received, which is what makes
 * "the component composed exactly this" an observation. The answers are the
 * smallest valid results of each shape.
 */
function suppliedReads(asked: string[]): Parameters<typeof GitQuery.around>[0] {
  const record = (kind: string, request: Json): void => {
    asked.push(`${kind} ${canonicalJson(request)}`);
  };
  return {
    // deno-lint-ignore require-yield
    *files([invocation]: [GitFilesInvocation]): Operation<GitFilesResult> {
      record("files", requestJson(invocation.request));
      return { paths: ["a/b.ts"], next: null };
    },
    // deno-lint-ignore require-yield
    *changes([invocation]: [GitChangesInvocation]): Operation<GitChangesResult> {
      record("changes", requestJson(invocation.request));
      return { comparison: { compare: "staged", base: null }, changes: [], next: null };
    },
    // deno-lint-ignore require-yield
    *diff([invocation]: [GitDiffInvocation]): Operation<GitDiffResult> {
      record("diff", requestJson(invocation.request));
      return {
        comparison: { compare: "staged", base: null },
        text: "",
        offset: 0,
        length: 0,
        next: null,
      };
    },
    // deno-lint-ignore require-yield
    *file([invocation]: [GitFileInvocation]): Operation<GitFileResult> {
      record("file", requestJson(invocation.request));
      return {
        commit: "0".repeat(40),
        path: invocation.request.path,
        text: "supplied",
        offset: 0,
        length: 8,
        next: null,
      };
    },
  };
}

/** One normalized request, as JSON a case can compare exactly. */
function requestJson(request: GitObservationRequest): Json {
  if (request.kind === "files") {
    return { kind: "files", prefix: request.prefix, limit: request.limit, cursor: request.cursor };
  }
  if (request.kind === "file") {
    return {
      kind: "file",
      commit: request.commit,
      path: request.path,
      offset: request.offset,
      limit: request.limit,
    };
  }
  const comparison: Json =
    request.comparison.compare === "commits"
      ? {
          compare: "commits",
          base: request.comparison.base,
          head: request.comparison.head,
        }
      : { compare: request.comparison.compare };
  if (request.kind === "changes") {
    return {
      kind: "changes",
      comparison,
      paths: request.paths === null ? null : [...request.paths],
      limit: request.limit,
      cursor: request.cursor,
    };
  }
  return {
    kind: "diff",
    comparison,
    paths: request.paths === null ? null : [...request.paths],
    offset: request.offset,
    limit: request.limit,
    cursor: request.cursor,
  };
}

/** The closed reason this raised value refuses under, or what it was instead. */
function reasonOf(value: unknown): string {
  return value instanceof GitObservationError ? value.reason : String(value);
}

function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

/** The one bound value a case's document projected, as an object. */
function object(value: Json | undefined): Record<string, Json> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`expected one bound object, received ${JSON.stringify(value)}`);
  }
  return value;
}

function paths(value: Json | undefined): string[] {
  const listed = object(value).paths;
  if (!Array.isArray(listed)) {
    throw new Error(`expected a paths array, received ${JSON.stringify(listed)}`);
  }
  return listed.map((entry) => String(entry));
}

describe("GO1 — discovery addresses the chosen repository", () => {
  it("lists the tracked index paths and nothing else", function* () {
    const root = yield* useManagedRoot();
    const fixture = yield* useObservationFixture();
    const seen: Json[] = [];

    yield* runOrdinaryDocument(
      ['<Git.Files limit={1000} as="files" />', "", "<Captured value={files} />", ""].join("\n"),
      { root, cwd: fixture.root, components: [capturingProbe(seen)] },
    );

    expect(seen).toHaveLength(1);
    const listed = paths(seen[0]);
    expect(listed).toEqual([
      AWKWARD_PATH,
      "doc/renamed.md",
      "link-me.txt",
      "mode.sh",
      "nested",
      "src/a.ts",
      "src/added.ts",
      "src/bin.dat",
      MAGIC_PATH,
    ].sort());
    expect(object(seen[0]).next).toBe(null);
  });
});

describe("GO2 — discovery excludes what the index does not hold", () => {
  it("excludes untracked files, a nested checkout's contents and a sibling checkout", function* () {
    const root = yield* useManagedRoot();
    const fixture = yield* useObservationFixture();
    yield* writeFixtureFile(fixture.root, "untracked.md", "not tracked\n");
    const seen: Json[] = [];

    yield* runOrdinaryDocument(
      ['<Git.Files limit={1000} as="files" />', "", "<Captured value={files} />", ""].join("\n"),
      { root, cwd: fixture.root, components: [capturingProbe(seen)] },
    );

    const listed = paths(seen[0]);
    expect(listed).not.toContain("untracked.md");
    // The tracked gitlink is one path. Nothing beneath it, and nothing in the
    // untracked checkout beside it, is a path this repository's index holds.
    expect(listed).toContain("nested");
    expect(listed.filter((path) => path.startsWith("nested/"))).toEqual([]);
    expect(listed.filter((path) => path.startsWith("scratch-repo"))).toEqual([]);
  });

  it("matches prefix literally and answers root-relative paths from a subdirectory", function* () {
    const root = yield* useManagedRoot();
    const fixture = yield* useObservationFixture();
    const seen: Json[] = [];

    yield* runOrdinaryDocument(
      [
        '<Dir path="src">',
        "",
        '<Git.Files prefix="src/a" as="partial" />',
        "",
        "<Captured value={partial} />",
        "",
        "</Dir>",
        "",
      ].join("\n"),
      { root, cwd: fixture.root, components: [capturingProbe(seen)] },
    );

    // An incomplete final segment is a prefix, and the answer is relative to
    // the repository root rather than to the directory the element was in.
    expect(paths(seen[0])).toEqual(["src/a.ts", "src/added.ts"]);
  });

  it("reads a prefix holding glob characters as those characters", function* () {
    const root = yield* useManagedRoot();
    const fixture = yield* useObservationFixture();
    const seen: Json[] = [];

    yield* runOrdinaryDocument(
      [
        `<Git.Files prefix="star*name[1]?" as="magic" />`,
        "",
        "<Captured value={magic} />",
        "",
      ].join("\n"),
      { root, cwd: fixture.root, components: [capturingProbe(seen)] },
    );

    expect(paths(seen[0])).toEqual([MAGIC_PATH]);
  });
});

describe("GO3 — the three comparisons", () => {
  it("compares two commits with every status the fixture produces", function* () {
    const root = yield* useManagedRoot();
    const fixture = yield* useObservationFixture();
    const seen: Json[] = [];

    yield* runOrdinaryDocument(
      [
        `<Git.Changes compare="commits" base="${fixture.c1}" head="${fixture.c2}" as="changed" />`,
        "",
        "<Captured value={changed} />",
        "",
      ].join("\n"),
      { root, cwd: fixture.root, components: [capturingProbe(seen)] },
    );

    const result = object(seen[0]);
    expect(result.comparison).toEqual({
      compare: "commits",
      base: fixture.c1,
      head: fixture.c2,
    });
    expect(result.changes).toEqual([
      { path: "doc/renamed.md", status: "R", previousPath: "doc/orig.md" },
      { path: "gone.ts", status: "D", previousPath: null },
      { path: "link-me.txt", status: "T", previousPath: null },
      { path: "mode.sh", status: "M", previousPath: null },
      { path: "nested", status: "M", previousPath: null },
      { path: "src/added.ts", status: "A", previousPath: null },
      { path: "src/bin.dat", status: "M", previousPath: null },
    ]);
    expect(result.next).toBe(null);
  });

  it("compares the index with the working tree, and HEAD with the index", function* () {
    const root = yield* useManagedRoot();
    const fixture = yield* useObservationFixture();
    yield* writeFixtureFile(fixture.root, "src/a.ts", "export const a = 2;\n");
    yield* writeFixtureFile(fixture.root, "staged.ts", "export const staged = true;\n");
    fixture.run("add", "--", "staged.ts");
    yield* writeFixtureFile(fixture.root, "untracked.md", "not tracked\n");
    const seen: Json[] = [];

    yield* runOrdinaryDocument(
      [
        '<Git.Changes compare="unstaged" as="unstaged" />',
        "",
        "<Captured value={unstaged} />",
        "",
        '<Git.Changes compare="staged" as="staged" />',
        "",
        "<Captured value={staged} />",
        "",
      ].join("\n"),
      { root, cwd: fixture.root, components: [capturingProbe(seen)] },
    );

    const unstaged = object(seen[0]);
    expect(unstaged.comparison).toEqual({ compare: "unstaged" });
    // The untracked file is not a tracked change, so it is not here.
    expect(unstaged.changes).toEqual([
      { path: "src/a.ts", status: "M", previousPath: null },
    ]);

    const staged = object(seen[1]);
    expect(staged.comparison).toEqual({ compare: "staged", base: fixture.c2 });
    expect(staged.changes).toEqual([
      { path: "staged.ts", status: "A", previousPath: null },
    ]);
  });

  // Driven at the native performer rather than through a document, because no
  // installed provider can select an unborn repository: a selection's identity
  // pins a creation commit, and an unborn branch has none. What is under test
  // is the comparison a provider would reach if one did, which is the real
  // native read against a real unborn checkout.
  it("reports a staged addition on an unborn branch against the empty tree", function* () {
    const unborn = yield* useUnbornCheckout();

    const value = yield* performGitObservation(
      denoRepositoryHost(),
      "<Git.Changes>",
      {
        kind: "changes",
        comparison: { compare: "staged" },
        paths: null,
        limit: 100,
        cursor: null,
      },
      observationPlaceOf(unborn),
    );

    if (!("changes" in value)) {
      throw new Error("expected a changes result");
    }
    expect(value.comparison).toEqual({ compare: "staged", base: null });
    expect(value.changes).toEqual([{ path: "first.ts", status: "A", previousPath: null }]);
  });
});

describe("GO4 — the patch a comparison produces", () => {
  it("answers the comparison's own unified text, with Git's binary and mode metadata", function* () {
    const root = yield* useManagedRoot();
    const fixture = yield* useObservationFixture();
    const seen: Json[] = [];

    yield* runOrdinaryDocument(
      [
        `<Git.Diff compare="commits" base="${fixture.c1}" head="${fixture.c2}" limit={100000} as="patch" />`,
        "",
        "<Captured value={patch} />",
        "",
      ].join("\n"),
      { root, cwd: fixture.root, components: [capturingProbe(seen)] },
    );

    const result = object(seen[0]);
    const patch = String(result.text);
    expect(result.comparison).toEqual({ compare: "commits", base: fixture.c1, head: fixture.c2 });
    // Every shape the fixture produces, as patch text rather than as a summary.
    expect(patch).toContain("rename from doc/orig.md");
    expect(patch).toContain("rename to doc/renamed.md");
    expect(patch).toContain("Binary files a/src/bin.dat and b/src/bin.dat differ");
    expect(patch).toContain("old mode 100644");
    expect(patch).toContain("new mode 100755");
    expect(patch).toContain("new file mode 100644");
    expect(patch).toContain("deleted file mode 100644");
    expect(patch).toContain("Subproject commit");
    expect(result.offset).toBe(0);
    expect(result.length).toBe([...patch].length);
    expect(result.next).toBe(null);
  });

  it("narrows to literal files and directories, matching a rename on either side", function* () {
    const root = yield* useManagedRoot();
    const fixture = yield* useObservationFixture();
    const seen: Json[] = [];

    yield* runOrdinaryDocument(
      [
        `<Git.Changes compare="commits" base="${fixture.c1}" head="${fixture.c2}" paths={["src/"]} as="under" />`,
        "",
        "<Captured value={under} />",
        "",
        `<Git.Changes compare="commits" base="${fixture.c1}" head="${fixture.c2}" paths={["doc/orig.md"]} as="byOldPath" />`,
        "",
        "<Captured value={byOldPath} />",
        "",
        `<Git.Diff compare="commits" base="${fixture.c1}" head="${fixture.c2}" paths={["doc/orig.md"]} limit={100000} as="renamePatch" />`,
        "",
        "<Captured value={renamePatch} />",
        "",
        `<Git.Changes compare="commits" base="${fixture.c1}" head="${fixture.c2}" paths={[]} as="none" />`,
        "",
        "<Captured value={none} />",
        "",
        `<Git.Diff compare="commits" base="${fixture.c1}" head="${fixture.c2}" paths={[]} as="noPatch" />`,
        "",
        "<Captured value={noPatch} />",
        "",
      ].join("\n"),
      { root, cwd: fixture.root, components: [capturingProbe(seen)] },
    );

    expect(object(seen[0]).changes).toEqual([
      { path: "src/added.ts", status: "A", previousPath: null },
      { path: "src/bin.dat", status: "M", previousPath: null },
    ]);
    // The old path selects the whole rename record, not half of it.
    expect(object(seen[1]).changes).toEqual([
      { path: "doc/renamed.md", status: "R", previousPath: "doc/orig.md" },
    ]);
    expect(String(object(seen[2]).text)).toContain("rename from doc/orig.md");
    // An empty selector is a thing a document says, and it selects nothing.
    expect(object(seen[3]).changes).toEqual([]);
    expect(object(seen[4]).text).toBe("");
    expect(object(seen[4]).length).toBe(0);
    expect(object(seen[4]).next).toBe(null);
  });

  it("keeps a tracked gitlink's moved pointer without reading inside it", function* () {
    const root = yield* useManagedRoot();
    const fixture = yield* useObservationFixture();
    const seen: Json[] = [];

    yield* runOrdinaryDocument(
      [
        `<Git.Diff compare="commits" base="${fixture.c1}" head="${fixture.c2}" paths={["nested"]} limit={100000} as="pointer" />`,
        "",
        "<Captured value={pointer} />",
        "",
      ].join("\n"),
      { root, cwd: fixture.root, components: [capturingProbe(seen)] },
    );

    const patch = String(object(seen[0]).text);
    expect(patch).toContain(`-Subproject commit ${fixture.gitlink.before}`);
    expect(patch).toContain(`+Subproject commit ${fixture.gitlink.after}`);
    // One path and one pointer. Nothing beneath the gitlink is read, so the
    // nested repository's own file never appears.
    expect(patch).not.toContain("inner.txt");
  });

  it("collapses an unmerged path to one record", function* () {
    const root = yield* useManagedRoot();
    const conflicted = yield* useConflictedCheckout();
    const seen: Json[] = [];

    yield* runOrdinaryDocument(
      ['<Git.Changes compare="unstaged" as="unstaged" />', "", "<Captured value={unstaged} />", ""].join(
        "\n",
      ),
      { root, cwd: conflicted.root, components: [capturingProbe(seen)] },
    );

    expect(object(seen[0]).changes).toEqual([
      { path: "shared.txt", status: "U", previousPath: null },
    ]);
  });
});

describe("GO5 — pages are bounded, complete, and about one observation", () => {
  it("defaults to 100 records, follows every page once, and honors a larger limit", function* () {
    const root = yield* useManagedRoot();
    const fixture = yield* useGeneratedFixture(1002);
    const seen: Json[] = [];

    yield* runOrdinaryDocument(
      ['<Git.Files as="page" />', "", "<Captured value={page} />", ""].join("\n"),
      { root, cwd: fixture.root, components: [capturingProbe(seen)] },
    );
    expect(paths(seen[0])).toHaveLength(100);
    expect(object(seen[0]).next).not.toBe(null);

    // Every page, followed through the ordinary Api with the cursor the
    // previous page supplied, until it says there is no more.
    const followed: string[] = [];
    yield* runOrdinaryDocument("<Follows />\n", {
      root,
      cwd: fixture.root,
      components: [
        followingProbe("Follows", function* (place) {
          let cursor: string | null = null;
          for (;;) {
            const page: GitFilesResult = yield* GitQuery.operations.files({
              ...place,
              request: { kind: "files", prefix: null, limit: 100, cursor },
            });
            followed.push(...page.paths);
            if (page.next === null) {
              break;
            }
            cursor = page.next.cursor;
          }
        }),
      ],
    });
    expect(followed).toEqual([...fixture.paths]);
    expect(new Set(followed).size).toBe(followed.length);

    // One read for all of them, which is the claim that there is no hidden cap.
    const whole: Json[] = [];
    yield* runOrdinaryDocument(
      ['<Git.Files limit={1002} as="all" />', "", "<Captured value={all} />", ""].join("\n"),
      { root, cwd: fixture.root, components: [capturingProbe(whole)] },
    );
    expect(paths(whole[0])).toEqual([...fixture.paths]);
    expect(object(whole[0]).next).toBe(null);
  });

  it("pages changes at a limit of one and at the default", function* () {
    const root = yield* useManagedRoot();
    const fixture = yield* useGeneratedFixture(1002);
    for (const path of fixture.paths) {
      yield* writeFixtureFile(fixture.root, path, "changed\n");
    }
    const seen: Json[] = [];

    yield* runOrdinaryDocument(
      [
        '<Git.Changes compare="unstaged" limit={1} as="one" />',
        "",
        "<Captured value={one} />",
        "",
        '<Git.Changes compare="unstaged" as="hundred" />',
        "",
        "<Captured value={hundred} />",
        "",
      ].join("\n"),
      { root, cwd: fixture.root, components: [capturingProbe(seen)] },
    );

    const one = object(seen[0]);
    expect(one.changes).toEqual([
      { path: fixture.paths[0], status: "M", previousPath: null },
    ]);
    expect(one.next).toEqual({ compare: "unstaged", limit: 1, cursor: expect.any(String) });

    const hundred = object(seen[1]);
    expect(Array.isArray(hundred.changes) ? hundred.changes.length : 0).toBe(100);
    expect(hundred.next).toEqual({
      compare: "unstaged",
      limit: 100,
      cursor: expect.any(String),
    });
  });

  it("windows a patch at the default, above 65536, and reassembles the whole text", function* () {
    const root = yield* useManagedRoot();
    const fixture = yield* useGeneratedFixture(1002);
    for (const path of fixture.paths) {
      yield* writeFixtureFile(fixture.root, path, "changed\n");
    }
    const seen: Json[] = [];
    const windows: string[] = [];
    let whole = "";

    yield* runOrdinaryDocument(
      ['<Git.Diff compare="unstaged" as="first" />', "", "<Captured value={first} />", ""].join(
        "\n",
      ),
      { root, cwd: fixture.root, components: [capturingProbe(seen)] },
    );
    const first = object(seen[0]);
    expect([...String(first.text)]).toHaveLength(4096);
    expect(first.offset).toBe(0);
    expect(first.next).not.toBe(null);

    yield* runOrdinaryDocument("<Follows />\n", {
      root,
      cwd: fixture.root,
      components: [
        followingProbe("Follows", function* (place) {
          let offset = 0;
          let cursor: string | null = null;
          for (;;) {
            const page: GitDiffResult = yield* GitQuery.operations.diff({
              ...place,
              request: {
                kind: "diff",
                comparison: { compare: "unstaged" },
                paths: null,
                offset,
                limit: 70000,
                cursor,
              },
            });
            windows.push(page.text);
            if (page.next === null) {
              whole = windows.join("");
              expect(page.length).toBe([...whole].length);
              break;
            }
            offset = page.next.offset;
            cursor = page.next.cursor;
          }
        }),
      ],
    });

    // A limit above the old proposed cap is honored, and the windows are the
    // whole patch rather than a prefix of it.
    expect([...(windows[0] ?? "")]).toHaveLength(70000);
    expect(whole).toBe(fixture.output("diff", "--no-ext-diff", "--no-textconv", "--no-color"));
  });
});

describe("GO6 — a changed observation cannot be paged over", () => {
  it("refuses a file listing whose paths changed between pages", function* () {
    const root = yield* useManagedRoot();
    const fixture = yield* useGeneratedFixture(150);

    const raised_ = yield* raised(
      runOrdinaryDocument(
        [
          '<Git.Files limit={100} as="page" />',
          "",
          "<Mutates />",
          "",
          '<Git.Files limit={100} cursor={page.next.cursor} as="second" />',
          "",
        ].join("\n"),
        {
          root,
          cwd: fixture.root,
          components: [
            actionProbe("Mutates", function* () {
              yield* writeFixtureFile(fixture.root, "gen/extra.txt", "extra\n");
              fixture.run("add", "--", "gen/extra.txt");
            }),
          ],
        },
      ),
    );

    expect(reasonOf(raised_)).toBe("stale-continuation");
    expect(messageOf(raised_)).toBe(
      "The Git observation changed. Restart <Git.Files> without cursor.",
    );
  });

  // The mutation has to change the *records*, not just the bytes behind one:
  // editing a path already reported as modified leaves the normalized listing
  // identical, and a read that restarted for that would refuse a page it could
  // honestly answer. So this adds a record the first page never described.
  it("refuses a changes listing whose records changed between pages", function* () {
    const root = yield* useManagedRoot();
    const fixture = yield* useGeneratedFixture(150);
    for (const path of fixture.paths.slice(0, 120)) {
      yield* writeFixtureFile(fixture.root, path, "changed\n");
    }

    const raised_ = yield* raised(
      runOrdinaryDocument(
        [
          '<Git.Changes compare="unstaged" limit={100} as="page" />',
          "",
          "<Mutates />",
          "",
          '<Git.Changes compare="unstaged" limit={100} cursor={page.next.cursor} as="second" />',
          "",
        ].join("\n"),
        {
          root,
          cwd: fixture.root,
          components: [
            actionProbe("Mutates", function* () {
              yield* writeFixtureFile(fixture.root, fixture.paths[149] ?? "", "changed too\n");
            }),
          ],
        },
      ),
    );

    expect(reasonOf(raised_)).toBe("stale-continuation");
    expect(messageOf(raised_)).toBe(
      "The Git observation changed. Restart <Git.Changes> without cursor.",
    );
  });

  it("refuses a patch whose text changed between windows, and names offset zero", function* () {
    const root = yield* useManagedRoot();
    const fixture = yield* useGeneratedFixture(150);
    for (const path of fixture.paths) {
      yield* writeFixtureFile(fixture.root, path, "changed\n");
    }

    const raised_ = yield* raised(
      runOrdinaryDocument(
        [
          '<Git.Diff compare="unstaged" as="page" />',
          "",
          "<Mutates />",
          "",
          '<Git.Diff compare="unstaged" offset={page.next.offset} cursor={page.next.cursor} as="second" />',
          "",
        ].join("\n"),
        {
          root,
          cwd: fixture.root,
          components: [
            actionProbe("Mutates", function* () {
              yield* writeFixtureFile(fixture.root, fixture.paths[0] ?? "", "changed again\n");
            }),
          ],
        },
      ),
    );

    expect(reasonOf(raised_)).toBe("stale-continuation");
    expect(messageOf(raised_)).toBe(
      "The Git observation changed. Restart <Git.Diff> without cursor and offset={0}.",
    );
  });

  it("follows a continuation unchanged when the repository changed elsewhere", function* () {
    const root = yield* useManagedRoot();
    const fixture = yield* useGeneratedFixture(150);
    const seen: Json[] = [];

    yield* runOrdinaryDocument(
      [
        '<Git.Files prefix="gen/file-0000" limit={5} as="page" />',
        "",
        "<Mutates />",
        "",
        '<Git.Files prefix="gen/file-0000" limit={5} cursor={page.next.cursor} as="second" />',
        "",
        "<Captured value={second} />",
        "",
      ].join("\n"),
      {
        root,
        cwd: fixture.root,
        components: [
          capturingProbe(seen),
          actionProbe("Mutates", function* () {
            // Outside the selected observation: an untracked file changes no
            // tracked path, so this page is still a page of the same answer.
            yield* writeFixtureFile(fixture.root, "untracked-elsewhere.txt", "elsewhere\n");
          }),
        ],
      },
    );

    expect(paths(seen[0])).toEqual([
      "gen/file-00005.txt",
      "gen/file-00006.txt",
      "gen/file-00007.txt",
      "gen/file-00008.txt",
      "gen/file-00009.txt",
    ]);
  });

  it("refuses a cursor that is malformed, for another read, or for another checkout", function* () {
    const root = yield* useManagedRoot();
    const fixture = yield* useGeneratedFixture(150);
    const other = yield* useGeneratedFixture(150);
    const borrowed: string[] = [];

    yield* runOrdinaryDocument("<Follows />\n", {
      root,
      cwd: other.root,
      components: [
        followingProbe("Follows", function* (place) {
          const page: GitFilesResult = yield* GitQuery.operations.files({
            ...place,
            request: { kind: "files", prefix: null, limit: 10, cursor: null },
          });
          if (page.next === null) {
            throw new Error("the generated fixture should page");
          }
          borrowed.push(page.next.cursor);
        }),
      ],
    });

    for (const cursor of ["not-a-cursor", borrowed[0] ?? ""]) {
      const raised_ = yield* raised(
        runOrdinaryDocument(
          [`<Git.Files limit={10} cursor="${cursor}" as="page" />`, ""].join("\n"),
          { root, cwd: fixture.root },
        ),
      );
      expect(reasonOf(raised_)).toBe("stale-continuation");
    }

    // A cursor for another kind of read is the same refusal: it describes an
    // observation this element never made.
    const wrongKind = yield* raised(
      runOrdinaryDocument(
        [
          '<Git.Files limit={10} as="page" />',
          "",
          '<Git.Changes compare="unstaged" cursor={page.next.cursor} as="second" />',
          "",
        ].join("\n"),
        { root, cwd: fixture.root },
      ),
    );
    expect(reasonOf(wrongKind)).toBe("stale-continuation");
  });
});

describe("GO7 — a file is read as one commit holds it", () => {
  it("windows the committed text, stays on its commit, and reassembles it", function* () {
    const root = yield* useManagedRoot();
    const fixture = yield* useFileFixture();
    const seen: Json[] = [];
    const windows: string[] = [];

    yield* runOrdinaryDocument(
      [
        '<Git.File commit="HEAD~1" path="big.txt" as="first" />',
        "",
        "<Captured value={first} />",
        "",
      ].join("\n"),
      { root, cwd: fixture.root, components: [capturingProbe(seen)] },
    );

    const first = object(seen[0]);
    expect(first.commit).toBe(fixture.f1);
    expect(first.path).toBe("big.txt");
    expect(first.offset).toBe(0);
    expect(first.length).toBe([...LONG_BLOB].length);
    // The default window, counted in code points: the astral character is the
    // last one in it and arrives whole.
    expect([...String(first.text)]).toHaveLength(4096);
    expect(String(first.text).endsWith(ASTRAL)).toBe(true);
    expect(first.next).toEqual({
      commit: fixture.f1,
      path: "big.txt",
      offset: 4096,
      limit: 4096,
    });
    windows.push(String(first.text));

    // The branch and the working copy both move before the continuation is
    // followed, so a read that resolved `HEAD~1` again would read another file.
    fixture.run("commit", "--allow-empty", "-m", "third");
    yield* writeFixtureFile(fixture.root, "big.txt", "working copy\n");

    yield* runOrdinaryDocument("<Follows />\n", {
      root,
      cwd: fixture.root,
      components: [
        followingProbe("Follows", function* (place) {
          let offset = 4096;
          for (;;) {
            const page: GitFileResult = yield* GitQuery.operations.file({
              ...place,
              request: {
                kind: "file",
                commit: fixture.f1,
                path: "big.txt",
                offset,
                limit: 70000,
              },
            });
            expect(page.commit).toBe(fixture.f1);
            windows.push(page.text);
            if (page.next === null) {
              break;
            }
            offset = page.next.offset;
          }
        }),
      ],
    });

    expect(windows.join("")).toBe(LONG_BLOB);
  });

  it("answers a middle window, an empty window past the end, and an empty file", function* () {
    const root = yield* useManagedRoot();
    const fixture = yield* useFileFixture();
    const seen: Json[] = [];
    const total = [...LONG_BLOB].length;

    yield* runOrdinaryDocument(
      [
        `<Git.File commit="${fixture.f1}" path="big.txt" offset={10} limit={5} as="middle" />`,
        "",
        "<Captured value={middle} />",
        "",
        `<Git.File commit="${fixture.f1}" path="big.txt" offset={${total}} as="atEnd" />`,
        "",
        "<Captured value={atEnd} />",
        "",
        `<Git.File commit="${fixture.f1}" path="big.txt" offset={${total + 500}} as="pastEnd" />`,
        "",
        "<Captured value={pastEnd} />",
        "",
        `<Git.File commit="${fixture.f1}" path="empty.txt" as="empty" />`,
        "",
        "<Captured value={empty} />",
        "",
      ].join("\n"),
      { root, cwd: fixture.root, components: [capturingProbe(seen)] },
    );

    expect(object(seen[0]).text).toBe("aaaaa");
    expect(object(seen[0]).next).toEqual({
      commit: fixture.f1,
      path: "big.txt",
      offset: 15,
      limit: 5,
    });

    for (const past of [object(seen[1]), object(seen[2])]) {
      expect(past.text).toBe("");
      expect(past.length).toBe(total);
      expect(past.next).toBe(null);
    }
    expect(object(seen[1]).offset).toBe(total);
    expect(object(seen[2]).offset).toBe(total + 500);

    const empty = object(seen[3]);
    expect(empty.text).toBe("");
    expect(empty.length).toBe(0);
    expect(empty.next).toBe(null);
  });

  it("refuses an unusable revision, an absent path, a tree, a gitlink and a nontext blob", function* () {
    const root = yield* useManagedRoot();
    const fixture = yield* useFileFixture();
    const main = yield* useObservationFixture();

    const refusals: { source: string; cwd: string; reason: string }[] = [
      {
        source: `<Git.File commit="no-such-revision" path="big.txt" as="x" />`,
        cwd: fixture.root,
        reason: "invalid-revision",
      },
      {
        source: `<Git.File commit="${fixture.f1}" path="not/there.txt" as="x" />`,
        cwd: fixture.root,
        reason: "absent-path",
      },
      {
        source: `<Git.File commit="${fixture.f1}" path="dir" as="x" />`,
        cwd: fixture.root,
        reason: "nontext-blob",
      },
      {
        source: `<Git.File commit="${main.c2}" path="nested" as="x" />`,
        cwd: main.root,
        reason: "nontext-blob",
      },
      {
        source: `<Git.File commit="${fixture.f1}" path="bad.bin" as="x" />`,
        cwd: fixture.root,
        reason: "nontext-blob",
      },
      {
        source: `<Git.File commit="${fixture.f1}" path="nul.bin" as="x" />`,
        cwd: fixture.root,
        reason: "nontext-blob",
      },
    ];

    for (const entry of refusals) {
      const raised_ = yield* raised(
        runOrdinaryDocument(`${entry.source}\n`, { root, cwd: entry.cwd }),
      );
      expect(`${entry.source}: ${reasonOf(raised_)}`).toBe(`${entry.source}: ${entry.reason}`);
    }
  });

  it("answers a symbolic link's own stored text rather than what it points at", function* () {
    const root = yield* useManagedRoot();
    const fixture = yield* useFileFixture();
    const seen: Json[] = [];

    yield* runOrdinaryDocument(
      [
        `<Git.File commit="${fixture.f1}" path="points-at-big" as="link" />`,
        "",
        "<Captured value={link} />",
        "",
      ].join("\n"),
      { root, cwd: fixture.root, components: [capturingProbe(seen)] },
    );

    // The link's target, as the blob holds it. Nothing followed it.
    expect(object(seen[0]).text).toBe("big.txt");
    expect(object(seen[0]).length).toBe(7);
  });
});

describe("GO8 — a read runs no repository-defined program and changes nothing", () => {
  it("leaves every sentinel unfired and the repository byte-identical", function* () {
    const root = yield* useManagedRoot();
    const fixture = yield* useObservationFixture();
    const sentinels = yield* useSentinelConfiguration(fixture.root, fixture.home);
    yield* writeFixtureFile(fixture.root, "src/a.ts", "export const a = 3;\n");
    const before = yield* fingerprintCheckout(fixture.root);
    const counted = countingOrdinaryHost();
    const scratch: string[] = [];
    const seen: Json[] = [];

    yield* runOrdinaryDocument(
      [
        '<Git.Files limit={1000} as="files" />',
        "",
        '<Git.Changes compare="unstaged" as="changes" />',
        "",
        '<Git.Diff compare="unstaged" limit={100000} as="diff" />',
        "",
        `<Git.File commit="${fixture.c1}" path="src/a.ts" as="source" />`,
        "",
        "<Captured value={diff} />",
        "",
        "<Captured value={source} />",
        "",
      ].join("\n"),
      {
        root,
        cwd: fixture.root,
        components: [capturingProbe(seen)],
        host: recordingDirectories(counted.host, scratch),
      },
    );

    // Not one of them ran, and no credential session was opened for a read.
    expect(yield* sentinels.fired()).toEqual([]);
    expect(counted.counters.sessions).toEqual([]);
    // The diff is still the diff: the sentinel would have replaced the text.
    expect(String(object(seen[0]).text)).toContain("+export const a = 3;");
    expect(object(seen[1]).text).toBe("export const a = 1;\n");

    // Nothing in the repository moved, including the index and its mode.
    expect(yield* fingerprintCheckout(fixture.root)).toEqual(before);

    // And the scratch each read owned is gone, after the reads were joined.
    expect(scratch.length > 0).toBe(true);
    for (const directory of scratch) {
      expect(yield* exists(directory)).toBe(false);
    }
  });

  it("reads a linked checkout's own split index and leaves all three untouched", function* () {
    const root = yield* useManagedRoot();
    const fixture = yield* useObservationFixture();
    const linked = yield* useLinkedWorktree(fixture);
    fixture.run("update-index", "--split-index");
    linked.run("update-index", "--split-index");
    yield* writeFixtureFile(linked.root, "src/a.ts", "export const a = 9;\n");

    const indexes = yield* indexFingerprints(fixture, linked);
    const seen: Json[] = [];

    yield* runOrdinaryDocument(
      [
        '<Git.Files limit={1000} as="files" />',
        "",
        "<Captured value={files} />",
        "",
        '<Git.Changes compare="unstaged" as="changes" />',
        "",
        "<Captured value={changes} />",
        "",
        '<Git.Diff compare="unstaged" limit={100000} as="diff" />',
        "",
        "<Captured value={diff} />",
        "",
      ].join("\n"),
      { root, cwd: linked.root, components: [capturingProbe(seen)] },
    );

    // The linked checkout's own index answered: its working tree holds the
    // edit, and the primary checkout's does not.
    expect(paths(seen[0])).toContain("src/a.ts");
    expect(object(seen[1]).changes).toEqual([
      { path: "src/a.ts", status: "M", previousPath: null },
    ]);
    expect(String(object(seen[2]).text)).toContain("+export const a = 9;");

    expect(yield* indexFingerprints(fixture, linked)).toEqual(indexes);
  });
});

describe("GO9 — which checkout answers, and what cannot choose one", () => {
  it("reads the ambient checkout, a lexical Repository, a Worktree and a Dir inside one", function* () {
    const remote = yield* useBareRemote(REMOTE);
    const root = yield* useManagedRoot();
    const ambient = yield* useHostCheckout(remote.locator);
    yield* writeFixtureFile(ambient.root, "only-here.txt", "ambient\n");
    ambient.run("add", "--", "only-here.txt");
    ambient.run("commit", "-m", "ambient only");
    const seen: Json[] = [];

    yield* runOrdinaryDocument(
      [
        '<Git.Files limit={100} as="here" />',
        "",
        "<Captured value={here} />",
        "",
        `<Repository name="project" url="${remote.locator}">`,
        "",
        '<Git.Files limit={100} as="managed" />',
        "",
        "<Captured value={managed} />",
        "",
        '<Worktree name="side" branch="side">',
        "",
        '<Git.Changes compare="unstaged" as="inSide" />',
        "",
        "<Captured value={inSide} />",
        "",
        '<Dir path="deeper">',
        "",
        '<Git.Files limit={100} as="fromDir" />',
        "",
        "<Captured value={fromDir} />",
        "",
        "</Dir>",
        "",
        "</Worktree>",
        "",
        "</Repository>",
        "",
      ].join("\n"),
      { root, cwd: ambient.root, components: [capturingProbe(seen)] },
    );

    // The ambient checkout holds a path the managed clone never received, which
    // is how a read that answered from the wrong one would say so.
    expect(paths(seen[0])).toContain("only-here.txt");
    expect(paths(seen[1])).toEqual(["which.txt"]);
    expect(object(seen[2]).changes).toEqual([]);
    // A `<Dir>` beneath a Worktree stays inside that checkout, and the answer
    // is still relative to its repository root.
    expect(paths(seen[3])).toEqual(["which.txt"]);
  });

  it("distinguishes two sibling checkouts of one repository by their content", function* () {
    const root = yield* useManagedRoot();
    const fixture = yield* useObservationFixture();
    const linked = yield* useLinkedWorktree(fixture);
    yield* writeFixtureFile(linked.root, "only-linked.txt", "linked\n");
    linked.run("add", "--", "only-linked.txt");
    linked.run("commit", "-m", "linked only");
    const seen: Json[] = [];

    yield* runOrdinaryDocument(
      ['<Git.Files limit={1000} as="files" />', "", "<Captured value={files} />", ""].join("\n"),
      { root, cwd: linked.root, components: [capturingProbe(seen)] },
    );
    expect(paths(seen[0])).toContain("only-linked.txt");

    const primary: Json[] = [];
    yield* runOrdinaryDocument(
      ['<Git.Files limit={1000} as="files" />', "", "<Captured value={files} />", ""].join("\n"),
      { root, cwd: fixture.root, components: [capturingProbe(primary)] },
    );
    expect(paths(primary[0])).not.toContain("only-linked.txt");
  });

  it("refuses a foreign selection and an edited one before reaching a host", function* () {
    const root = yield* useManagedRoot();
    const fixture = yield* useObservationFixture();
    const counted = countingOrdinaryHost();

    const foreign: RepositorySelection = {
      selection: "not-one-this-provider-minted",
      name: "checkout",
      identity: {
        name: "checkout",
        locatorFingerprint: "0".repeat(64),
        requestedBase: null,
        creationCommit: fixture.c2,
        primaryBranch: "main",
        objectFormat: "sha1",
      },
      checkoutPath: fixture.root,
    };

    const refusedForeign = yield* raised(
      runOrdinaryDocument('<Git.Files as="files" />\n', {
        root,
        cwd: fixture.root,
        host: counted.host,
        contextualRepository: foreign,
      }),
    );
    expect(refusedForeign instanceof GitOperationAdmissionError).toBe(true);
    expect(subcommands(counted.counters)).not.toContain("ls-files");

    // A selection this provider did mint, with one member changed afterwards.
    const edited: RepositorySelection[] = [];
    yield* runOrdinaryDocument("<Follows />\n", {
      root,
      cwd: fixture.root,
      components: [
        followingProbe("Follows", function* (place) {
          edited.push({ ...place.repository, name: "renamed" });
        }),
      ],
    });
    const second = countingOrdinaryHost();
    const refusedEdited = yield* raised(
      runOrdinaryDocument('<Git.Files as="files" />\n', {
        root,
        cwd: fixture.root,
        host: second.host,
        contextualRepository: edited[0],
      }),
    );
    expect(refusedEdited instanceof GitOperationAdmissionError).toBe(true);
    expect(subcommands(second.counters)).not.toContain("ls-files");
  });
});

describe("GO10 — the comparison sees an edit the index's own times would hide", () => {
  it("reports a modification whose size and recorded time match the index entry", function* () {
    const root = yield* useManagedRoot();
    const fixture = yield* useObservationFixture();
    const indexPath = join(fixture.root, ".git", "index");
    const indexTimes = yield* lstat(indexPath);
    // The same length, and the index's own modification time. This is exactly
    // the state Git calls racily clean: the cached stat data matches, so the
    // only way to see the change is to compare content — and the only reason
    // Git does is that the entry is no older than the index holding it. A
    // private copy stamped with the current time destroys that relationship.
    yield* writeFixtureFile(fixture.root, "src/a.ts", "export const a = 7;\n");
    yield* until(utimes(join(fixture.root, "src", "a.ts"), indexTimes.mtime, indexTimes.mtime));
    const seen: Json[] = [];

    yield* runOrdinaryDocument(
      [
        '<Git.Changes compare="unstaged" as="changes" />',
        "",
        "<Captured value={changes} />",
        "",
        '<Git.Diff compare="unstaged" limit={100000} as="diff" />',
        "",
        "<Captured value={diff} />",
        "",
      ].join("\n"),
      { root, cwd: fixture.root, components: [capturingProbe(seen)] },
    );

    expect(object(seen[0]).changes).toEqual([
      { path: "src/a.ts", status: "M", previousPath: null },
    ]);
    expect(String(object(seen[1]).text)).toContain("+export const a = 7;");
  });
});

describe("GO11 — the authored contract, before a provider is reached", () => {
  it("refuses a missing binding, a paired form, an extra prop and a mismatched comparison", function* () {
    const root = yield* useManagedRoot();
    const fixture = yield* useObservationFixture();
    const counted = countingOrdinaryHost();

    const refused: { source: string; reason: string }[] = [
      { source: "<Git.Files />", reason: "refused" },
      { source: '<Git.Files as="files">content</Git.Files>', reason: "unexpected-content" },
      { source: '<Git.Files unknown="x" as="files" />', reason: "refused" },
      { source: '<Git.Files limit={0} as="files" />', reason: "refused" },
      {
        source: '<Git.Changes compare="commits" base="HEAD" as="changes" />',
        reason: "invalid-invocation",
      },
      {
        source: '<Git.Changes compare="unstaged" base="HEAD" head="HEAD" as="changes" />',
        reason: "invalid-invocation",
      },
      { source: '<Git.Diff compare="staged" offset={-1} as="diff" />', reason: "refused" },
      { source: '<Git.File commit="HEAD" as="source" />', reason: "refused" },
      {
        source: '<Git.File commit="HEAD" path="/absolute.ts" as="source" />',
        reason: "invalid-invocation",
      },
      {
        source: '<Git.File commit="HEAD" path="a/../../escape.ts" as="source" />',
        reason: "invalid-invocation",
      },
    ];

    for (const entry of refused) {
      const raised_ = yield* raised(
        runOrdinaryDocument(`${entry.source}\n`, { root, cwd: fixture.root, host: counted.host }),
      );
      expect(`${entry.source}: ${refusalKind(raised_)}`).toBe(`${entry.source}: ${entry.reason}`);
    }

    // Not one of them reached a repository: no read ran, and no `git` for one.
    expect(subcommands(counted.counters)).toEqual([]);
  });

  it("declares exactly the four names, forms, props, results and defaults", function* () {
    const registered = COMPOSITION_REGISTRATIONS.filter((entry) =>
      ["Git.Files", "Git.Changes", "Git.Diff", "Git.File"].includes(entry.name),
    );
    expect(registered.map((entry) => entry.name)).toEqual([
      "Git.Files",
      "Git.Changes",
      "Git.Diff",
      "Git.File",
    ]);
    for (const entry of registered) {
      // A declared `returns` is what makes `as` required, which is checked
      // before the body runs and therefore before any provider is asked.
      expect(`${entry.name}: ${entry.returns === undefined ? "open" : "declared"}`).toBe(
        `${entry.name}: declared`,
      );
      expect(entry.origin).toBe(COMPOSITION_ORIGIN);
      expect(entry.forms).toBe(undefined);
    }

    expect(Object.keys(propertiesOf(filesProps)).sort()).toEqual(["cursor", "limit", "prefix"]);
    expect(Object.keys(propertiesOf(changesProps)).sort()).toEqual([
      "base",
      "compare",
      "cursor",
      "head",
      "limit",
      "paths",
    ]);
    expect(Object.keys(propertiesOf(diffProps)).sort()).toEqual([
      "base",
      "compare",
      "cursor",
      "head",
      "limit",
      "offset",
      "paths",
    ]);
    expect(Object.keys(propertiesOf(fileProps)).sort()).toEqual([
      "commit",
      "limit",
      "offset",
      "path",
    ]);

    expect(Object.keys(propertiesOf(filesReturns)).sort()).toEqual(["next", "paths"]);
    expect(Object.keys(propertiesOf(changesReturns)).sort()).toEqual([
      "changes",
      "comparison",
      "next",
    ]);
    expect(Object.keys(propertiesOf(diffReturns)).sort()).toEqual([
      "comparison",
      "length",
      "next",
      "offset",
      "text",
    ]);
    expect(Object.keys(propertiesOf(fileReturns)).sort()).toEqual([
      "commit",
      "length",
      "next",
      "offset",
      "path",
      "text",
    ]);

    expect(DEFAULT_RECORD_LIMIT).toBe(100);
    expect(DEFAULT_TEXT_LIMIT).toBe(4096);
    expect([...GIT_COMPARE_MODES]).toEqual(["unstaged", "staged", "commits"]);
  });
});

describe("GO12 — availability is the installed provider's, with no fallback", () => {
  it("refuses all four on a host that installs nothing for them", function* () {
    for (const element of FOUR_ELEMENTS) {
      const raised_ = yield* raised(runNeutralDocument(`${element.source}\n`));
      // A neutral host has no Repository provider either, so the refusal is
      // the first absent one — and nothing falls back to the caller's own
      // filesystem on the way.
      expect(`${element.name}: ${raised_ === undefined ? "answered" : "refused"}`).toBe(
        `${element.name}: refused`,
      );
    }
  });

  it("reaches the reads' own absent-provider refusal once a repository is selected", function* () {
    for (const element of FOUR_ELEMENTS) {
      const raised_ = yield* raised(
        runNeutralDocument(`${element.source}\n`, { repository: true }),
      );
      expect(`${element.name}: ${raised_ instanceof GitObservationProviderError}`).toBe(
        `${element.name}: true`,
      );
    }
  });

  it("answers through the same Api when a host supplies the four methods", function* () {
    const asked: string[] = [];
    const seen: Json[] = [];

    yield* runNeutralDocument(
      [
        '<Git.Files prefix="a/" as="files" />',
        "",
        "<Captured value={files} />",
        "",
        '<Git.Changes compare="staged" as="changes" />',
        "",
        "<Captured value={changes} />",
        "",
        '<Git.Diff compare="staged" as="diff" />',
        "",
        "<Captured value={diff} />",
        "",
        '<Git.File commit="HEAD~1" path="a/b.ts" as="source" />',
        "",
        "<Captured value={source} />",
        "",
      ].join("\n"),
      { repository: true, reads: asked, components: [capturingProbe(seen)] },
    );

    // The request each component composed, in the order they ran.
    expect(asked).toEqual([
      'files {"cursor":null,"kind":"files","limit":100,"prefix":"a/"}',
      'changes {"comparison":{"compare":"staged"},"cursor":null,"kind":"changes","limit":100,"paths":null}',
      'diff {"comparison":{"compare":"staged"},"cursor":null,"kind":"diff","limit":4096,"offset":0,"paths":null}',
      'file {"commit":"HEAD~1","kind":"file","limit":4096,"offset":0,"path":"a/b.ts"}',
    ]);
    // And the typed JSON each one bound.
    expect(seen[0]).toEqual({ paths: ["a/b.ts"], next: null });
    expect(seen[1]).toEqual({
      comparison: { compare: "staged", base: null },
      changes: [],
      next: null,
    });
    expect(seen[2]).toEqual({
      comparison: { compare: "staged", base: null },
      text: "",
      offset: 0,
      length: 0,
      next: null,
    });
    expect(seen[3]).toEqual({
      commit: "0".repeat(40),
      path: "a/b.ts",
      text: "supplied",
      offset: 0,
      length: 8,
      next: null,
    });
  });
});
