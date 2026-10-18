/**
 * Tier GOR — the shared codecs the four Git reads are carried by.
 *
 * Result JSON, the total parsers a continuation and a journal read it back
 * through, the code-point windows a page is cut with, and the version-1 cursor.
 * These are decided by arithmetic rather than by a repository, which is why they
 * are asserted here: every one of them has a wrong answer that no fixture would
 * make obvious.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import type { Json } from "@executablemd/durable-streams";
import type {
  GitChangesRequest,
  GitDiffRequest,
  GitFileRequest,
  GitFilesRequest,
  GitObservationRequest,
} from "@executablemd/git/api";
import {
  DEFAULT_RECORD_LIMIT,
  DEFAULT_TEXT_LIMIT,
  admitChangesRequest,
  admitDiffRequest,
  admitFileRequest,
  admitFilesRequest,
  selectedChange,
  selectsPath,
  sortedChanges,
} from "../src/composition/observation-api.ts";
import {
  codePointLength,
  encodeGitObservationCursor,
  gitChangesResultJson,
  gitDiffResultJson,
  gitFileResultJson,
  gitFilesResultJson,
  gitObservationQuery,
  gitRecordWindow,
  gitTextWindow,
  observationDigest,
  parseGitObservationCursor,
  parseGitObservationValue,
  sameObservationCheckout,
} from "../src/composition/observation-records.ts";
import type { GitObservationCheckout } from "../src/composition/observation-records.ts";
import { GitObservationError } from "../src/composition/errors.ts";

const CHECKOUT: GitObservationCheckout = Object.freeze({
  repository: Object.freeze({
    name: "project",
    locatorFingerprint: "a".repeat(64),
    requestedBase: null,
    creationCommit: "b".repeat(40),
    primaryBranch: "main",
    objectFormat: "sha1" as const,
  }),
  root: "/checkouts/project",
  commonDirectory: "/checkouts/project/.git",
});

const FILES_REQUEST: GitFilesRequest = Object.freeze({
  kind: "files",
  prefix: "src/",
  limit: 100,
  cursor: null,
});

function filesCursor(overrides: Partial<Record<string, Json>> = {}): string {
  const base = {
    version: 1 as const,
    kind: "files" as const,
    query: gitObservationQuery(FILES_REQUEST, null),
    checkout: CHECKOUT,
    comparison: null,
    observation: "c".repeat(64),
    position: 3,
  };
  return encodeGitObservationCursor({ ...base, ...overrides });
}

describe("GOR1 — windows count code points", () => {
  it("never cuts a surrogate pair, and reports the whole length", function* () {
    const astral = "\u{1D11E}";
    const text = `ab${astral}cd`;
    expect(codePointLength(text)).toBe(5);
    expect(text.length).toBe(6);

    const first = gitTextWindow(text, 0, 3);
    expect(first.text).toBe(`ab${astral}`);
    expect(first.length).toBe(5);
    expect(first.nextOffset).toBe(3);

    const second = gitTextWindow(text, 3, 3);
    expect(second.text).toBe("cd");
    expect(second.nextOffset).toBe(null);
  });

  it("answers an empty window at or past the end, with the whole length", function* () {
    const text = "abcd";
    for (const offset of [4, 5, 4096]) {
      const window = gitTextWindow(text, offset, 10);
      expect(`${offset}: ${window.text}|${window.length}|${window.nextOffset}`).toBe(
        `${offset}: |4|null`,
      );
    }
    const empty = gitTextWindow("", 0, 10);
    expect(`${empty.text}|${empty.length}|${empty.nextOffset}`).toBe("|0|null");
  });

  it("does not overflow a safe-integer limit added to an offset", function* () {
    const window = gitTextWindow("abcd", 1, Number.MAX_SAFE_INTEGER);
    expect(window.text).toBe("bcd");
    expect(window.nextOffset).toBe(null);
  });

  it("pages records by index, with no omission or duplication", function* () {
    const records = ["a", "b", "c", "d", "e"];
    const first = gitRecordWindow(records, 0, 2);
    const second = gitRecordWindow(records, first.nextIndex ?? 0, 2);
    const third = gitRecordWindow(records, second.nextIndex ?? 0, 2);
    expect([...first.page, ...second.page, ...third.page]).toEqual(records);
    expect(third.nextIndex).toBe(null);
    expect(gitRecordWindow(records, 5, 2).page).toEqual([]);
  });
});

describe("GOR2 — filters are literal and ordering is by code point", () => {
  it("matches a path, its descendants and a trailing-slash selector", function* () {
    expect(selectsPath("src", "src")).toBe(true);
    expect(selectsPath("src", "src/a.ts")).toBe(true);
    expect(selectsPath("src", "srcfile.ts")).toBe(false);
    expect(selectsPath("src/", "src")).toBe(false);
    expect(selectsPath("src/", "src/a.ts")).toBe(true);
    // The characters a glob would expand are those characters.
    expect(selectsPath("a*b", "a*b")).toBe(true);
    expect(selectsPath("a*b", "axb")).toBe(false);
  });

  it("matches a rename on either of its paths", function* () {
    const renamed = { path: "new.md", status: "R" as const, previousPath: "old.md" };
    expect(selectedChange(["old.md"], renamed)).toBe(true);
    expect(selectedChange(["new.md"], renamed)).toBe(true);
    expect(selectedChange(["other.md"], renamed)).toBe(false);
    // Omission selects everything; an empty selector selects nothing.
    expect(selectedChange(null, renamed)).toBe(true);
    expect(selectedChange([], renamed)).toBe(false);
  });

  it("orders by current path, then previous path", function* () {
    expect(
      sortedChanges([
        { path: "b", status: "M", previousPath: null },
        { path: "a", status: "R", previousPath: "z" },
        { path: "a", status: "R", previousPath: "y" },
      ]),
    ).toEqual([
      { path: "a", status: "R", previousPath: "y" },
      { path: "a", status: "R", previousPath: "z" },
      { path: "b", status: "M", previousPath: null },
    ]);
  });
});

describe("GOR3 — admission happens before any provider", () => {
  it("fills the defaults and keeps every spelling", function* () {
    expect(admitFilesRequest("<Git.Files>", {})).toEqual({
      kind: "files",
      prefix: null,
      limit: DEFAULT_RECORD_LIMIT,
      cursor: null,
    });
    expect(admitDiffRequest("<Git.Diff>", { compare: "staged" })).toEqual({
      kind: "diff",
      comparison: { compare: "staged" },
      paths: null,
      offset: 0,
      limit: DEFAULT_TEXT_LIMIT,
      cursor: null,
    });
    // A filename holding a space, a tab, a newline and a non-ASCII character
    // arrives untrimmed and unnormalized.
    const awkward = "uni/é a\tb\nc.md";
    expect(admitFileRequest("<Git.File>", { commit: "HEAD", path: awkward }).path).toBe(awkward);
    // An empty prefix is the whole repository, which is what omission means.
    expect(admitFilesRequest("<Git.Files>", { prefix: "" }).prefix).toBe(null);
    // A prefix may stop inside its final segment.
    expect(admitFilesRequest("<Git.Files>", { prefix: "packages/co" }).prefix).toBe("packages/co");
  });

  it("refuses a limit, an offset, a path and a comparison it cannot honor", function* () {
    const refusals: [string, () => unknown][] = [
      ["zero limit", () => admitFilesRequest("<Git.Files>", { limit: 0 })],
      ["fractional limit", () => admitFilesRequest("<Git.Files>", { limit: 1.5 })],
      ["unsafe limit", () => admitFilesRequest("<Git.Files>", { limit: 2 ** 53 })],
      ["negative offset", () => admitDiffRequest("<Git.Diff>", { compare: "staged", offset: -1 })],
      [
        "absolute path",
        () => admitFileRequest("<Git.File>", { commit: "HEAD", path: "/etc/passwd" }),
      ],
      ["parent segment", () => admitFileRequest("<Git.File>", { commit: "HEAD", path: "a/../b" })],
      [
        "empty filter entry",
        () => admitChangesRequest("<Git.Changes>", { compare: "staged", paths: [""] }),
      ],
      [
        "revisions on a live comparison",
        () => admitChangesRequest("<Git.Changes>", { compare: "staged", base: "HEAD" }),
      ],
      [
        "a commit comparison missing head",
        () => admitChangesRequest("<Git.Changes>", { compare: "commits", base: "HEAD" }),
      ],
      ["an unknown comparison", () => admitDiffRequest("<Git.Diff>", { compare: "merge-base" })],
    ];
    for (const [named, attempt] of refusals) {
      let refused: unknown;
      try {
        attempt();
      } catch (error) {
        refused = error;
      }
      expect(`${named}: ${refused instanceof GitObservationError}`).toBe(`${named}: true`);
      expect(`${named}: ${refused instanceof GitObservationError ? refused.reason : "none"}`).toBe(
        `${named}: invalid-invocation`,
      );
    }
  });

  it("honors a limit far above the superseded proposed cap", function* () {
    expect(admitDiffRequest("<Git.Diff>", { compare: "staged", limit: 1_000_000 }).limit).toBe(
      1_000_000,
    );
    expect(admitFilesRequest("<Git.Files>", { limit: 1002 }).limit).toBe(1002);
  });
});

describe("GOR4 — the cursor is data, bound to one observation", () => {
  it("round-trips, and holds no path the caller could use as a destination", function* () {
    const encoded = filesCursor();
    const parsed = parseGitObservationCursor(encoded);
    expect(parsed?.kind).toBe("files");
    expect(parsed?.position).toBe(3);
    expect(parsed?.comparison).toBe(null);
    expect(sameObservationCheckout(parsed?.checkout ?? CHECKOUT, CHECKOUT)).toBe(true);
    // Opaque: nothing about the encoding is a promise, and the decoded payload
    // holds the checkout the first page was authenticated against and nothing
    // a later call could be redirected by.
    expect(Object.keys(parsed ?? {}).sort()).toEqual([
      "checkout",
      "comparison",
      "kind",
      "observation",
      "position",
      "query",
      "version",
    ]);
  });

  it("refuses a malformed string, a wrong version and an unknown kind", function* () {
    expect(parseGitObservationCursor("not base64url!!")).toBe(undefined);
    expect(parseGitObservationCursor(btoa("{}"))).toBe(undefined);
    expect(parseGitObservationCursor(btoa('{"version":2}'))).toBe(undefined);
    expect(parseGitObservationCursor(filesCursor({ version: 2 }))).toBe(undefined);
    expect(parseGitObservationCursor(filesCursor({ kind: "file" }))).toBe(undefined);
    expect(parseGitObservationCursor(filesCursor({ observation: "short" }))).toBe(undefined);
    expect(parseGitObservationCursor(filesCursor({ position: -1 }))).toBe(undefined);
  });

  it("names a different checkout, query and position when any of them differs", function* () {
    const elsewhere: GitObservationCheckout = { ...CHECKOUT, root: "/checkouts/other" };
    expect(sameObservationCheckout(CHECKOUT, elsewhere)).toBe(false);
    expect(
      sameObservationCheckout(CHECKOUT, {
        ...CHECKOUT,
        repository: { ...CHECKOUT.repository, name: "renamed" },
      }),
    ).toBe(false);

    // A query excludes the limit, so raising it is not a different observation.
    const wider: GitFilesRequest = { ...FILES_REQUEST, limit: 500 };
    expect(yield* observationDigest(gitObservationQuery(wider, null))).toBe(
      yield* observationDigest(gitObservationQuery(FILES_REQUEST, null)),
    );
    // The prefix is part of it, so changing that is.
    const narrower: GitFilesRequest = { ...FILES_REQUEST, prefix: "src/a" };
    expect(yield* observationDigest(gitObservationQuery(narrower, null))).not.toBe(
      yield* observationDigest(gitObservationQuery(FILES_REQUEST, null)),
    );
  });

  it("uses the resolved commit ids for a commit comparison's query", function* () {
    const authored: GitChangesRequest = {
      kind: "changes",
      comparison: { compare: "commits", base: "main", head: "HEAD" },
      paths: null,
      limit: 100,
      cursor: null,
    };
    const resolved: GitChangesRequest = {
      kind: "changes",
      comparison: { compare: "commits", base: "d".repeat(40), head: "e".repeat(40) },
      paths: null,
      limit: 100,
      cursor: null,
    };
    const comparison = {
      compare: "commits" as const,
      base: "d".repeat(40),
      head: "e".repeat(40),
    };
    // The follow-up calls with the ids the first page's `next` carried, and the
    // query it computes is the query the first page recorded — which is what
    // stops a branch that moved from retargeting a later page.
    expect(yield* observationDigest(gitObservationQuery(authored, comparison))).toBe(
      yield* observationDigest(gitObservationQuery(resolved, comparison)),
    );
  });
});

describe("GOR5 — a result is written and parsed by one contract", () => {
  it("round-trips all four results, including their next arguments", function* () {
    const files = {
      paths: ["a.ts", "b.ts"],
      next: { prefix: "src/", limit: 100, cursor: "x" },
    };
    expect(parseGitObservationValue(gitFilesResultJson(files), FILES_REQUEST)).toEqual(files);

    const changesRequest: GitChangesRequest = {
      kind: "changes",
      comparison: { compare: "unstaged" },
      paths: ["src/"],
      limit: 100,
      cursor: null,
    };
    const changes = {
      comparison: { compare: "unstaged" as const },
      changes: [{ path: "a.ts", status: "R" as const, previousPath: "b.ts" }],
      next: { compare: "unstaged" as const, paths: ["src/"], limit: 100, cursor: "x" },
    };
    expect(parseGitObservationValue(gitChangesResultJson(changes), changesRequest)).toEqual(
      changes,
    );

    const diffRequest: GitDiffRequest = {
      kind: "diff",
      comparison: { compare: "commits", base: "d".repeat(40), head: "e".repeat(40) },
      paths: null,
      offset: 0,
      limit: 4096,
      cursor: null,
    };
    const diff = {
      comparison: {
        compare: "commits" as const,
        base: "d".repeat(40),
        head: "e".repeat(40),
      },
      text: "patch",
      offset: 0,
      length: 12,
      next: {
        compare: "commits" as const,
        base: "d".repeat(40),
        head: "e".repeat(40),
        offset: 5,
        limit: 4096,
        cursor: "x",
      },
    };
    expect(parseGitObservationValue(gitDiffResultJson(diff), diffRequest)).toEqual(diff);

    const fileRequest: GitFileRequest = {
      kind: "file",
      commit: "HEAD~1",
      path: "a.ts",
      offset: 0,
      limit: 4096,
    };
    const file = {
      commit: "f".repeat(40),
      path: "a.ts",
      text: "source",
      offset: 0,
      length: 20,
      next: { commit: "f".repeat(40), path: "a.ts", offset: 6, limit: 4096 },
    };
    expect(parseGitObservationValue(gitFileResultJson(file), fileRequest)).toEqual(file);
  });

  it("refuses a page that describes another request", function* () {
    const wrong: [string, Json, GitObservationRequest][] = [
      [
        "a page longer than the limit",
        { paths: ["a", "b", "c"], next: null },
        { ...FILES_REQUEST, limit: 2 },
      ],
      [
        "a next naming another prefix",
        { paths: [], next: { prefix: "doc/", limit: 100, cursor: "x" } },
        FILES_REQUEST,
      ],
      [
        "a rename status with no previous path",
        {
          comparison: { compare: "unstaged" },
          changes: [{ path: "a", status: "R", previousPath: null }],
          next: null,
        },
        {
          kind: "changes",
          comparison: { compare: "unstaged" },
          paths: null,
          limit: 100,
          cursor: null,
        },
      ],
      [
        "a previous path on a status that is not a rename",
        {
          comparison: { compare: "unstaged" },
          changes: [{ path: "a", status: "M", previousPath: "b" }],
          next: null,
        },
        {
          kind: "changes",
          comparison: { compare: "unstaged" },
          paths: null,
          limit: 100,
          cursor: null,
        },
      ],
      [
        "a comparison the request did not ask for",
        { comparison: { compare: "staged", base: null }, changes: [], next: null },
        {
          kind: "changes",
          comparison: { compare: "unstaged" },
          paths: null,
          limit: 100,
          cursor: null,
        },
      ],
      [
        "a file continuation on another commit",
        {
          commit: "f".repeat(40),
          path: "a.ts",
          text: "x",
          offset: 0,
          length: 2,
          next: { commit: "0".repeat(40), path: "a.ts", offset: 1, limit: 10 },
        },
        { kind: "file", commit: "HEAD", path: "a.ts", offset: 0, limit: 10 },
      ],
      [
        "an offset the request did not ask for",
        {
          commit: "f".repeat(40),
          path: "a.ts",
          text: "x",
          offset: 7,
          length: 2,
          next: null,
        },
        { kind: "file", commit: "HEAD", path: "a.ts", offset: 0, limit: 10 },
      ],
    ];
    for (const [named, payload, request] of wrong) {
      expect(`${named}: ${parseGitObservationValue(payload, request) === undefined}`).toBe(
        `${named}: true`,
      );
    }
  });
});
