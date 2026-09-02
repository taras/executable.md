/**
 * `durableSpawn` — a durable child the caller owns.
 *
 * `durableAll` and `durableRace` own their children: they start them, wait for
 * them, and cancel them. `durableSpawn` does not — it hands the task back, and
 * everything here follows from that.
 *
 * Two things are easy to get wrong and are checked directly rather than
 * inferred. The task has to outlive the call that produced it, or awaiting it
 * throws `halted` before the child has done anything. And a retained
 * `Close(cancelled)` means something different here than it does under a
 * combinator: nobody is going to cancel this child a second time, so a child
 * that suspended waiting for that would hang the resumed run forever.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { sleep, spawn, suspend } from "effection";
import type { Operation } from "effection";

import { durableRun } from "../run.ts";
import { durableAll, durableRace, durableSpawn } from "../combinators.ts";
import { durableCall } from "../operations.ts";
import { ephemeral } from "../ephemeral.ts";
import { InMemoryStream } from "../stream.ts";
import type { Workflow } from "../types.ts";

/** A workflow that records that it ran and returns `value`. */
function marking(marks: string[], mark: string, value: string): () => Workflow<string> {
  return function* (): Workflow<string> {
    return yield* ephemeral(
      (function* (): Operation<string> {
        marks.push(mark);
        return value;
      })(),
    );
  };
}

describe("durableSpawn — lifetime", () => {
  it("returns a task that is still live, and awaitable", function* () {
    const marks: string[] = [];
    const stream = new InMemoryStream();

    const value = yield* durableRun(
      function* (): Workflow<string> {
        const task = yield* durableSpawn(marking(marks, "child", "spawned"));
        return yield* ephemeral(task);
      },
      { stream },
    );

    expect(value).toBe("spawned");
    expect(marks).toEqual(["child"]);
  });

  it("keeps the task running beside its caller", function* () {
    const marks: string[] = [];
    const stream = new InMemoryStream();

    const value = yield* durableRun(
      function* (): Workflow<string> {
        const task = yield* durableSpawn(function* (): Workflow<string> {
          return yield* ephemeral(
            (function* (): Operation<string> {
              yield* sleep(5);
              marks.push("child finished");
              return "late";
            })(),
          );
        });
        // The caller does its own work first. A task spawned into a scope that
        // closed with the effect would already be dead by now.
        yield* ephemeral(
          (function* (): Operation<void> {
            marks.push("caller working");
          })(),
        );
        return yield* ephemeral(task);
      },
      { stream },
    );

    expect(value).toBe("late");
    expect(marks).toEqual(["caller working", "child finished"]);
  });

  it("lets the caller cancel the task it was given", function* () {
    const marks: string[] = [];
    const stream = new InMemoryStream();

    yield* durableRun(
      function* (): Workflow<string> {
        const task = yield* durableSpawn(function* (): Workflow<string> {
          return yield* ephemeral(
            (function* (): Operation<string> {
              marks.push("child started");
              yield* suspend();
              return "never";
            })(),
          );
        });
        yield* ephemeral(
          (function* (): Operation<void> {
            yield* sleep(1);
            yield* task.halt();
            marks.push("caller halted it");
          })(),
        );
        return "done";
      },
      { stream },
    );

    expect(marks).toEqual(["child started", "caller halted it"]);
    const closes = (yield* stream.readAll()).filter((event) => event.type === "close");
    // Cancelling the task records the child's cancellation, exactly as a
    // combinator-cancelled child records one.
    expect(closes.some((event) => event.result.status === "cancelled")).toBe(true);
  });

  it("allocates child ids in the order children are asked for", function* () {
    const stream = new InMemoryStream();

    yield* durableRun(
      function* (): Workflow<string> {
        const first = yield* durableSpawn(marking([], "a", "a"));
        const second = yield* durableSpawn(marking([], "b", "b"));
        yield* ephemeral(first);
        yield* ephemeral(second);
        return "done";
      },
      { stream },
    );

    const ids = (yield* stream.readAll())
      .filter((event) => event.type === "close")
      .map((event) => String(event.coroutineId));
    expect(ids).toContain("root.0");
    expect(ids).toContain("root.1");
  });
});

