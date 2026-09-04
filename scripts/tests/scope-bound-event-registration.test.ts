/**
 * The lifecycle contract this repository requires of the one-event helper it
 * standardises on, `once()` from `@effectionx/node/events`.
 *
 * A listener is scoped state. The helper therefore has to behave like every
 * other Effection resource: register nothing until somebody interprets it,
 * register exactly once when they do, and detach on every way the interpreting
 * scope can end — the event arriving, a halt, or losing a `race()`. Cleanup
 * that runs only when the event fires is not cleanup, because the event is
 * exactly what a cancelled wait never gets.
 *
 * Node and the DOM count listeners differently, so both families are proved
 * here: `EventEmitter` answers `listenerCount()` directly, and `EventTarget`
 * has no equivalent, so the target below counts its own registrations.
 *
 * Tracked upstream as thefrontside/effectionx#251. Until a release that fixes
 * it is published, this file fails on construction being eager, which is the
 * defect.
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { once } from "@effectionx/node/events";
import { readTextFile, walk } from "@effectionx/fs";
import { each, race, sleep, spawn } from "effection";
import type { Operation, Task } from "effection";
import { EventEmitter } from "node:events";
import path from "node:path";

import { oxlint, ROOT, violations } from "./oxlint.ts";

/**
 * An `EventTarget` that reports how many listeners it is holding. The platform
 * exposes no count, so the registrations are tallied as they are made.
 */
class CountingTarget extends EventTarget {
  #live = new Map<string, number>();

  override addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: AddEventListenerOptions | boolean,
  ): void {
    this.#live.set(type, (this.#live.get(type) ?? 0) + 1);
    super.addEventListener(type, listener, options);
  }

  override removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: EventListenerOptions | boolean,
  ): void {
    this.#live.set(type, (this.#live.get(type) ?? 0) - 1);
    super.removeEventListener(type, listener, options);
  }

  listenerCount(type: string): number {
    return this.#live.get(type) ?? 0;
  }
}

/** Give a spawned child its first turn, so its registrations have happened. */
function started(): Operation<void> {
  return sleep(0);
}

/** Let a settled child's teardown finish before its listeners are counted. */
function settled(): Operation<void> {
  return sleep(0);
}

