import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { useReplDecoder } from "../src/repl/input.ts";
import { useReplScreen } from "../src/repl/screen.ts";
import { recordingTerminal } from "./support/mounted-repl.ts";

const BYTES = new TextEncoder();
const BURST = "a\x1b[<64;8;4M\t\x1b[<0;2;3Mb\x1b[<65;9;5M";
const ORDERED = [
  { kind: "input", event: { kind: "text", text: "a" } },
  { kind: "wheel", direction: "up", at: { column: 7, row: 3 } },
  { kind: "input", event: { kind: "key", key: "Tab" } },
  { kind: "pointer", at: { column: 1, row: 2 } },
  { kind: "input", event: { kind: "text", text: "b" } },
  { kind: "wheel", direction: "down", at: { column: 8, row: 4 } },
];

describe("wheel input transport", () => {
  it("preserves mixed physical order while draining the scanner", function* () {
    const decoder = yield* useReplDecoder();
    const scan = yield* decoder.scan(BYTES.encode(BURST.repeat(40)));
    expect(scan.ordered).toEqual(Array.from({ length: 40 }, () => ORDERED).flat());
    expect((yield* decoder.scan()).ordered).toEqual([]);
  });

  it("publishes that order through the existing terminal screen", function* () {
    const terminal = recordingTerminal();
    yield* terminal.install();
    const screen = yield* useReplScreen();
    const events = yield* screen.events();
    expect((yield* events.next()).value?.kind).toBe("resize");
    terminal.terminal.feed(BURST);
    for (const expected of ORDERED) {
      expect((yield* events.next()).value).toEqual(expected);
    }
  });
});
