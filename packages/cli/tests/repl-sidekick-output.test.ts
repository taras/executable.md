/**
 * Tier R4 — reading an entry's output, bounded and truthfully (#883, J7).
 *
 * A reply that submits an entry has to look at what it printed, and an entry
 * can print more than any turn should carry. So a read is a window, and what
 * comes back has to say exactly where that window sat — otherwise a reply
 * stitching two reads together is guessing, and a reply told "that's all of it"
 * when it is not will stop looking.
 *
 * The fixture is deliberately awkward in the two ways real output is: it is
 * long, and it is not ASCII. Ten thousand code points with astral characters
 * among them is what separates counting code points from counting UTF-16 units
 * — an emoji is one position here, so a window never ends halfway through a
 * character and two adjacent windows cannot disagree about where one stopped.
 * Literal fences are in there because output carrying a fence is what a reply
 * will quote back into feedback.
 *
 * Every row is pure. Nothing in this tier can start, resume or wait for work,
 * which is itself one of the assertions: a read is a read.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";

import { DEFAULT_LIMIT, initialRead, readEntryOutput } from "../src/repl/sidekick/output.ts";
import type { ObservedEntry, OutputRead, OutputReadRequest } from "../src/repl/sidekick/output.ts";

/** One astral character, which is two UTF-16 units and one code point. */
const ASTRAL = "\u{1F4D8}";

/**
 * Ten thousand code points, with astral characters and literal fences in them.
 *
 * Built so every position is identifiable: each block carries its own index, so
 * an assertion about a window is an assertion about *which* window, not merely
 * about its length.
 */
function longOutput(): string {
  const blocks: string[] = [];
  for (let index = 0; blocks.join("").length < 20000; index += 1) {
    blocks.push(`${index}:${ASTRAL}:\`\`\`xmd fence ${index}\`\`\`\n`);
  }
  return [...blocks.join("")].slice(0, 10000).join("");
}

const LONG = longOutput();
const POINTS = [...LONG];

function entry(
  id: string,
  output: string,
  status: ObservedEntry["status"] = "completed",
): ObservedEntry {
  return { id, output, status };
}

function read(request: OutputReadRequest, entries: readonly ObservedEntry[]): OutputRead {
  const answered = readEntryOutput(request, entries);
  if (!answered.ok) {
    throw answered.error;
  }
  return answered.value;
}

function refusal(request: OutputReadRequest, entries: readonly ObservedEntry[]): string {
  const answered = readEntryOutput(request, entries);
  if (answered.ok) {
    throw new Error("this read resolved rather than refusing");
  }
  return answered.error.message;
}

/** The window a read returned, as its code points. */
function window(held: OutputRead): string[] {
  return [...held.text];
}

describe("Tier R4 — the window, and where it sat", () => {
  const ENTRIES = [entry("entry-1", "earlier"), entry("entry-2", LONG)];

  it("R4a: the fixture is ten thousand code points, not ten thousand units", function* () {
    expect(POINTS).toHaveLength(10000);
    // The whole reason the distinction matters: more UTF-16 units than code
    // points, so anything counting units would cut a character in half.
    expect(LONG.length).toBeGreaterThan(10000);
    expect(LONG).toContain(ASTRAL);
    expect(LONG).toContain("```xmd");
  });

  it("R4b: a read with nothing stated is the tail of the latest entry", function* () {
    const held = read({}, ENTRIES);

    expect(held.entry).toBe("entry-2");
    expect(held.limit).toBe(DEFAULT_LIMIT);
    expect(held.length).toBe(10000);
    expect(held.offset).toBe(10000 - DEFAULT_LIMIT);
    expect(window(held)).toEqual(POINTS.slice(10000 - DEFAULT_LIMIT));
    // The tail is the end, so there is nothing after it and plenty before.
    expect(held.next).toBe(undefined);
    expect(held.previous).toEqual({
      entry: "entry-2",
      offset: 10000 - 2 * DEFAULT_LIMIT,
      limit: DEFAULT_LIMIT,
    });
  });

  it("R4c: a stated limit takes the whole output when it reaches past it", function* () {
    const held = read({ limit: 16384 }, ENTRIES);

    expect(held.limit).toBe(16384);
    // A tail longer than the output is the output, clamped at the beginning
    // rather than refused.
    expect(held.offset).toBe(0);
    expect(held.text).toBe(LONG);
    expect(held.previous).toBe(undefined);
    expect(held.next).toBe(undefined);
  });

  it("R4d: an explicit zero offset reads from the beginning", function* () {
    const held = read({ offset: 0, limit: 10 }, ENTRIES);

    expect(held.offset).toBe(0);
    expect(window(held)).toEqual(POINTS.slice(0, 10));
    expect(held.previous).toBe(undefined);
    expect(held.next).toEqual({ entry: "entry-2", offset: 10, limit: 10 });
  });

  it("R4e: a negative offset counts back from the end of what was observed", function* () {
    const held = read({ offset: -12, limit: 12 }, ENTRIES);

    expect(held.offset).toBe(9988);
    expect(window(held)).toEqual(POINTS.slice(9988));
  });

  it("R4f: an offset before the start clamps to the beginning", function* () {
    const held = read({ offset: -50000, limit: 5 }, ENTRIES);

    expect(held.offset).toBe(0);
    expect(window(held)).toEqual(POINTS.slice(0, 5));
  });

  it("R4g: a window beyond the end is empty, and says so", function* () {
    const held = read({ offset: 12000, limit: 100 }, ENTRIES);

    // Truthful rather than helpful: the range was asked for, the range is
    // empty, and the observed length says why.
    expect(held.offset).toBe(12000);
    expect(held.length).toBe(10000);
    expect(held.text).toBe("");
    expect(held.next).toBe(undefined);
    expect(held.previous).toEqual({ entry: "entry-2", offset: 11900, limit: 100 });
  });

  it("R4h: a negative entry index reads an earlier entry", function* () {
    const held = read({ entry: -2 }, ENTRIES);

    expect(held.entry).toBe("entry-1");
    expect(held.text).toBe("earlier");
    expect(held.length).toBe(7);
  });

  it("R4i: adjacent instructions stay pinned after a newer entry is admitted", function* () {
    const held = read({ offset: 0, limit: 10 }, ENTRIES);
    const next = held.next;
    if (next === undefined) {
      throw new Error("this window had more after it");
    }

    // A third entry arrives. The instruction names `entry-2` rather than "the
    // latest", so following it reads what the reply was reading.
    const later = [...ENTRIES, entry("entry-3", "something else")];
    const followed = read(next, later);

    expect(followed.entry).toBe("entry-2");
    expect(window(followed)).toEqual(POINTS.slice(10, 20));
    // And "the latest" now means the new one, which is the drift the pinning
    // exists to avoid.
    expect(read({}, later).entry).toBe("entry-3");
  });

  it("R4j: two adjacent windows join exactly, with nothing dropped or repeated", function* () {
    const first = read({ offset: 0, limit: 4000 }, ENTRIES);
    const next = first.next;
    if (next === undefined) {
      throw new Error("this window had more after it");
    }
    const second = read(next, ENTRIES);

    expect(first.text + second.text).toBe(POINTS.slice(0, 8000).join(""));
  });
});