describe("@effectionx/node once() is scope-bound", () => {
  describe("with a Node EventEmitter", () => {
    it("registers nothing until the operation is interpreted", function* () {
      const emitter = new EventEmitter();

      once(emitter, "ready");

      expect(emitter.listenerCount("ready")).toBe(0);
    });

    it("registers exactly one listener when interpreted", function* () {
      const emitter = new EventEmitter();

      yield* spawn(function* () {
        yield* once(emitter, "ready");
      });
      yield* started();

      expect(emitter.listenerCount("ready")).toBe(1);
    });

    it("settles once with the emitted arguments and detaches", function* () {
      const emitter = new EventEmitter();
      const waiter: Task<unknown[]> = yield* spawn(function* () {
        return yield* once(emitter, "ready");
      });
      yield* started();

      emitter.emit("ready", "first", 2);
      const args = yield* waiter;

      expect(args).toEqual(["first", 2]);
      expect(emitter.listenerCount("ready")).toBe(0);
    });

    it("detaches when the interpreting scope halts before the event", function* () {
      const emitter = new EventEmitter();
      const waiter = yield* spawn(function* () {
        yield* once(emitter, "ready");
      });
      yield* started();

      yield* waiter.halt();

      expect(emitter.listenerCount("ready")).toBe(0);
    });

    it("detaches the arm that loses a race", function* () {
      const emitter = new EventEmitter();
      const winner: Task<unknown[]> = yield* spawn(function* () {
        return yield* race([once(emitter, "ready"), once(emitter, "failed")]);
      });
      yield* started();

      expect(emitter.listenerCount("failed")).toBe(1);

      emitter.emit("ready", "won");
      yield* winner;
      yield* settled();

      expect(emitter.listenerCount("failed")).toBe(0);
    });

    /**
     * A leaked listener is not inert: it still holds a resolver for work
     * nobody is waiting on, and the next interpretation would see two. An
     * event after the halt therefore has to reach nothing at all, and a fresh
     * wait has to observe the event after it rather than the one it missed.
     */
    it("ignores an event emitted after the wait was abandoned", function* () {
      const emitter = new EventEmitter();
      const abandoned = yield* spawn(function* () {
        yield* once(emitter, "ready");
      });
      yield* started();
      yield* abandoned.halt();

      // Asserted before the emit, not after: a leaked listener that removes
      // itself when the event finally arrives leaves the same count behind as
      // one that was never there.
      expect(emitter.listenerCount("ready")).toBe(0);

      emitter.emit("ready", "ignored");

      const waiter: Task<unknown[]> = yield* spawn(function* () {
        return yield* once(emitter, "ready");
      });
      yield* started();

      expect(emitter.listenerCount("ready")).toBe(1);

      emitter.emit("ready", "observed");

      expect(yield* waiter).toEqual(["observed"]);
    });
  });

  describe("with a DOM EventTarget", () => {
    it("registers nothing until the operation is interpreted", function* () {
      const target = new CountingTarget();

      once(target, "ready");

      expect(target.listenerCount("ready")).toBe(0);
    });

    it("registers exactly one listener when interpreted", function* () {
      const target = new CountingTarget();

      yield* spawn(function* () {
        yield* once(target, "ready");
      });
      yield* started();

      expect(target.listenerCount("ready")).toBe(1);
    });

    it("settles once with the dispatched event and detaches", function* () {
      const target = new CountingTarget();
      const waiter: Task<Event[]> = yield* spawn(function* () {
        return yield* once<Event[]>(target, "ready");
      });
      yield* started();

      target.dispatchEvent(new Event("ready"));
      const [event] = yield* waiter;

      expect(event.type).toBe("ready");
      expect(target.listenerCount("ready")).toBe(0);
    });

    it("detaches when the interpreting scope halts before the event", function* () {
      const target = new CountingTarget();
      const waiter = yield* spawn(function* () {
        yield* once(target, "ready");
      });
      yield* started();

      yield* waiter.halt();

      expect(target.listenerCount("ready")).toBe(0);
    });

    it("detaches the arm that loses a race", function* () {
      const target = new CountingTarget();
      const winner: Task<Event[]> = yield* spawn(function* () {
        return yield* race([once<Event[]>(target, "ready"), once<Event[]>(target, "failed")]);
      });
      yield* started();

      expect(target.listenerCount("failed")).toBe(1);

      target.dispatchEvent(new Event("ready"));
      yield* winner;
      yield* settled();

      expect(target.listenerCount("failed")).toBe(0);
    });

    it("ignores an event dispatched after the wait was abandoned", function* () {
      const target = new CountingTarget();
      const abandoned = yield* spawn(function* () {
        yield* once(target, "ready");
      });
      yield* started();
      yield* abandoned.halt();

      // Asserted before the dispatch, for the reason given above.
      expect(target.listenerCount("ready")).toBe(0);

      target.dispatchEvent(new Event("ready"));

      const waiter: Task<Event[]> = yield* spawn(function* () {
        return yield* once<Event[]>(target, "ready");
      });
      yield* started();

      expect(target.listenerCount("ready")).toBe(1);

      const dispatched = new Event("ready");
      target.dispatchEvent(dispatched);

      expect((yield* waiter)[0]).toBe(dispatched);
    });
  });
});

const RULE = "require-scope-bound-event-registration";

/** The directories `deno task lint` passes to oxlint. */
const LINTED = ["packages", "scripts", ".reviews/components"];

/** What the lint task's `--ignore-pattern` arguments keep out. */
const UNLINTED = [
  `${path.sep}npm${path.sep}`,
  path.join("scripts", "tests", "fixtures"),
  path.join("packages", "workflow", "vendor", "cloudflare-computer-dofs"),
  `${path.sep}node_modules${path.sep}`,
];

/** A whole-file directive, as opposed to `-next-line` or `-line`. */
const FILE_WIDE = new RegExp(`(?:oxlint|eslint)-disable(?!-next-line|-line)[^\\n]*${RULE}`, "u");

const NARROW = new RegExp(`oxlint-disable-next-line[^\\n]*local/${RULE}`, "u");

function reported(fixture: string): Operation<number[]> {
  return violations(`scripts/tests/fixtures/${fixture}`, RULE);
}

/** The rule's own diagnostics for a fixture, in source order. */
function* diagnostics(fixture: string): Operation<{ line: number; message: string }[]> {
  const output = yield* oxlint(["--format=json", `scripts/tests/fixtures/${fixture}`]);
  const report: {
    diagnostics: { code: string; message: string; labels: { span: { line: number } }[] }[];
  } = JSON.parse(output);

  return report.diagnostics
    .filter((entry) => entry.code === `local(${RULE})`)
    .map((entry) => ({ line: entry.labels[0].span.line, message: entry.message }))
    .sort((left, right) => left.line - right.line);
}

