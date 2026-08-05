import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";

import { compareTracked, parseStageRecords, UnsupportedEntryError } from "../lib/tracked.ts";
import type { TrackedEntry, TrackedState } from "../lib/tracked.ts";

const OID = "a450c348f5d9e7c58850481fc5de93714 88afac9".replace(" ", "");

function record(mode: string, path: string, stage = "0"): string {
  return `${mode} ${OID} ${stage}\t${path}\0`;
}

function state(entries: Record<string, TrackedEntry>): TrackedState {
  return new Map(Object.entries(entries));
}

const FILE: TrackedEntry = { kind: "file", digest: "abc123def456", executable: false };

describe("parseStageRecords", () => {
  it("splits metadata from path at the first tab", function* () {
    expect(parseStageRecords(record("100644", "README.md"))).toEqual([
      { mode: "100644", oid: OID, path: "README.md" },
    ]);
  });

  it("keeps a filename containing a tab whole", function* () {
    expect(parseStageRecords(record("100644", "tab\tname.txt"))[0]!.path).toEqual("tab\tname.txt");
  });

  it("keeps a filename containing a newline whole", function* () {
    expect(parseStageRecords(record("100644", "new\nline.txt"))[0]!.path).toEqual("new\nline.txt");
  });

  it("reads the executable and symlink modes", function* () {
    const records = parseStageRecords(
      `${record("100755", "run.sh")}${record("120000", "link.txt")}`,
    );
    expect(records.map((entry) => entry.mode)).toEqual(["100755", "120000"]);
  });

  it("refuses a submodule before anything touches the filesystem", function* () {
    expect(() => parseStageRecords(record("160000", "vendored"))).toThrow(UnsupportedEntryError);
  });

  it("refuses an unmerged path rather than fingerprinting one side of it", function* () {
    expect(() => parseStageRecords(record("100644", "conflicted.ts", "1"))).toThrow(
      UnsupportedEntryError,
    );
  });

  it("is empty for an empty index", function* () {
    expect(parseStageRecords("")).toEqual([]);
  });
});

describe("compareTracked", () => {
  it("finds nothing when nothing moved", function* () {
    expect(compareTracked(state({ "a.ts": FILE }), state({ "a.ts": FILE }))).toEqual([]);
  });

  it("finds a content change", function* () {
    const after = state({ "a.ts": { kind: "file", digest: "999999999999", executable: false } });
    expect(compareTracked(state({ "a.ts": FILE }), after)).toEqual([
      "a.ts: abc123def456 -> 999999999999",
    ]);
  });

  it("finds a mode-only change", function* () {
    const after = state({ "a.ts": { ...FILE, executable: true } });
    expect(compareTracked(state({ "a.ts": FILE }), after)).toEqual([
      "a.ts: abc123def456 -> abc123def456 +x",
    ]);
  });

  it("finds a symlink whose target moved", function* () {
    const before = state({ l: { kind: "symlink", target: "a.ts" } });
    const after = state({ l: { kind: "symlink", target: "b.ts" } });
    expect(compareTracked(before, after)).toEqual(["l: -> a.ts -> -> b.ts"]);
  });

  it("finds a tracked file a check deleted", function* () {
    expect(compareTracked(state({ "a.ts": FILE }), state({ "a.ts": { kind: "absent" } }))).toEqual([
      "a.ts: abc123def456 -> absent",
    ]);
  });

  it("finds a file that was restored, since absence is a state too", function* () {
    expect(compareTracked(state({ "a.ts": { kind: "absent" } }), state({ "a.ts": FILE }))).toEqual([
      "a.ts: absent -> abc123def456",
    ]);
  });

  /** A worktree that was dirty to begin with is still a worktree nothing may move. */
  it("passes a file that was already dirty and stayed that way", function* () {
    const dirty = state({ "a.ts": { kind: "file", digest: "dirtydirty00", executable: false } });
    expect(compareTracked(dirty, dirty)).toEqual([]);
  });

  it("fails a file that was already dirty and then moved again", function* () {
    const before = state({ "a.ts": { kind: "file", digest: "dirtydirty00", executable: false } });
    const after = state({ "a.ts": { kind: "file", digest: "dirtierdirt0", executable: false } });
    expect(compareTracked(before, after)).toEqual(["a.ts: dirtydirty00 -> dirtierdirt0"]);
  });

  it("names a path that stopped or started being tracked", function* () {
    expect(compareTracked(state({ "a.ts": FILE }), state({ "b.ts": FILE }))).toEqual([
      "a.ts: no longer tracked",
      "b.ts: newly tracked",
    ]);
  });

  it("reports in a stable order", function* () {
    const before = state({ "b.ts": FILE, "a.ts": FILE });
    const after = state({
      "b.ts": { ...FILE, digest: "222222222222" },
      "a.ts": { ...FILE, digest: "111111111111" },
    });
    expect(compareTracked(before, after).map((line) => line.split(":")[0])).toEqual([
      "a.ts",
      "b.ts",
    ]);
  });
});