describe("Tier R4 — short, empty and still running", () => {
  it("R4k: an entry that printed nothing reads as empty, not as missing", function* () {
    const held = read({}, [entry("entry-1", "")]);

    expect(held.entry).toBe("entry-1");
    expect(held.length).toBe(0);
    expect(held.offset).toBe(0);
    expect(held.text).toBe("");
    expect(held.previous).toBe(undefined);
    expect(held.next).toBe(undefined);
  });

  it("R4l: output shorter than the window is all of it", function* () {
    const held = read({}, [entry("entry-1", "short")]);

    expect(held.offset).toBe(0);
    expect(held.text).toBe("short");
  });

  it("R4m: a running entry answers with the snapshot it has so far", function* () {
    const running = entry("entry-2", "partial output", "running");
    const held = read({ offset: 0, limit: 7 }, [entry("entry-1", "earlier"), running]);

    // An unfinished snapshot, reported as unfinished. Nothing here waits for
    // the entry to produce more, and nothing promises a window past what was
    // observed — a reply that wants the rest reads again.
    expect(held.status).toBe("running");
    expect(held.length).toBe(14);
    expect(held.text).toBe("partial");
    expect(held.next).toEqual({ entry: "entry-2", offset: 7, limit: 7 });
  });

  it("R4n: a failed entry's output is read the same way", function* () {
    const held = read({}, [entry("entry-1", "boom", "failed")]);

    expect(held.status).toBe("failed");
    expect(held.text).toBe("boom");
  });
});

describe("Tier R4 — what a read refuses rather than guessing at", () => {
  const ENTRIES = [entry("entry-1", "one"), entry("entry-2", "two")];

  it("R4o: a zero or positive entry selector is unavailable", function* () {
    for (const stated of [0, 1, 2]) {
      expect(refusal({ entry: stated }, ENTRIES)).toContain("negative position");
    }
  });

  it("R4p: an entry index past the oldest refuses rather than clamping", function* () {
    // Clamping would answer about a different run than the reply asked about.
    expect(refusal({ entry: -3 }, ENTRIES)).toContain("no entry at position -3");
  });

  it("R4q: an unknown entry id refuses without substituting a neighbour", function* () {
    expect(refusal({ entry: "entry-9" }, ENTRIES)).toContain('no entry "entry-9"');
  });

  it("R4r: a nonpositive or fractional limit refuses", function* () {
    for (const stated of [0, -1, 1.5]) {
      expect(refusal({ limit: stated }, ENTRIES)).toContain("positive whole number");
    }
  });

  it("R4s: a non-integer entry index refuses", function* () {
    expect(refusal({ entry: -1.5 }, ENTRIES)).toContain("negative position");
  });

  it("R4t: a session with no entries has nothing to read", function* () {
    expect(refusal({}, [])).toContain("no entries to read");
  });
});

describe("Tier R4 — the read a submitted entry hands back", () => {
  it("R4u: it pins the entry and leaves the window as the tail", function* () {
    const instruction = initialRead("entry-7");

    expect(instruction).toEqual({ entry: "entry-7", limit: DEFAULT_LIMIT });
    // No body, no preview, no summary: an instruction, and the exact entry it
    // is for.
    expect(Object.keys(instruction).sort()).toEqual(["entry", "limit"]);

    // Following it reads that entry's tail.
    const held = read(instruction, [entry("entry-7", LONG)]);
    expect(held.entry).toBe("entry-7");
    expect(held.offset).toBe(10000 - DEFAULT_LIMIT);
  });
});
