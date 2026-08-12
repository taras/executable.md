/**
 * The process adapter's retention, tested where it lives.
 *
 * Retention is the adapter's own business: it reads what reaches its per-exec
 * boundary on the way past, and a caller only ever sees the result. Middleware
 * enclosing a call is trusted preprocessing and may transform, consume, redact,
 * or redirect before that — nothing here installs any, so what these cases
 * receive is what the commands emit. They drive real children through the
 * public operation rather than reaching for the helper behind it, so what is
 * asserted is the contract `exec` states.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { scoped } from "effection";
import { Stdio } from "@effectionx/process";
import { exec, useQuietProcessOutput } from "../apis.ts";

describe("Tier FG — process retention", () => {
  it("FG16: each channel's split code points survive the other channel", function* () {
    // A code point split across two writes, with the other channel writing in
    // between: one shared decoder would hand `x` the euro's continuation bytes.
    const script = "printf '\\xe2\\x82'; printf 'x' >&2; printf '\\xac'";

    const result = yield* exec({ command: ["bash", "-c", script], retain: true });

    expect(result.stdout).toBe("€");
    expect(result.stderr).toBe("x");
    expect(result.exitCode).toBe(0);
  });

  /**
   * A caller whose subprocess output is an answer asks for it not to be shown.
   * That is a decision about the host's terminal and nothing else: if it also
   * decided what the caller learns, every quiet command would answer nothing.
   */
  it("FG16c: quiet output is kept from the host and still reported to its caller", function* () {
    const decoder = new TextDecoder();
    let displayed = "";

    const result = yield* scoped(function* () {
      // Where the host's own writer sits, outside the quiet scope below.
      yield* Stdio.around(
        {
          *stdout([bytes]) {
            displayed += decoder.decode(bytes);
          },
        },
        { at: "min" },
      );

      return yield* scoped(function* () {
        yield* useQuietProcessOutput();
        return yield* exec({
          command: ["bash", "-c", "printf 'the-answer'; printf 'a-diagnostic' >&2"],
          retain: true,
        });
      });
    });

    expect(displayed).toBe("");
    expect(result.stdout).toBe("the-answer");
    expect(result.stderr).toBe("a-diagnostic");
  });

  it("FG16a: exec({ retain: true }) reports a real child's channels exactly", function* () {
    const result = yield* exec({
      command: ["bash", "-c", "printf 'out-€'; printf 'err-€' >&2"],
      retain: true,
    });

    expect(result.stdout).toBe("out-€");
    expect(result.stderr).toBe("err-€");
    expect(result.exitCode).toBe(0);
  });

  it("FG16b: a transient run reports its status and keeps neither channel", function* () {
    const result = yield* exec({
      command: ["bash", "-c", "printf 'out'; printf 'err' >&2; exit 3"],
      retain: false,
    });

    // "no output" and "not retained" are different answers, and this is the
    // second one.
    expect(result.stdout).toBeUndefined();
    expect(result.stderr).toBeUndefined();
    expect(result.exitCode).toBe(3);
  });
});
