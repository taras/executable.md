/**
 * Tier WRH — the run id one GitHub issue is addressed by.
 *
 * The derivation is the whole of "one issue, one run": every host that admits
 * the same issue has to arrive at the same 52 characters without asking anybody,
 * and no value that moves while the work is going on may take part. The fixed
 * vectors below were computed independently of this implementation, which is
 * what makes them evidence that a second implementation would agree rather than
 * a restatement of what this code happens to do.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import {
  admitFactoryRunSubject,
  deriveFactoryRunId,
  FactoryRunSubjectError,
} from "@executablemd/workflow/software-factory";
// The encoder is an internal algorithm rather than a public promise, so the
// RFC 4648 vectors below reach it directly. Everything else in this file goes
// through the published product API, which is what a host actually holds.
import { base32Unpadded, factoryRunIdPreimage } from "../src/software-factory/run-id.ts";

/** An opaque node id of the shape GitHub's GraphQL API returns for an issue. */
const NODE = "I_kwDOABCD12M5abcdef";

/**
 * Computed outside this implementation, from the specified bytes.
 *
 * `sha256("github-issue-v1" || 0x00 || authority || 0x00 || nodeId)`, then
 * lowercase unpadded RFC 4648 Base32 over all 32 bytes.
 */
const VECTORS = [
  {
    authority: "github.com",
    issueNodeId: NODE,
    runId: "5cktgrv2zyutngh7bbddr2tyg2b5a567cg725hu5e7u42orerxaa",
  },
  {
    authority: "github.example.com:8443",
    issueNodeId: NODE,
    runId: "h7dgqsvqzv4p5k2hp2zebemci65qhinpdkxwk5d4caglndiw2xya",
  },
  {
    authority: "github.com",
    issueNodeId: "I_kwDOABCD12M5abcdeg",
    runId: "unydmnzwowpjcoua2tyza2topyivbbnm65ddklfjgs5yvlqiwqvq",
  },
] as const;

/** The canonical authority a subject is admitted under, through the public seam. */
function authorityOf(value: string): string {
  return admitFactoryRunSubject({ authority: value, issueNodeId: NODE }).authority;
}

function reason(body: () => unknown): string {
  try {
    body();
  } catch (error) {
    if (error instanceof FactoryRunSubjectError) {
      return error.reason;
    }
    throw error;
  }
  throw new Error("expected a FactoryRunSubjectError");
}

describe("the factory run id", () => {
  it("derives the specified bytes for known subjects", function* () {
    for (const vector of VECTORS) {
      const runId = yield* deriveFactoryRunId({
        authority: vector.authority,
        issueNodeId: vector.issueNodeId,
      });
      expect(runId).toEqual(vector.runId);
      expect(runId.length).toEqual(52);
      expect(/^[a-z2-7]{52}$/.test(runId)).toEqual(true);
    }
  });

  it("derives the same id twice for one subject", function* () {
    const once = yield* deriveFactoryRunId({ authority: "github.com", issueNodeId: NODE });
    const again = yield* deriveFactoryRunId({ authority: "GITHUB.COM", issueNodeId: NODE });
    expect(again).toEqual(once);
  });

  it("separates the authority from the node id", function* () {
    // Without the NUL separators these two subjects would share a preimage.
    const left = yield* deriveFactoryRunId({ authority: "github.com", issueNodeId: "ab" });
    const right = yield* deriveFactoryRunId({ authority: "github.co", issueNodeId: "mab" });
    expect(left).not.toEqual(right);
  });

  it("writes the scheme tag, both separators and both inputs", function* () {
    const bytes = new Uint8Array(
      factoryRunIdPreimage({ authority: "github.com", issueNodeId: "x" }),
    );
    expect(new TextDecoder().decode(bytes)).toEqual("github-issue-v1\0github.com\0x");
    expect([...bytes].filter((byte) => byte === 0).length).toEqual(2);
  });

  it("folds case and keeps a non-default port", function* () {
    expect(authorityOf("GitHub.Com")).toEqual("github.com");
    expect(authorityOf("GitHub.Example.COM:8443")).toEqual("github.example.com:8443");
  });

  it("refuses every part an authority may not carry", function* () {
    expect(reason(() => authorityOf(""))).toEqual("authority-empty");
    expect(reason(() => authorityOf("https://github.com"))).toEqual("authority-has-scheme");
    expect(reason(() => authorityOf("user@github.com"))).toEqual("authority-has-userinfo");
    expect(reason(() => authorityOf("github.com/octo"))).toEqual("authority-has-path");
    expect(reason(() => authorityOf("github.com/"))).toEqual("authority-has-path");
    expect(reason(() => authorityOf("github.com?a=b"))).toEqual("authority-has-query");
    expect(reason(() => authorityOf("github.com#top"))).toEqual("authority-has-fragment");
    expect(reason(() => authorityOf("git hub.com"))).toEqual("authority-has-whitespace");
    expect(reason(() => authorityOf("-github.com"))).toEqual("authority-malformed-host");
    expect(reason(() => authorityOf("github.com:https"))).toEqual("authority-malformed-port");
    expect(reason(() => authorityOf("github.com:0"))).toEqual("authority-malformed-port");
    expect(reason(() => authorityOf("github.com:70000"))).toEqual("authority-malformed-port");
  });

  it("refuses a default port written out, so one deployment has one spelling", function* () {
    expect(reason(() => authorityOf("github.com:443"))).toEqual("authority-default-port");
  });

  it("compares a node id byte for byte", function* () {
    const subject = admitFactoryRunSubject({ authority: "github.com", issueNodeId: "Ab_C" });
    expect(subject.issueNodeId).toEqual("Ab_C");
    expect(
      reason(() => admitFactoryRunSubject({ authority: "github.com", issueNodeId: "" })),
    ).toEqual("node-id-empty");
    expect(
      reason(() => admitFactoryRunSubject({ authority: "github.com", issueNodeId: "a\0b" })),
    ).toEqual("node-id-has-nul");
  });

  it("encodes Base32 to the RFC 4648 alphabet without padding", function* () {
    // RFC 4648 §10 test vectors, lowercased and unpadded.
    const encode = (text: string) => base32Unpadded(new TextEncoder().encode(text));
    expect(encode("")).toEqual("");
    expect(encode("f")).toEqual("my");
    expect(encode("fo")).toEqual("mzxq");
    expect(encode("foo")).toEqual("mzxw6");
    expect(encode("foob")).toEqual("mzxw6yq");
    expect(encode("fooba")).toEqual("mzxw6ytb");
    expect(encode("foobar")).toEqual("mzxw6ytboi");
  });
});
