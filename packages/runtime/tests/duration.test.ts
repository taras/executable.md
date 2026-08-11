/**
 * Tier DU — the duration grammar (spec §Config).
 *
 * One parser serves the three command-line options and the `timeout=` a block
 * declares, so a duration means the same thing wherever it is written. What it
 * refuses matters as much as what it accepts: a run bounded by a number nobody
 * wrote is the failure this grammar exists to prevent.
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { asDuration, parseDuration } from "../duration.ts";

const ACCEPTED: [string, number][] = [
  ["500ms", 500],
  ["30s", 30_000],
  ["5min", 300_000],
  ["20min", 1_200_000],
  ["1ms", 1],
  ["2m", 120_000],
  ["500", 500],
  [" 30s ", 30_000],
];

const REJECTED = [
  "",
  "   ",
  "0",
  "0s",
  "0ms",
  "-1",
  "-5s",
  "1e3",
  "0x10",
  ".5",
  "+1",
  "1.5s",
  "Infinity",
  "NaN",
  "abc",
  "5x",
  "30 s",
  "s30",
  "30sec",
];

describe("Tier DU — duration grammar", () => {
  it("DU1: a whole number with a unit is milliseconds", function* () {
    for (const [text, expected] of ACCEPTED) {
      expect({ text, ms: asDuration(text) }).toEqual({ text, ms: expected });
    }
  });

  it("DU2: empty, zero, negative, non-finite, and malformed values are not durations", function* () {
    for (const text of REJECTED) {
      expect({ text, ms: asDuration(text) }).toEqual({ text, ms: undefined });
    }
  });

  it("DU3: parseDuration throws for a rejected value, naming where it was written", function* () {
    let message = "";
    try {
      parseDuration("30 seconds", "--timeout-exec");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("--timeout-exec");
    expect(message).toContain("must be a duration");
    expect(message).toContain('"30 seconds"');
  });

  it("DU4: parseDuration returns the same milliseconds asDuration does", function* () {
    for (const [text, expected] of ACCEPTED) {
      expect(parseDuration(text, "timeout")).toBe(expected);
    }
  });
});