describe("durableSpawn — replay", () => {
  it("replays a completed child without running it again", function* () {
    const marks: string[] = [];
    const stream = new InMemoryStream();

    const first = yield* durableRun(
      function* (): Workflow<string> {
        const task = yield* durableSpawn(marking(marks, "ran", "value"));
        return yield* ephemeral(task);
      },
      { stream },
    );
    expect(first).toBe("value");
    expect(marks).toEqual(["ran"]);

    const second = yield* durableRun(
      function* (): Workflow<string> {
        const task = yield* durableSpawn(marking(marks, "ran", "value"));
        return yield* ephemeral(task);
      },
      { stream },
    );

    // The retained result, and the workflow never entered.
    expect(second).toBe("value");
    expect(marks).toEqual(["ran"]);
  });

  it("resumes an interrupted child rather than hanging on its cancelled close", function* () {
    const marks: string[] = [];
    const stream = new InMemoryStream();

    // A run interrupted while the child is still working: the whole run is
    // halted, so the child records Close(cancelled) and the parent records no
    // Close at all. A parent that completed would replay its own result and the
    // child would never be reached.
    const interrupted = yield* spawn(function* () {
      yield* durableRun(
        function* (): Workflow<string> {
          yield* durableSpawn(function* (): Workflow<string> {
            return yield* ephemeral(
              (function* (): Operation<string> {
                marks.push("first life");
                yield* suspend();
                return "never";
              })(),
            );
          });
          yield* ephemeral(
            (function* (): Operation<void> {
              yield* suspend();
            })(),
          );
          return "never";
        },
        { stream },
      );
    });
    yield* sleep(3);
    yield* interrupted.halt();

    expect(marks).toEqual(["first life"]);

    // The resumed run. Nothing is going to cancel this child again, so a child
    // that suspended on the retained cancelled close would never settle.
    const resumed = yield* durableRun(
      function* (): Workflow<string> {
        const task = yield* durableSpawn(function* (): Workflow<string> {
          return yield* ephemeral(
            (function* (): Operation<string> {
              marks.push("second life");
              return "finished";
            })(),
          );
        });
        return yield* ephemeral(task);
      },
      { stream },
    );

    expect(resumed).toBe("finished");
    expect(marks).toEqual(["first life", "second life"]);
    // The record now describes the life that actually finished.
    const closes = (yield* stream.readAll()).filter(
      (event) => event.type === "close" && String(event.coroutineId) === "root.0",
    );
    expect(closes[closes.length - 1]?.result.status).toBe("ok");
  });

  it("continues a resumed child's own retained history", function* () {
    const calls: string[] = [];
    const stream = new InMemoryStream();
    const step = (name: string) =>
      durableCall<string>(name, function* () {
        calls.push(name);
        return name;
      });

    const interrupted = yield* spawn(function* () {
      yield* durableRun(
        function* (): Workflow<string> {
          yield* durableSpawn(function* (): Workflow<string> {
            yield* step("first");
            return yield* ephemeral(
              (function* (): Operation<string> {
                yield* suspend();
                return "never";
              })(),
            );
          });
          yield* ephemeral(
            (function* (): Operation<void> {
              yield* suspend();
            })(),
          );
          return "never";
        },
        { stream },
      );
    });
    yield* sleep(5);
    yield* interrupted.halt();

    expect(calls).toEqual(["first"]);

    const resumed = yield* durableRun(
      function* (): Workflow<string> {
        const task = yield* durableSpawn(function* (): Workflow<string> {
          yield* step("first");
          yield* step("second");
          return "done";
        });
        return yield* ephemeral(task);
      },
      { stream },
    );

    expect(resumed).toBe("done");
    // `first` came from the child's own retained history; only the work it had
    // left ran again.
    expect(calls).toEqual(["first", "second"]);
  });
});

describe("durableSpawn — the combinators keep their own policy", () => {
  it("a retained race loser still suspends until the race cancels it", function* () {
    const marks: string[] = [];
    const stream = new InMemoryStream();
    const race = () =>
      durableRace<string>([
        function* (): Workflow<string> {
          return yield* ephemeral(
            (function* (): Operation<string> {
              marks.push("winner");
              return "winner";
            })(),
          );
        },
        function* (): Workflow<string> {
          return yield* ephemeral(
            (function* (): Operation<string> {
              marks.push("loser");
              yield* suspend();
              return "never";
            })(),
          );
        },
      ]);

    expect(yield* durableRun(race, { stream })).toBe("winner");
    marks.length = 0;

    // The loser's Close(cancelled) is retained. On replay it suspends and the
    // race cancels it again, exactly as the first run did — it does not resume.
    expect(yield* durableRun(race, { stream })).toBe("winner");
    expect(marks).toEqual([]);
  });

  it("a retained fail-fast sibling still suspends under all()", function* () {
    const marks: string[] = [];
    const stream = new InMemoryStream();
    const both = () =>
      durableAll<string>([
        function* (): Workflow<string> {
          return yield* ephemeral(
            (function* (): Operation<string> {
              marks.push("failing");
              throw new Error("sibling failed");
            })(),
          );
        },
        function* (): Workflow<string> {
          return yield* ephemeral(
            (function* (): Operation<string> {
              marks.push("cancelled sibling");
              yield* suspend();
              return "never";
            })(),
          );
        },
      ]);

    let first: unknown;
    try {
      yield* durableRun(both, { stream });
    } catch (error) {
      first = error;
    }
    expect(first instanceof Error ? first.message : "").toContain("sibling failed");

    marks.length = 0;
    let second: unknown;
    try {
      yield* durableRun(both, { stream });
    } catch (error) {
      second = error;
    }

    expect(second instanceof Error ? second.message : "").toContain("sibling failed");
    // Neither child re-ran: the failure replayed and the sibling suspended.
    expect(marks).toEqual([]);
  });
});

