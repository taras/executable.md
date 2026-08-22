import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { sleep } from "effection";
import type { Operation } from "effection";

import {
  applicable,
  BATTERY,
  COMMAND_TIMEOUT_MILLISECONDS,
  commandTimeout,
  line,
  verify,
} from "../lib/verify.ts";
import type { CommandSpec, Settled, VerifyHost, VerifyOptions } from "../lib/verify.ts";
import type { TrackedEntry, TrackedState } from "../lib/tracked.ts";

const FILE: TrackedEntry = { kind: "file", digest: "abc123def456", executable: false };
const CLEAN: TrackedState = new Map([["a.ts", FILE]]);

interface Recorded {
  host: VerifyHost;
  lines: string[];
  emitted: string[];
  started: string[];
}

interface Behaviour {
  /** Exit codes by command id; anything unnamed passes. */
  codes?: Record<string, number>;
  /** Milliseconds a command waits before settling, to shuffle completion order. */
  delays?: Record<string, number>;
  /** Commands that throw instead of settling. */
  throws?: string[];
  /** Fingerprints handed back in order; the last one repeats. */
  fingerprints?: TrackedState[];
  git?: Record<string, string>;
  gitFails?: string[];
}

function recorder(behaviour: Behaviour): Recorded {
  const lines: string[] = [];
  const emitted: string[] = [];
  const started: string[] = [];
  const fingerprints = behaviour.fingerprints ?? [CLEAN];
  let taken = 0;

  const host: VerifyHost = {
    *run(command: CommandSpec): Operation<Settled> {
      started.push(command.id);
      const delay = behaviour.delays?.[command.id] ?? 0;
      if (delay > 0) {
        yield* sleep(delay);
      }
      if (behaviour.throws?.includes(command.id)) {
        throw new Error(`${command.id} never started`);
      }
      return { code: behaviour.codes?.[command.id] ?? 0, milliseconds: 1000 };
    },
    *spool(id: string): Operation<Uint8Array> {
      return new TextEncoder().encode(`<output of ${id}>`);
    },
    *fingerprint(): Operation<TrackedState> {
      const state = fingerprints[Math.min(taken, fingerprints.length - 1)]!;
      taken += 1;
      return state;
    },
    *git(args: string[]): Operation<string> {
      const key = args.join(" ");
      for (const failing of behaviour.gitFails ?? []) {
        if (key.startsWith(failing)) {
          throw new Error(`git ${key} failed`);
        }
      }
      return behaviour.git?.[key] ?? "";
    },
    log(message) {
      lines.push(message);
    },
    emit(bytes) {
      emitted.push(new TextDecoder().decode(bytes));
    },
  };

  return { host, lines, emitted, started };
}

const NO_SITE: VerifyOptions = { site: "off" };
const AUTO: VerifyOptions = { site: "auto" };

function results(lines: string[]): string[] {
  return lines
    .filter((entry) => entry.startsWith("  ok") || entry.startsWith("  FAILED"))
    .map((entry) => entry.trim().split(/\s+/).slice(0, 2).join(" "));
}

describe("applicable", () => {
  it("drops the site pair for --no-site", function* () {
    const { host } = recorder({});
    const { commands } = yield* applicable(host, NO_SITE);
    expect(commands.some((command) => command.site)).toBe(false);
    expect(commands.length).toEqual(BATTERY.length - 2);
  });

  it("drops the site pair when site/ is untouched", function* () {
    const { host } = recorder({ git: { "status --porcelain=v1 -z": "M  README.md\0" } });
    const { commands, reason } = yield* applicable(host, AUTO);
    expect(commands.some((command) => command.site)).toBe(false);
    expect(reason).toContain("unchanged");
  });

  it("keeps the site pair when the worktree touched site/", function* () {
    const { host } = recorder({ git: { "status --porcelain=v1 -z": "M  site/page.md\0" } });
    const { commands } = yield* applicable(host, AUTO);
    expect(commands.filter((command) => command.site).length).toEqual(2);
  });

  it("keeps the site pair for a committed rename out of site/", function* () {
    const { host } = recorder({
      git: {
        "status --porcelain=v1 -z": "",
        "merge-base origin/main HEAD": "abc123\n",
        "diff --name-status -z -M -C abc123...HEAD": "R100\0site/page.md\0moved-out.md\0",
      },
    });
    const { commands } = yield* applicable(host, AUTO);
    expect(commands.filter((command) => command.site).length).toEqual(2);
  });

  it("runs the site checks when the base cannot be resolved", function* () {
    const { host } = recorder({ gitFails: ["merge-base"] });
    const { commands, reason } = yield* applicable(host, AUTO);
    expect(commands.length).toEqual(BATTERY.length);
    expect(reason).toContain("could not be resolved");
  });

  it("lets --no-site override a real site change", function* () {
    const { host } = recorder({ git: { "status --porcelain=v1 -z": "M  site/page.md\0" } });
    const { commands } = yield* applicable(host, NO_SITE);
    expect(commands.some((command) => command.site)).toBe(false);
  });
});

