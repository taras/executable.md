/**
 * Tier WI — what a retained issue record is, and what names it.
 *
 * D1 lives here rather than in a scenario document, and the reason is that the
 * claim is compositional. "A changed request cannot consume the result retained
 * for a different one" is three facts stacked:
 *
 * 1. the request fingerprint covers every member of the request — the canonical
 *    target, the discriminator, the run, the expansion, and each of the four
 *    authored fields;
 * 2. the durable operation is *named* by that fingerprint
 *    (`upsertIssue()` in `src/issue/effect.ts`); and
 * 3. a durable stream diverges when the name at a position is not the name the
 *    history holds there, which is `@executablemd/durable-streams`' own
 *    contract rather than this package's.
 *
 * Only the first is this module's to prove, and it is what these tests vary one
 * member at a time. The second is one line at the call site and is read there.
 * The third belongs to the stream and is proven where the stream is.
 *
 * Staging the composition end to end would mean offering one journal to a
 * second execution whose request differs. That is worth having and is not what
 * the scenario documents do today: a scenario that swapped root documents
 * between attempts did not exercise the mismatch path in this suite's fixture,
 * so the claim is recorded as proven compositionally rather than end to end.
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
  type IssueUpsertRequest,
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

const URL = `${TARGET}/issues/7`;

const REQUEST: IssueUpsertRequest = Object.freeze({
  operation: "upsert",
  identity: IDENTITY,
  target: TARGET,
  provider: null,
  issue: ISSUE,
});

const READ: IssueRequest = Object.freeze({
  operation: "read",
  identity: IDENTITY,
  url: URL,
  provider: null,
});

/** The same request with one tag set, whatever order it was authored in. */
function withTags(tags: readonly string[] | undefined): IssueUpsertRequest {
  if (tags === undefined) {
    throw new Error("the fixture authored a tag list that is not a tag set");
  }
  return { ...REQUEST, issue: { ...ISSUE, tags } };
}

describe("workflow Issue durable identity", () => {
  it("keys an attempt by its destination and its position, not by its text", function* () {
    const key = issueIdempotencyKey(IDENTITY, "upsert", TARGET);
    expect(issueIdempotencyKey(IDENTITY, "upsert", TARGET)).toBe(key);
    // Title is never identity: a document that edits its own title between
    // attempts is still asking about the issue its position already created.
    expect(
      issueIdempotencyKey({ ...IDENTITY, expansionId: "expansion-2" }, "upsert", TARGET),
    ).not.toBe(key);
    expect(issueIdempotencyKey({ ...IDENTITY, runId: "other" }, "upsert", TARGET)).not.toBe(key);
    expect(issueIdempotencyKey(IDENTITY, "upsert", "https://github.com/octo/other")).not.toBe(key);
    // The operation is a member of the key, so a read taken at the position an
    // upsert also occupies cannot be answered with the upsert's mark.
    expect(issueIdempotencyKey(IDENTITY, "read", TARGET)).not.toBe(key);
  });

  it("names a different durable operation for every member of the request", function* () {
    const variants: IssueRequest[] = [
      REQUEST,
      READ,
      { ...READ, provider: "github" },
      { ...READ, url: `${TARGET}/issues/8` },
      { ...READ, identity: { ...IDENTITY, runId: "other" } },
      { ...READ, identity: { ...IDENTITY, expansionId: "expansion-2" } },
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
    for (const request of [REQUEST, READ]) {
      const round = parseIssueRequest(issueRequestJson(request));
      expect(round).toEqual(request);
      expect(round === undefined ? false : sameIssueRequest(round, request)).toBe(true);
    }

    // A read and an upsert are different questions, so one never reads back as
    // the other however much of the rest they share.
    expect(sameIssueRequest(REQUEST, { ...READ, url: TARGET })).toBe(false);

    // A retained request carrying the other operation's members is not one this
    // boundary wrote: an upsert's `issue` under a read's discriminator would
    // otherwise parse as a read that quietly dropped what it was asked to file.
    expect(parseIssueRequest({ ...Object(issueRequestJson(READ)), issue: ISSUE })).toBeUndefined();
    expect(
      parseIssueRequest({ ...Object(issueRequestJson(REQUEST)), operation: "read" }),
    ).toBeUndefined();

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
