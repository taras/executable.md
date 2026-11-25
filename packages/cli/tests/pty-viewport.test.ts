import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { useTempDirectory } from "@executablemd/test-support/temp";
import { allocate, showing } from "./support/pty.ts";

describe("PTY viewport", () => {
  it("PTY screen coordinates exclude scrollback after output scrolls", function* () {
    const home = yield* useTempDirectory("xmd-pty-viewport-");
    const pty = yield* allocate(
      "i=0; while [ $i -lt 50 ]; do printf 'old row\\n'; i=$((i+1)); done; printf '\\033[2J\\033[Hvisible-control\\n'",
      home,
    );
    yield* showing(pty, "visible-control", 10000);
    const screen = yield* pty.shows();
    expect(screen.findIndex((row) => row.includes("visible-control"))).toBe(0);
    expect(screen.some((row) => row.includes("old row"))).toBe(false);
  });
});
