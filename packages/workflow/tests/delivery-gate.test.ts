/**
 * Tier WAD — one credential gate, at both boundaries that write a value.
 *
 * A delivered answer becomes retained state and then a journal event, and the
 * settled contract is that it crosses the same gate durable journal persistence
 * crosses before either exists. There are two places that write it — the local
 * host's own delivery and a run's owner — and the risk this suite exists for is
 * that they drift apart: one of them summarizing the gate, or the configuration
 * changing under one and not the other.
 *
 * So this runs the scanner the journal is written through and the gate the
 * owner applies over the same content and requires the same verdict. It is not
 * a test of what the rules match; `packages/core` owns that. It is a test that
 * there is one gate.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import type { Operation } from "effection";
import { createSecretScanner } from "@executablemd/core/secrets";
import { crossSecretGate } from "../src/cloudflare/owner-gate.ts";
import { CommandError } from "../src/cloudflare/commands.ts";

/**
 * A safe canary the repository's own credential rule matches.
 *
 * Not an issued token and not a real secret: a credential-named field carrying
 * an opaque-looking value. It is here because it is exactly the shape a weaker
 * detector lets through, so it is what a split gate would disagree about.
 */
const SAFE_CANARY = '{"password":"example-Purple7Elephant"}';

/** An issued token, assembled at run time so no literal is committed. */
const ISSUED = `{"note":"ghp_${"abcdefghijklmnopqrstuvwxyz0123456789".slice(0, 36)}"}`;

/** Whether the scanner the journal is written through refuses this content. */
function* scanned(content: string): Operation<boolean> {
  return (yield* createSecretScanner().scan(content)).length > 0;
}

/** Whether the gate a run's owner applies refuses this content. */
function* gated(content: string): Operation<boolean> {
  try {
    yield* crossSecretGate([content]);
    return false;
  } catch (error) {
    if (error instanceof CommandError && error.refusal === "credential-detected") {
      return true;
    }
    throw error;
  }
}

describe("the credential gate a delivered answer crosses", () => {
  it("reaches the same verdict at the owner as at the journal", function* () {
    const contents = [
      SAFE_CANARY,
      ISSUED,
      '{"approved":true}',
      '{"note":"shipped the release"}',
      '{"apiKey":"your-api-key-here"}',
      "",
    ];

    const verdicts: { content: string; journal: boolean; owner: boolean }[] = [];
    for (const content of contents) {
      verdicts.push({ content, journal: yield* scanned(content), owner: yield* gated(content) });
    }

    // One gate: every disagreement here is a value one boundary would write and
    // the other would refuse.
    expect(verdicts.filter((verdict) => verdict.journal !== verdict.owner)).toEqual([]);
    // And the safe canary is one the gate actually refuses, so the agreement
    // above is not two detectors both saying nothing.
    expect(verdicts.find((verdict) => verdict.content === SAFE_CANARY)?.owner).toBe(true);
    expect(verdicts.find((verdict) => verdict.content === ISSUED)?.owner).toBe(true);
    expect(verdicts.find((verdict) => verdict.content === '{"approved":true}')?.owner).toBe(false);
  });

  it("refuses every framing it is given, and reports no content", function* () {
    let refused: unknown;
    try {
      yield* crossSecretGate(['{"approved":true}', SAFE_CANARY]);
    } catch (error) {
      refused = error;
    }

    expect(refused instanceof CommandError).toBe(true);
    // The refusal is one category. Neither the value nor the match travels.
    expect(String(refused)).not.toContain("Purple7Elephant");
    expect(String(refused)).not.toContain("password");
  });
});