describe("verify", () => {
  it("passes a clean battery", function* () {
    const { host, lines } = recorder({});
    expect(yield* verify(host, NO_SITE)).toEqual(0);
    expect(lines.at(-1)).toContain("the tracked tree is unchanged");
  });

  it("starts every applicable command", function* () {
    const { host, started } = recorder({});
    yield* verify(host, NO_SITE);
    expect(started.sort()).toEqual(
      BATTERY.filter((c) => !c.site)
        .map((c) => c.id)
        .sort(),
    );
  });

  it("reports in declared order however the commands finish", function* () {
    const { host, lines } = recorder({
      delays: { lint: 40, "check:jsr": 10, test: 20 },
    });
    yield* verify(host, NO_SITE);
    expect(results(lines).map((entry) => entry.split(" ")[1])).toEqual(
      BATTERY.filter((command) => !command.site).map((command) => command.id),
    );
  });

  it("lets every command settle when one fails", function* () {
    const { host, started } = recorder({ codes: { lint: 1 }, delays: { "test:bun": 20 } });
    expect(yield* verify(host, NO_SITE)).toEqual(1);
    expect(started).toContain("test:bun");
  });

  it("prints the first failure in declared order, complete", function* () {
    const { host, lines, emitted } = recorder({ codes: { test: 2, "test:bun": 1 } });
    yield* verify(host, NO_SITE);
    expect(emitted).toEqual(["<output of test>"]);
    expect(lines.join("\n")).toContain("also failed: test:bun");
  });

  it("names later failures with the command that reproduces them", function* () {
    const { host, lines } = recorder({ codes: { "test:bun": 1, docs: 1 } });
    yield* verify(host, NO_SITE);
    const report = lines.join("\n");
    expect(report).toContain("bun run test:bun");
    expect(report).toContain("deno task xmd test packages/core/src --raw");
  });

  it("counts a runner that never started as a failure", function* () {
    const { host, lines } = recorder({ throws: ["test:node"] });
    expect(yield* verify(host, NO_SITE)).toEqual(1);
    expect(results(lines)).toContain("FAILED test:node");
  });

  it("settles a command that outlives the ceiling and reports it timed out", function* () {
    const { host, lines } = recorder({ delays: { test: 60_000 } });
    expect(yield* verify(host, { site: "off", timeout: 25 })).toEqual(1);
    expect(results(lines)).toContain("FAILED test");
    expect(lines.join("\n")).toContain("timed out after");
  });

  /**
   * A deadline nobody is told about is indistinguishable from a hang until it
   * fires, so the battery says what it is up front and again when it fires.
   */
  it("announces the deadline before any command starts", function* () {
    const { host, lines } = recorder({});
    yield* verify(host, { site: "off", timeout: 20 * 60 * 1000 });
    expect(lines[0]).toContain("20m deadline each");
  });

  it("names the same deadline it announced", function* () {
    const { host, lines } = recorder({ delays: { test: 60_000 } });
    yield* verify(host, { site: "off", timeout: 25 });

    const announced = lines[0]?.match(/(\S+) deadline each/)?.[1];
    expect(announced).toBeDefined();
    expect(lines.join("\n")).toContain(`timed out after ${announced}`);
  });

  /**
   * The ruling is one deadline and no retry. A command settles exactly once,
   * so a wedge stays as visible as it is — an attempt count would turn a
   * reproducible upstream defect into an intermittent one.
   */
  it("starts a timed-out command once and never again", function* () {
    const { host, started } = recorder({ delays: { test: 60_000 } });
    yield* verify(host, { site: "off", timeout: 25 });
    expect(started.filter((id) => id === "test")).toEqual(["test"]);
  });

  it("starts a failing command once and never again", function* () {
    const { host, started } = recorder({ codes: { test: 1 } });
    yield* verify(host, { site: "off" });
    expect(started.filter((id) => id === "test")).toEqual(["test"]);
  });

  it("prints what a timed-out command had already written", function* () {
    const { host, emitted } = recorder({ delays: { test: 60_000 } });
    yield* verify(host, { site: "off", timeout: 25 });
    expect(emitted).toEqual(["<output of test>"]);
  });

  it("lets the rest of the battery finish when one command times out", function* () {
    const { host, lines } = recorder({ delays: { test: 60_000, "test:bun": 10 } });
    yield* verify(host, { site: "off", timeout: 40 });
    expect(results(lines)).toContain("ok test:bun");
  });

  /** The fingerprint runs after everything settles, so a failing run still proves it. */
  it("fails when the tracked tree moved, even though every command passed", function* () {
    const moved: TrackedState = new Map([["a.ts", { ...FILE, executable: true }]]);
    const { host, lines } = recorder({ fingerprints: [CLEAN, moved] });
    expect(yield* verify(host, NO_SITE)).toEqual(1);
    expect(lines.join("\n")).toContain("a.ts: abc123def456 -> abc123def456 +x");
  });

  it("still reports the tree that moved during a failing battery", function* () {
    const moved: TrackedState = new Map([["a.ts", { kind: "absent" }]]);
    const { host, lines } = recorder({ codes: { lint: 1 }, fingerprints: [CLEAN, moved] });
    expect(yield* verify(host, NO_SITE)).toEqual(1);
    expect(lines.join("\n")).toContain("a.ts: abc123def456 -> absent");
  });
});