/** Every file `deno task lint` actually reads. */
function* linted(): Operation<string[]> {
  const files: string[] = [];
  for (const directory of LINTED) {
    const entries = walk(path.join(ROOT, directory), {
      includeDirs: false,
      skip: [/node_modules/u, /[/\\]npm[/\\]/u],
    });
    for (const entry of yield* each(entries)) {
      if (
        /\.(?:ts|tsx|js|mjs|cjs)$/u.test(entry.path) &&
        !UNLINTED.some((fragment) => entry.path.includes(fragment))
      ) {
        files.push(entry.path);
      }
      yield* each.next();
    }
  }
  return files;
}

describe("local/require-scope-bound-event-registration", () => {
  /**
   * In fixture order: `.once()` on a socket inside an `action()`, on an
   * emitter whose `ensure()` would otherwise pair it, `{ once: true }` on a
   * DOM target, and `.once()` reached through an alias of the socket.
   */
  it("reports one-event APIs whose cleanup waits for the event", function* () {
    expect(yield* reported("event-registration-raw-once.ts")).toEqual([11, 19, 31, 44]);
  });

  it("names the scope-bound helper as the replacement for a one-event wait", function* () {
    const report = yield* diagnostics("event-registration-raw-once.ts");

    expect(report[0].message).toContain("@effectionx/node/events");
    expect(report[0].message).toContain("cancelled wait never gets");
  });

  /**
   * In fixture order: an inline handler, no cleanup at all, a cleanup naming a
   * different event, a different handler and a different receiver, an
   * `ensure()` armed after the owner has already suspended, a handler that
   * only removes itself, a teardown that suspends before removing, a
   * `removeListener()` where `.off()` belongs, a computed event name, a
   * `try` opened only after the owner has suspended, a per-connection handler
   * recorded in a collection nothing walks and one walked from a different
   * collection, a DOM removal whose capture mode disagrees with the
   * registration, cleanup behind a condition that may not run, cleanup in an
   * outer owner rather than the one that subscribed, a pair recorded only
   * after the owner suspended, a pair recorded into a shadowed collection of
   * the same name, and a one-shot option spelled as a string key or bound to
   * a constant, a pair a nested generator records that only the resource
   * around it walks, and an `ensure()` yielded after the subscription — whose
   * own registration is a suspension an owner can be halted at.
   */
  it("reports every way a subscription outlives its owner", function* () {
    expect(yield* reported("event-registration-unpaired.ts")).toEqual([
      11, 18, 25, 37, 49, 60, 75, 82, 94, 105, 116, 134, 137, 152, 155, 168, 179, 193, 207, 224,
      229, 244, 255, 278, 290,
    ]);
  });

  it("distinguishes a missing cleanup from one that names the wrong pair", function* () {
    const report = yield* diagnostics("event-registration-unpaired.ts");
    const at = (line: number) => report.find((entry) => entry.line === line)?.message ?? "";

    expect(at(18)).toContain("Nothing removes onConnection");
    expect(at(25)).toContain("does not name the same receiver, event, handler and capture mode");
    expect(at(60)).toContain("registered after the owner can already suspend");
    expect(at(75)).toContain("removes itself only when");
    expect(at(82)).toContain("Teardown suspends before it removes");
    expect(at(94)).toContain("removeListener()");
    expect(at(105)).toContain("event name is computed");
    expect(at(116)).toContain("registered after the owner can already suspend");
    expect(at(134)).toContain("Nothing removes onClose");
    expect(at(152)).toContain("does not name the same receiver, event, handler and capture mode");
    expect(at(179)).toContain("registered after the owner can already suspend");
    expect(at(193)).toContain("Nothing removes onConnection");
    expect(at(207)).toContain("Nothing removes onClose");
    expect(at(224)).toContain("does not name the same receiver, event, handler and capture mode");
    expect(at(244)).toContain("{ once: true }");
    expect(at(255)).toContain("{ once: true }");
    expect(at(278)).toContain("Nothing removes onError");
    expect(at(229)).toContain("yielded after onConnection was attached");
    expect(at(290)).toContain("Establish the ensure() before the subscription");
  });

  /**
   * A `finally` around the subscription, an `ensure()` armed in the same
   * synchronous prefix, an `ensure()` whose listener-dependent wait is closed
   * by a synchronous inner `finally`, the cleanup an `action()` returns, and
   * the corrected helper itself.
   */
  it("accepts the four teardown shapes and the scope-bound helper", function* () {
    expect(yield* reported("event-registration-paired.ts")).toEqual([]);
  });

  /**
   * The acceptance above is only worth something if the rule was looking. One
   * registration per source family, each with no cleanup at all, is reported:
   * constructors, factories, connections, child streams, aliases, annotated
   * parameters, the `process` global and its streams, an emitter subclass and
   * its `this`, a paired structural interface, and the DOM families.
   */
  it("recognizes every source family it claims to", function* () {
    expect(yield* reported("event-registration-sources.ts")).toEqual([
      16, 21, 26, 31, 36, 41, 47, 51, 55, 59, 63, 68, 76, 86, 91, 96, 100, 105,
    ]);
  });

  /**
   * The near misses of that list: a router with an `on()` of its own, a
   * `connect` from another module, an interface declaring `on` and no `off`, a
   * class named `EventEmitter` that extends nothing, a local `process` and a
   * local `document`, an unannotated parameter, and a binding that was
   * reassigned after it was declared. `ensure` and `action` imported under
   * other names still pair and still own, because both are resolved through
   * their import rather than their spelling.
   */
  it("accepts values whose on/once belong to somebody else", function* () {
    expect(yield* reported("event-registration-bindings.ts")).toEqual([]);
  });

  it("accepts listeners installed where no Effection scope owns them", function* () {
    expect(yield* reported("event-registration-unowned.ts")).toEqual([]);
  });

  it("suppresses the line a narrow directive covers, and no other", function* () {
    expect(yield* reported("event-registration-suppressed.ts")).toEqual([13]);
  });

  /**
   * A file-wide directive silences every subscription below it while stating
   * an invariant for none of them. Nothing is reported here, which is exactly
   * why the form is forbidden and why the repository is checked for it below.
   */
  it("is silenced entirely by a file-wide exemption", function* () {
    expect(yield* reported("event-registration-exempted.ts")).toEqual([]);
  });

  it("finds no broad exemption anywhere on the lint surface", function* () {
    const exempted: string[] = [];
    for (const file of yield* linted()) {
      if (FILE_WIDE.test(yield* readTextFile(file))) {
        exempted.push(path.relative(ROOT, file));
      }
    }

    expect(exempted).toEqual([]);
  });

  it("finds no configuration entry turning the rule off for a path", function* () {
    for (const config of [".oxlintrc.json", "oxlint.shared.json", ".reviews/.oxlintrc.json"]) {
      const source = yield* readTextFile(path.join(ROOT, config));
      const off = new RegExp(`"local/${RULE}":\\s*(?:"off"|\\["off")`, "u").test(source);
      expect([config, off]).toEqual([config, false]);
    }
  });

  it("keeps every suppression narrow and explained", function* () {
    const unexplained: string[] = [];
    for (const file of yield* linted()) {
      const lines = (yield* readTextFile(file)).split("\n");
      for (const [index, line] of lines.entries()) {
        if (!NARROW.test(line)) {
          continue;
        }
        const preceding = lines
          .slice(Math.max(0, index - 8), index)
          .filter((entry) => /^\s*(?:\/\/|\*|\/\*)/u.test(entry))
          .filter((entry) => !NARROW.test(entry));
        if (preceding.length === 0) {
          unexplained.push(`${path.relative(ROOT, file)}:${index + 1}`);
        }
      }
    }

    expect(unexplained).toEqual([]);
  });

  /**
   * Non-vacuous on both sweeps: the surface has files to read, and the pattern
   * that finds no broad exemption above does find the one the fixture carries.
   */
  it("sweeps a populated lint surface with a pattern that matches", function* () {
    const files = yield* linted();

    expect(files.length).toBeGreaterThan(100);

    const exempted = yield* readTextFile(
      path.join(ROOT, "scripts/tests/fixtures/event-registration-exempted.ts"),
    );
    expect(FILE_WIDE.test(exempted)).toBe(true);
    expect(NARROW.test(exempted)).toBe(false);

    const suppressed = yield* readTextFile(
      path.join(ROOT, "scripts/tests/fixtures/event-registration-suppressed.ts"),
    );
    expect(NARROW.test(suppressed)).toBe(true);
  });
});