describe("durableSpawn — why a child was cancelled (DEC-040)", () => {
  /** Every cancelled close in a journal, with the reason it recorded. */
  function* cancellations(stream: InMemoryStream): Operation<string[]> {
    const events = yield* stream.readAll();
    return events
      .filter((event) => event.type === "close" && event.result.status === "cancelled")
      .map((event) =>
        event.result.status === "cancelled" ? String(event.result.cancellation) : "",
      );
  }

  it("records a deliberate halt as caller", function* () {
    const stream = new InMemoryStream();

    yield* durableRun(
      function* (): Workflow<string> {
        const task = yield* durableSpawn(function* (): Workflow<string> {
          return yield* ephemeral(
            (function* (): Operation<string> {
              yield* suspend();
              return "never";
            })(),
          );
        });
        yield* ephemeral(
          (function* (): Operation<void> {
            yield* sleep(1);
            yield* task.halt();
          })(),
        );
        return "done";
      },
      { stream },
    );

    expect(yield* cancellations(stream)).toEqual(["caller"]);
  });

  it("records a scope unwinding as unwound", function* () {
    const stream = new InMemoryStream();

    const run = yield* spawn(function* () {
      yield* durableRun(
        function* (): Workflow<string> {
          yield* durableSpawn(function* (): Workflow<string> {
            return yield* ephemeral(
              (function* (): Operation<string> {
                yield* suspend();
                return "never";
              })(),
            );
          });
          yield* ephemeral(
            (function* (): Operation<void> {
              yield* suspend();
            })(),
          );
          return "never";
        },
        { stream },
      );
    });
    yield* sleep(3);
    yield* run.halt();

    expect(yield* cancellations(stream)).toEqual(["unwound"]);
  });

  it("does not revive a child the caller deliberately halted", function* () {
    const marks: string[] = [];
    const stream = new InMemoryStream();
    // The caller halts the child, then the run is interrupted before it
    // completes. Both facts are in the journal; only the first decides.
    const first = yield* spawn(function* () {
      yield* durableRun(
        function* (): Workflow<string> {
          const task = yield* durableSpawn(function* (): Workflow<string> {
            return yield* ephemeral(
              (function* (): Operation<string> {
                marks.push("first life");
                yield* suspend();
                return "never";
              })(),
            );
          });
          yield* ephemeral(
            (function* (): Operation<void> {
              yield* sleep(1);
              yield* task.halt();
              yield* suspend();
            })(),
          );
          return "never";
        },
        { stream },
      );
    });
    yield* sleep(5);
    yield* first.halt();

    expect(marks).toEqual(["first life"]);
    expect(yield* cancellations(stream)).toEqual(["caller"]);

    // The resumed run reaches the same deliberate halt, so the child suspends
    // until it does rather than performing work nobody asked to redo.
    const second = yield* spawn(function* () {
      yield* durableRun(
        function* (): Workflow<string> {
          const task = yield* durableSpawn(function* (): Workflow<string> {
            return yield* ephemeral(
              (function* (): Operation<string> {
                marks.push("revived");
                return "revived";
              })(),
            );
          });
          yield* ephemeral(
            (function* (): Operation<void> {
              yield* sleep(1);
              yield* task.halt();
              yield* suspend();
            })(),
          );
          return "never";
        },
        { stream },
      );
    });
    yield* sleep(10);
    yield* second.halt();

    expect(marks).toEqual(["first life"]);
  });

  it("reads a record with no reason as caller", function* () {
    const marks: string[] = [];
    const stream = new InMemoryStream();
    // A journal written before this evidence existed.
    yield* stream.append({
      type: "close",
      coroutineId: "root.0",
      result: { status: "cancelled" },
    });

    const run = yield* spawn(function* () {
      yield* durableRun(
        function* (): Workflow<string> {
          const task = yield* durableSpawn(function* (): Workflow<string> {
            return yield* ephemeral(
              (function* (): Operation<string> {
                marks.push("would revive");
                return "revived";
              })(),
            );
          });
          return yield* ephemeral(task);
        },
        { stream },
      );
    });
    yield* sleep(10);
    yield* run.halt();

    // Absent evidence is the safe direction: nothing is revived.
    expect(marks).toEqual([]);
  });

  it("keeps combinator children on DEC-024 whatever the reason says", function* () {
    const marks: string[] = [];
    const stream = new InMemoryStream();
    const race = () =>
      durableRace<string>([
        function* (): Workflow<string> {
          return yield* ephemeral(
            (function* (): Operation<string> {
              marks.push("winner");
              return "winner";
            })(),
          );
        },
        function* (): Workflow<string> {
          return yield* ephemeral(
            (function* (): Operation<string> {
              marks.push("loser");
              yield* suspend();
              return "never";
            })(),
          );
        },
      ]);

    expect(yield* durableRun(race, { stream })).toBe("winner");
    // The loser's cancellation is involuntary, so it records `unwound` — and a
    // combinator child suspends regardless of what the reason says.
    expect(yield* cancellations(stream)).toEqual(["unwound"]);

    marks.length = 0;
    expect(yield* durableRun(race, { stream })).toBe("winner");
    expect(marks).toEqual([]);
  });
});