describe("line", () => {
  it("writes a root command as a reader would type it", function* () {
    const lint = BATTERY.find((command) => command.id === "lint")!;
    expect(line(lint)).toEqual("deno task lint");
  });

  it("writes a site command with its directory", function* () {
    const site = BATTERY.find((command) => command.id === "site:build")!;
    expect(line(site)).toEqual("(cd site && deno task build)");
  });
});

/**
 * The battery's commands are not the same size, and #482 is what happens when
 * one ceiling pretends they are: the complete Deno suite reported zero failed
 * tests and was killed anyway, twice in a row on `main` — and a ceiling that
 * tracks a growing suite closely does the same thing a little later.
 *
 * The race that fires cannot be exercised here — twenty to forty-five minutes
 * are not durations a test waits out — so what these hold is the single function
 * both the race and the report read. A second source of truth is exactly the
 * defect: a report naming a deadline that is not the one that settles the
 * command is worse than no report.
 */
describe("commandTimeout", () => {
  const command = (id: string): CommandSpec => BATTERY.find((entry) => entry.id === id)!;

  it("gives the complete Deno suite forty-five minutes", function* () {
    expect(commandTimeout(command("test"), NO_SITE)).toEqual(45 * 60 * 1000);
    expect(command("test").timeout).toEqual(45 * 60 * 1000);
  });

  it("gives the complete Node and Bun suites thirty minutes", function* () {
    for (const id of ["test:node", "test:bun"]) {
      expect(commandTimeout(command(id), NO_SITE)).toEqual(30 * 60 * 1000);
      expect(command(id).timeout).toEqual(30 * 60 * 1000);
    }
  });

  it("leaves every other command at twenty minutes", function* () {
    const suites = new Set(["test", "test:node", "test:bun"]);
    const others = BATTERY.filter((entry) => !suites.has(entry.id));
    expect(others.length).toBeGreaterThan(5);
    for (const entry of others) {
      expect(commandTimeout(entry, NO_SITE)).toEqual(COMMAND_TIMEOUT_MILLISECONDS);
      expect(entry.timeout).toBeUndefined();
    }
  });

  it("lets an explicit coordinator timeout override every command's own", function* () {
    const explicit: VerifyOptions = { site: "off", timeout: 25 };
    for (const entry of BATTERY) {
      expect(commandTimeout(entry, explicit)).toEqual(25);
    }
  });
});

describe("deadline reporting", () => {
  it("names the commands whose deadline differs instead of claiming one", function* () {
    const { host, lines } = recorder({});
    yield* verify(host, NO_SITE);
    expect(lines[0]).toContain("20m deadline each except test 45m, test:node 30m, test:bun 30m");
  });

  it("claims one deadline only when there is one", function* () {
    const { host, lines } = recorder({});
    yield* verify(host, { site: "off", timeout: 20 * 60 * 1000 });
    expect(lines[0]).toContain("20m deadline each");
    expect(lines[0]).not.toContain("except");
  });

  /**
   * Every deadline the first line announces has to be a deadline some command
   * actually runs under, or the announcement is decoration.
   */
  it("announces exactly the deadlines the battery will apply", function* () {
    const { host, lines } = recorder({});
    yield* verify(host, NO_SITE);

    const announcement = lines[0] ?? "";
    for (const entry of BATTERY.filter((command) => !command.site)) {
      const deadline = commandTimeout(entry, NO_SITE);
      const stated =
        deadline === COMMAND_TIMEOUT_MILLISECONDS
          ? "20m deadline each"
          : `${entry.id} ${deadline / 60_000}m`;
      expect(announcement).toContain(stated);
    }
  });

  it("reports the deadline that settled the command it settled", function* () {
    const { host, lines } = recorder({ delays: { test: 60_000 } });
    yield* verify(host, { site: "off", timeout: 25 });

    const announced = lines[0]?.match(/(\S+) deadline each/)?.[1];
    expect(announced).toEqual("0m");
    expect(lines.join("\n")).toContain(`timed out after ${announced}`);
  });
});
