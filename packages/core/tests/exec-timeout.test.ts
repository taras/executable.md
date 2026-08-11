/**
 * Tier XE — what bounds an exec block (spec §3.3, §Config).
 *
 * Every case reads the timeout the Process operation was actually given. That
 * is the whole question — which value reaches the command — and reading the
 * argument answers it without waiting for a clock, so nothing here races.
 *
 * The `timeout` modifier is exercised through the registry, never by name:
 * these cases are what stop the local contract from being reimplemented as a
 * scan of the info string somewhere else in the chain.
 */
import { describe, it, beforeAll } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { scoped } from "effection";
import type { Operation } from "effection";
import { InMemoryStream } from "@executablemd/durable-streams";
import { ephemeral } from "@executablemd/durable-streams";
import { API, Config, timeoutExec } from "@executablemd/runtime";
import type { ConfigApi } from "@executablemd/runtime";
import { useStubFs } from "@executablemd/runtime/test";
import { execute } from "../src/execute.ts";
import { collect } from "../src/collect.ts";
import { useTempFileCompiler } from "../src/temp-file-compiler.ts";
import type { ModifierFactory } from "../src/modifiers.ts";

interface Run {
  /** The rendered document. A text root renders text, so this is its Markdown. */
  output: string;
  /** The timeout every exec call was given, in call order. */
  timeouts: (number | undefined)[];
}

function* run(
  body: string,
  options: { config?: Partial<ConfigApi>; modifiers?: Record<string, ModifierFactory> } = {},
): Operation<Run> {
  const timeouts: (number | undefined)[] = [];
  return yield* scoped(function* () {
    yield* useStubFs({ "test.md": body });
    if (options.config) {
      const { timeout, timeoutExec: exec, timeoutFetch } = options.config;
      yield* Config.around(
        {
          ...(timeout === undefined ? {} : { timeout: () => timeout }),
          ...(exec === undefined ? {} : { timeoutExec: () => exec }),
          ...(timeoutFetch === undefined ? {} : { timeoutFetch: () => timeoutFetch }),
        },
        { at: "min" },
      );
    }
    yield* API.Process.around({
      // deno-lint-ignore require-yield
      *exec([call]) {
        timeouts.push(call.timeout);
        return { exitCode: 0, stdout: "RAN\n", stderr: "" };
      },
    });
    const output = yield* collect(
      yield* execute({
        path: "test.md",
        stream: new InMemoryStream(),
        ...(options.modifiers ? { modifiers: options.modifiers } : {}),
      }),
    );
    return { output: String(output), timeouts };
  });
}

/** A modifier that records the exec default it observes, then delegates. */
function observer(seen: Record<string, number | undefined>, key: string): ModifierFactory {
  return (_params) => (_args, next) =>
    (function* () {
      seen[key] = yield* ephemeral(timeoutExec);
      return yield* next();
    })();
}

const block = (info: string, command = "work") => `\`\`\`${info}\n${command}\n\`\`\`\n`;

describe("Tier XE — exec block timeouts", () => {
  beforeAll(() => useTempFileCompiler());

  it("XE1: a block nobody bounded runs with no timeout at all", function* () {
    const { timeouts } = yield* run(block("bash exec"));
    expect(timeouts).toEqual([undefined]);
  });

  it("XE2: the run's exec default bounds every block", function* () {
    const { timeouts } = yield* run(`${block("bash exec")}\n${block("bash exec", "again")}`, {
      config: { timeoutExec: 5_000 },
    });
    expect(timeouts).toEqual([5_000, 5_000]);
  });

  it("XE3: a declared duration overrides the default for that block alone", function* () {
    const { timeouts } = yield* run(
      `${block("bash timeout=250ms exec")}\n${block("bash exec", "again")}`,
      { config: { timeoutExec: 5_000 } },
    );
    expect(timeouts).toEqual([250, 5_000]);
  });

  it("XE4: a bare timeout takes the run's exec default", function* () {
    const { timeouts } = yield* run(block("bash timeout exec"), {
      config: { timeoutExec: 5_000 },
    });
    expect(timeouts).toEqual([5_000]);
  });

  it("XE5: a bare timeout with no configured default refuses before the process starts", function* () {
    const { output, timeouts } = yield* run(block("bash timeout exec"));
    expect(timeouts).toEqual([]);
    expect(output).toContain("names no duration");
    expect(output).toContain("--timeout-exec");
  });

  it("XE6: `timeout=` is an empty duration, not a bare timeout", function* () {
    const { output, timeouts } = yield* run(block("bash timeout= exec"), {
      config: { timeoutExec: 5_000 },
    });
    expect(timeouts).toEqual([]);
    expect(output).toContain("must be a duration");
  });

  it("XE7: a malformed duration refuses before the process starts", function* () {
    for (const info of ["bash timeout=abc exec", "bash timeout=0s exec", "bash timeout=-5s exec"]) {
      const { output, timeouts } = yield* run(block(info), { config: { timeoutExec: 5_000 } });
      expect({ info, timeouts }).toEqual({ info, timeouts: [] });
      expect(output).toContain("must be a duration");
    }
  });

  it("XE8: a timeout after the terminal is unreachable, so it is never applied", function* () {
    // `exec` is terminal and never calls next(), so this modifier's factory is
    // built but its middleware never runs — a malformed duration behind it
    // cannot fail a run it was never part of.
    const { output, timeouts } = yield* run(block("bash exec timeout=nonsense"), {
      config: { timeoutExec: 5_000 },
    });
    expect(timeouts).toEqual([5_000]);
    expect(output).not.toContain("must be a duration");
  });

  it("XE9: nested timeouts follow wrapper order — the innermost reaches the terminal", function* () {
    const { timeouts } = yield* run(block("bash timeout=5s timeout=250ms exec"), {
      config: { timeoutExec: 9_000 },
    });
    expect(timeouts).toEqual([250]);
  });

  it("XE10: middleware outside the timeout sees the run's default, inside sees the block's", function* () {
    const seen: Record<string, number | undefined> = {};
    const { timeouts } = yield* run(block("bash outer timeout=250ms inner exec"), {
      config: { timeoutExec: 5_000 },
      modifiers: { outer: observer(seen, "outer"), inner: observer(seen, "inner") },
    });
    expect(seen).toEqual({ outer: 5_000, inner: 250 });
    expect(timeouts).toEqual([250]);
  });

  it("XE11: replacing the timeout factory leaves no built-in behavior behind", function* () {
    const seen: Record<string, number | undefined> = {};
    const { timeouts } = yield* run(block("bash timeout=250ms exec"), {
      config: { timeoutExec: 5_000 },
      modifiers: { timeout: observer(seen, "replacement") },
    });
    // The replacement delegates and declares nothing, so the block is bounded
    // by the run's default. A hidden override elsewhere would show up as 250.
    expect(seen).toEqual({ replacement: 5_000 });
    expect(timeouts).toEqual([5_000]);
  });

  it("XE12: a block's declaration does not leak to the block after it", function* () {
    const { timeouts } = yield* run(
      `${block("bash timeout=250ms exec")}\n${block("bash timeout=1s exec", "again")}\n${
        block("bash exec", "third")
      }`,
      { config: { timeoutExec: 5_000 } },
    );
    expect(timeouts).toEqual([250, 1_000, 5_000]);
  });
});
