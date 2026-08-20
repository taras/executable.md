/**
 * Tier WI — what a retained issue record is, and what names it.
 *
 * D1 lives here rather than in a scenario document, and the reason is worth
 * stating: the claim is that a *changed request* cannot consume the result
 * retained for a different one, and that cannot be staged by running an edited
 * document against a retained journal. An edited root is a fork (§11), and a
 * fork replays the retained expansion positionally rather than re-reading what
 * the new document says — so a scenario written that way reports the first
 * attempt's URL and passes while proving the opposite.
 *
 * What actually decides it is the durable name, which is a function of the
 * request. So the request is varied one member at a time, here, where every
 * member can be named.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import {
  issueIdempotencyKey,
  issueRequestFingerprint,
  issueRequestJson,
  normalizedTags,
  parseIssueInput,
  parseIssueRecord,
  parseIssueRequest,
  sameIssueRequest,
  type IssueRequest,
} from "../src/issue/records.ts";
import type { IssueInput } from "../src/issue/api.ts";

const TARGET = "https://github.com/octo/project";

const IDENTITY = Object.freeze({ runId: "run-296", expansionId: "expansion-1" });

const ISSUE: IssueInput = Object.freeze({
  title: "Retry the publish step on a 5xx",
  description: "The publish step failed twice in a row on 503.",
  tags: Object.freeze(["publish", "reliability"]),
  assignee: null,
});

const REQUEST: IssueRequest = Object.freeze({
  identity: IDENTITY,
  target: TARGET,
  provider: null,
  issue: ISSUE,
});

/** The same request with one tag set, whatever order it was authored in. */
function withTags(tags: readonly string[] | undefined): IssueRequest {
  if (tags === undefined) {
    throw new Error("the fixture authored a tag list that is not a tag set");
  }
  return { ...REQUEST, issue: { ...ISSUE, tags } };
}

describe("workflow Issue durable identity", () => {
  it("keys an attempt by its destination and its position, not by its text", function* () {
    const key = issueIdempotencyKey(IDENTITY, TARGET);
    expect(issueIdempotencyKey(IDENTITY, TARGET)).toBe(key);
    // Title is never identity: a document that edits its own title between
    // attempts is still asking about the issue its position already created.
    expect(issueIdempotencyKey({ ...IDENTITY, expansionId: "expansion-2" }, TARGET)).not.toBe(key);
    expect(issueIdempotencyKey({ ...IDENTITY, runId: "other" }, TARGET)).not.toBe(key);
    expect(issueIdempotencyKey(IDENTITY, "https://github.com/octo/other")).not.toBe(key);
  });

  it("names a different durable operation for every member of the request", function* () {
    const variants: IssueRequest[] = [
      REQUEST,
      { ...REQUEST, provider: "github" },
      { ...REQUEST, target: "https://github.com/octo/other" },
      { ...REQUEST, identity: { ...IDENTITY, runId: "other" } },
      { ...REQUEST, identity: { ...IDENTITY, expansionId: "expansion-2" } },
      { ...REQUEST, issue: { ...ISSUE, title: "Other" } },
      { ...REQUEST, issue: { ...ISSUE, description: "Other" } },
      { ...REQUEST, issue: { ...ISSUE, tags: ["urgent"] } },
      { ...REQUEST, issue: { ...ISSUE, assignee: "octocat" } },
    ];
    const names: string[] = [];
    for (const variant of variants) {
      names.push(yield* issueRequestFingerprint(variant));
    }
    expect(new Set(names).size).toBe(variants.length);
  });

  it("gives two authored tag orders one name", function* () {
    // The discriminating pair: two *different* authored lists that normalize to
    // one set. Comparing a normalized request with itself would pass whatever
    // the normalization did.
    const authored = ["reliability", "publish"];
    const reversed = ["publish", "reliability"];
    expect(authored).not.toEqual(reversed);

    const one = normalizedTags(authored);
    const other = normalizedTags(reversed);
    expect(one).toEqual(other);
    expect(yield* issueRequestFingerprint(withTags(one))).toBe(
      yield* issueRequestFingerprint(withTags(other)),
    );

    // And a genuinely different set is a different name.
    expect(yield* issueRequestFingerprint(withTags(normalizedTags(["publish"])))).not.toBe(
      yield* issueRequestFingerprint(withTags(one)),
    );
  });

  it("reads a retained request back as the request it was", function* () {
    const round = parseIssueRequest(issueRequestJson(REQUEST));
    expect(round).toEqual(REQUEST);
    expect(round === undefined ? false : sameIssueRequest(round, REQUEST)).toBe(true);

    // A retained request whose tags are out of order is not one this boundary
    // wrote, and reading it as though it were would let two spellings of one
    // request answer for each other.
    expect(
      parseIssueRequest({
        ...Object(issueRequestJson(REQUEST)),
        issue: { ...ISSUE, tags: ["reliability", "publish"] },
      }),
    ).toBeUndefined();
  });

  it("retains only what the boundary wrote", function* () {
    expect(parseIssueRecord({ url: "https://example.test/issues/1" })).toEqual({
      url: "https://example.test/issues/1",
    });
    // A provider that answered with more than a URL answered with something
    // this boundary will not retain.
    expect(parseIssueRecord({ url: "https://example.test/issues/1", id: "I_1" })).toBeUndefined();
    expect(parseIssueRecord({ url: "" })).toBeUndefined();
    expect(parseIssueRecord({})).toBeUndefined();

    expect(parseIssueInput({ ...ISSUE, tags: [...ISSUE.tags] })).toEqual(ISSUE);
    expect(parseIssueInput({ ...ISSUE, tags: ["reliability", "publish"] })).toBeUndefined();
  });
});
