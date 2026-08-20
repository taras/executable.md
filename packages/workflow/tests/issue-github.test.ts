/**
 * Tier U — what a document cannot construct.
 *
 * The `<Issue>` contract is stated by `tests/scenarios/*.test.md`, and nothing
 * here repeats one of those scenarios. What is left is the reading a scenario
 * cannot reach: which targets the GitHub adapter recognizes and can act on, how
 * it reads a payload, how a tracker URL canonicalizes, and the durable identity
 * a request is named by.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { Ok, type Operation } from "effection";
import {
  issueBodyFor,
  issueOriginMarker,
  openSnapshot,
  parseGitHubIssueTarget,
  readGitHubIssue,
  recognizesGitHubUrl,
} from "../src/deno/issue/github.ts";
import {
  canonicalIssueTarget,
  issueProviderName,
  withinIssueCeiling,
} from "../src/issue/tracker.ts";
import { issueIdempotencyKey, normalizedTags } from "../src/issue/records.ts";
import type { IssueInput } from "../src/issue/api.ts";
import type { StoredIssue } from "./support/github.ts";

const TARGET = "https://github.com/octo/project";

const IDENTITY = Object.freeze({ runId: "run-296", expansionId: "expansion-1" });

const ISSUE: IssueInput = Object.freeze({
  title: "Retry the publish step on a 5xx",
  description: "The publish step failed twice in a row on 503.",
  tags: Object.freeze(["publish", "reliability"]),
  assignee: null,
});

const MARKER = issueOriginMarker(issueIdempotencyKey(IDENTITY, TARGET));

const PAYLOAD = {
  node_id: "I_node_1",
  number: 1,
  html_url: "https://github.com/octo/project/issues/1",
  state: "open",
  title: ISSUE.title,
  body: issueBodyFor(ISSUE, MARKER),
  repository_url: "https://api.github.test/repos/octo/project",
  labels: [{ name: "reliability" }, { name: "publish" }],
  assignees: [{ login: "octocat" }],
};

describe("workflow Issue tracker canonicalization", () => {
  it("gives one container one spelling", function* () {
    expect(canonicalIssueTarget("https://github.com/octo/project/")).toBe(TARGET);
    expect(canonicalIssueTarget("HTTPS://GitHub.com/octo/project")).toBe(TARGET);
    expect(canonicalIssueTarget("https://acme.atlassian.net/browse/PROJ/")).toBe(
      "https://acme.atlassian.net/browse/PROJ",
    );
  });

  it("refuses every URL that is not the plain name of a container", function* () {
    for (const value of [
      "",
      "not a url",
      "github.com/octo/project",
      "ftp://github.com/octo/project",
      "file:///srv/issues",
      `https://${"token"}@github.com/octo/project`,
      "https://github.com/octo/project?tab=issues",
      "https://github.com/octo/project#new",
    ]) {
      expect(canonicalIssueTarget(value)).toBeUndefined();
    }
  });

  it("reads a provider discriminator as a stable lower-case name", function* () {
    expect(issueProviderName("github")).toBe("github");
    expect(issueProviderName("self-hosted-2")).toBe("self-hosted-2");
    for (const value of ["", "GitHub", "1provider", "with space", 7, null]) {
      expect(issueProviderName(value)).toBeUndefined();
    }
  });

  it("narrows a ceiling by whole path segments", function* () {
    expect(withinIssueCeiling([TARGET], TARGET)).toBe(true);
    expect(withinIssueCeiling([TARGET], `${TARGET}/issues`)).toBe(true);
    expect(withinIssueCeiling([TARGET], "https://github.com/octo/project-two")).toBe(false);
    expect(withinIssueCeiling([TARGET], "https://github.com/other/project")).toBe(false);
    expect(withinIssueCeiling([], TARGET)).toBe(false);
  });
});

describe("workflow GitHub issue targets", () => {
  it("recognizes the public service, and only it", function* () {
    expect(recognizesGitHubUrl(TARGET)).toBe(true);
    expect(recognizesGitHubUrl(`${TARGET}/issues`)).toBe(true);
    // A host that merely contains the name is not that host.
    expect(recognizesGitHubUrl("https://github.com.example.invalid/octo/project")).toBe(false);
    expect(recognizesGitHubUrl("https://git.example.invalid/octo/project")).toBe(false);
  });

  it("acts on the path shape, so a named self-hosted target is reachable", function* () {
    expect(parseGitHubIssueTarget(TARGET)).toEqual({ owner: "octo", repository: "project" });
    expect(parseGitHubIssueTarget(`${TARGET}/issues`)).toEqual({
      owner: "octo",
      repository: "project",
    });
    // Which is what an explicit discriminator exists for: the host is not part
    // of what this adapter can act on, only of what it recognizes unasked.
    expect(parseGitHubIssueTarget("https://git.example.invalid/octo/project")).toEqual({
      owner: "octo",
      repository: "project",
    });
    for (const value of [
      "https://github.com/octo",
      "https://github.com/octo/project/pulls",
      "https://github.com/octo/project/issues/1",
      "http://github.com/octo/project",
    ]) {
      expect(parseGitHubIssueTarget(value)).toBeUndefined();
    }
  });
});

describe("workflow Issue tag normalization", () => {
  it("is a set, ordered by code point", function* () {
    expect(normalizedTags(["b", "a", "b"])).toEqual(["a", "b"]);
    expect(normalizedTags(undefined)).toEqual([]);
    expect(normalizedTags([])).toEqual([]);
    // Code point rather than UTF-16 code unit: a supplementary character sorts
    // after every character in the private-use area, which the default
    // comparison gets the other way round.
    expect(normalizedTags(["\u{10000}", "\uE000"])).toEqual(["\uE000", "\u{10000}"]);
  });

  it("names no tag set for a value that is not one", function* () {
    for (const value of ["a", 1, {}, ["a", ""], ["a", 1], [null]]) {
      expect(normalizedTags(value)).toBeUndefined();
    }
  });
});

describe("workflow GitHub issue payloads", () => {
  it("reads the facts an issue answer has to carry, and normalizes them", function* () {
    expect(readGitHubIssue(PAYLOAD)).toEqual({
      state: "open",
      providerId: "I_node_1",
      number: 1,
      url: "https://github.com/octo/project/issues/1",
      title: ISSUE.title,
      body: issueBodyFor(ISSUE, MARKER),
      tags: ["publish", "reliability"],
      assignee: "octocat",
      repository: "https://api.github.test/repos/octo/project",
      pullRequest: false,
    });
    expect(readGitHubIssue({ ...PAYLOAD, body: null })?.body).toBe("");
    expect(readGitHubIssue({ ...PAYLOAD, assignees: [] })?.assignee).toBeNull();
    expect(readGitHubIssue({ ...PAYLOAD, pull_request: { url: "…" } })?.pullRequest).toBe(true);
  });

  it("reads no issue out of an answer missing or contradicting one", function* () {
    for (const damage of [
      { node_id: "" },
      { number: 0 },
      { html_url: "" },
      { state: "merged" },
      { title: "" },
      { body: 1 },
      { repository_url: "" },
      { labels: "reliability" },
      { labels: [{ name: "" }] },
      { assignees: "octocat" },
      // Two assignees is a state this primitive cannot express, and reading the
      // first would report an issue as agreeing when it does not.
      { assignees: [{ login: "one" }, { login: "two" }] },
    ]) {
      expect(readGitHubIssue({ ...PAYLOAD, ...damage })).toBeUndefined();
    }
  });

  it("strips exactly the marker it wrote, and nothing a person typed", function* () {
    const reading = readGitHubIssue(PAYLOAD);
    const snapshot = reading === undefined ? undefined : openSnapshot(reading, MARKER);
    expect(snapshot?.description).toBe(ISSUE.description);

    // A body somebody edited no longer ends with it, which is not an error: the
    // description then differs from the request and the update path restores it.
    const edited = readGitHubIssue({ ...PAYLOAD, body: "somebody rewrote this" });
    const moved = edited === undefined ? undefined : openSnapshot(edited, MARKER);
    expect(moved?.description).toBe("somebody rewrote this");
  });
});

/** One issue a fixture holds, kept for the shape's sake. */
export type { StoredIssue };
