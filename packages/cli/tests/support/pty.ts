/**
 * A real pty, allocated by whichever allocator this host can drive.
 *
 * Copied rather than imported from `repl-exit-pty.test.ts`, which is where it
 * was written and which still owns its own copy. Two suites need a real
 * terminal for two different promises — one about leaving the screen, one about
 * what an entry retained in a checkout — and neither is a reason to move the
 * other's evidence. The duplication is deliberate and bounded: it is this file
 * and that one, and nothing else reaches for a pty.
 *
 * ## Two pty allocators, because no host has both
 *
 * `script` is the portable one and is what the Linux runners use, but the BSD
 * `script` on macOS refuses to start unless its *own* standard input is a
 * terminal — which a test runner's never is. `tmux` has no such requirement and
 * hands back the rendered screen directly. Either is a real pty with a real
 * window size; whichever this host can drive is the one a row uses, and a host
 * with neither says so rather than passing on nothing.
 */

import { expect } from "@executablemd/test-support/expect";
import { cliRuntime, shellQuote } from "@executablemd/test-support/launch";
import { execFile, spawn as spawnChild } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { ensure, type Operation, scoped, sleep, withResolvers } from "effection";

/** The window the pty is given, which is a size this REPL draws at. */
export const WINDOW = { columns: 160, rows: 36 };

/** What this row printed when it ended, so a status can be read off the screen. */
const SENTINEL = "XMD-PTY-EXIT=";

/**
 * What running one program came to: whether it worked, and everything it said.
 *
 * The whole outcome rather than the output of a successful run, because the
 * allocator's failures are this row's own failures and a row that discards them
 * reports a product defect it has no evidence for. `tmux would not start a
 * session` was all #872 had to go on; tmux had said `server exited unexpectedly`
 * and nothing kept it.
 */
interface Attempt {
  /** The command line, so a report names what was actually run. */
  readonly command: string;
  /** Zero when the program succeeded, and none when it never ran. */
  readonly status: number | undefined;
  /** Everything it wrote to either stream. */
  readonly output: string;
  /** What stopped it before it could run, if anything did. */
  readonly failure: Error | undefined;
  /** It ran, and it succeeded. */
  readonly ok: boolean;
}

/**
 * Run one program and keep its whole outcome.
 *
 * Scoped, so a cancelled probe leaves no client of its own behind: these are
 * short-lived, and a short-lived process is still a process somebody owns.
 */
function* attempted(command: string, args: string[]): Operation<Attempt> {
  return yield* scoped(function* (): Operation<Attempt> {
    const owned = yield* ownedChild(() =>
      spawnChild(command, args, { stdio: ["ignore", "pipe", "pipe"] }),
    );
    // The child's own closing fact, not a second pair of listeners watching for
    // it: one closing per child, removed by the one cleanup that owns it.
    yield* owned.closing;
    const status = owned.child.exitCode;
    const failure = owned.failure();
    return {
      command: [command, ...args].join(" "),
      status: status ?? undefined,
      output: owned.written(),
      failure,
      ok: status === 0 && failure === undefined,
    };
  });
}

/**
 * What an attempt did, in the words of the program that made it.
 *
 * A spawn that never happened and a program that refused are different
 * conditions, and an allocator that cannot be driven has to say which one it
 * met — so both are spelled out here rather than collapsed into a failure.
 */
function described(attempt: Attempt): string {
  const ended =
    attempt.failure !== undefined
      ? `could not be started (${attempt.failure.message})`
      : `exited ${attempt.status ?? "without a status"}`;
  const said = attempt.output.trim();
  return (
    `\`${attempt.command}\` ${ended} and said ` +
    `${said.length === 0 ? "nothing" : JSON.stringify(said)}`
  );
}

/**
 * A child this scope owns, from before it exists until after it has closed.
 *
 * The lifecycle rule this file is about applies to the file itself: a test that
 * proved a command joins what it owns, while leaking the process it proved it
 * with, would be making the rule and breaking it in one row.
 *
 * So the release is registered before the child is spawned — a cancellation
 * between the two must leave nothing running — and on teardown the child is
 * signalled if it is still there and then **waited for**. An assigned exit status
 * is not proof a process closed: `close` is, because it fires once the stdio has
 * gone with it. The handlers are the ones that wait, so they are removed in a
 * synchronous `finally` inside that same cleanup rather than before it.
 */
interface Listening {
  // Loose in the listener's own parameters, so the real `ChildProcess` matches a
  // shape it satisfies: what each event carries is checked where it arrives.
  // oxlint-disable-next-line typescript/no-explicit-any
  on(event: string, listener: (...args: any[]) => void): unknown;
  // oxlint-disable-next-line typescript/no-explicit-any
  off(event: string, listener: (...args: any[]) => void): unknown;
}

interface ChildLike extends Listening {
  // oxlint-disable-next-line typescript/no-explicit-any
  kill(signal?: any): unknown;
  readonly exitCode: number | null;
  readonly signalCode: string | null;
  readonly stdout?: Listening | null;
  readonly stderr?: Listening | null;
}

/** What an owned child offers while it runs. */
interface Owned<T extends ChildLike> {
  readonly child: T;
  /** Everything it has written to either stream. */
  written(): string;
  /** Whether it has closed, as the close event says rather than as a status does. */
  closed(): boolean;
  /**
   * Settles when the child has closed, and only then.
   *
   * Exposed rather than rebuilt by each consumer: there is one closing fact per
   * child, and a second set of listeners watching for it would be a second thing
   * nobody removes.
   */
  readonly closing: Operation<void>;
  /** What the child reported going wrong, if it reported anything. */
  failure(): Error | undefined;
}

function* ownedChild<T extends ChildLike>(start: () => T): Operation<Owned<T>> {
  let child: T | undefined;
  let written = "";
  let gone = false;
  let failure: Error | undefined;
  const closing = withResolvers<void>();
  const onClose = (): void => {
    gone = true;
    closing.resolve();
  };
  // An error is not a close. A child can report one and go on running, and its
  // stdio is still open until `close` says otherwise — so this keeps the error
  // and keeps waiting, because treating it as closure would be joining a process
  // that is still there.
  // oxlint-disable-next-line typescript/no-explicit-any
  const onError = (cause: any): void => {
    failure = failure ?? (cause instanceof Error ? cause : new Error(String(cause)));
  };
  // oxlint-disable-next-line typescript/no-explicit-any
  const collect = (chunk: any): void => {
    written += String(chunk);
  };

  yield* ensure(function* (): Operation<void> {
    const open = child;
    if (open === undefined) {
      return;
    }
    child = undefined;
    try {
      // Decided from the close event, not from a status: a status is assigned
      // when a process exits and says nothing about whether its stdio has gone,
      // and this cleanup is about the child being finished rather than about it
      // having a number.
      if (!gone) {
        open.kill("SIGKILL");
      }
      // Awaited, not signalled and forgotten: until this settles there is still a
      // process holding the pty this row allocated.
      yield* closing.operation;
    } finally {
      // Synchronous, and the same handlers on the same receivers: these are what
      // the wait above was waiting on, so they come off after it and not before.
      open.off("close", onClose);
      open.off("error", onError);
      open.stdout?.off("data", collect);
      open.stderr?.off("data", collect);
    }
  });

  const spawned = start();
  child = spawned;
  spawned.on("close", onClose);
  spawned.on("error", onError);
  spawned.stdout?.on("data", collect);
  spawned.stderr?.on("data", collect);
  return {
    child: spawned,
    written: () => written,
    closed: () => gone,
    closing: closing.operation,
    failure: () => failure,
  };
}

/** One terminal a test owns: what it shows, and how it ended. */
interface Pty {
  /** The screen, one string per row. */
  shows(): Operation<string[]>;
  /** Type these bytes. Nothing closes the input. */
  type(bytes: string): Operation<void>;
  /** The exit status once the command has ended, or none while it runs. */
  status(): Operation<number | undefined>;
}

/**
 * The data root every allocated terminal runs with.
 *
 * Stated here because `allocate()` is what exports it into the shell below, and
 * a caller that needs to find what the command wrote has to look where the
 * command was told to write. On a platform that reads `XDG_DATA_HOME` this is
 * that directory; on one that does not, the product's own resolver ignores it
 * and answers with the platform's place under this same isolated home.
 */
export function terminalDataHome(home: string): string {
  return join(home, "share");
}

/** Whichever allocator this host can drive. */
function* allocate(line: string, home: string): Operation<Pty> {
  // One shell line, run by whichever allocator's own `sh -c`: the data root is
  // isolated so this row cannot read or write the history of whoever ran it, the
  // window is sized *inside* the pty because one allocated by a parent that is
  // not a terminal has no window at all, and the status is printed where it can
  // be read off the screen.
  const inside = [
    `export HOME=${shellQuote(home)}`,
    `export XDG_DATA_HOME=${shellQuote(terminalDataHome(home))}`,
    `stty rows ${WINDOW.rows} cols ${WINDOW.columns}`,
    line,
    `printf '${SENTINEL}%s\\n' "$?"`,
  ].join("; ");

  if ((yield* attempted("tmux", ["-V"])).ok) {
    return yield* tmuxPty(inside, home);
  }
  const flavour = yield* attempted("script", ["--version"]);
  if (flavour.ok && flavour.output.includes("util-linux")) {
    return yield* scriptPty(inside);
  }
  throw new Error(
    "this host can drive neither `tmux` nor util-linux `script`, so the pty this row " +
      "needs cannot be allocated. Install tmux, or run on a host whose `script` does not " +
      "require a terminal of its own.",
  );
}

/**
 * A tmux pane, which is a pty with a window and a screen that can be read.
 *
 * ## A server of this row's own
 *
 * tmux without `-S` is one server per user, shared by every session on the
 * machine — the operator's own windows, the pane-worker proofs, a hand-driven
 * `xmd repl`, and this same row running in another worktree. **That server
 * exits with its last session**, so any one of those parties finishing takes the
 * server down, and a `new-session` that happens to be in that window fails with
 * `server exited unexpectedly` before the product has run. It is intermittent by
 * construction: whether it happens depends on who else was finishing.
 *
 * So this row allocates against a socket inside the temporary home it already
 * owns. Nobody else is on it, which is also why the teardown is `kill-server`:
 * the server belongs to this row, so leaving it running would leak a process,
 * and the socket file — which outlives the server — goes away with the directory
 * holding it. `-f /dev/null` is the same isolation for configuration: a window
 * size or a `default-shell` from whoever's `~/.tmux.conf` is foreign state this
 * row would otherwise be reading.
 */
function* tmuxPty(inside: string, home: string): Operation<Pty> {
  const name = `xmd-pty-${randomBytes(6).toString("hex")}`;
  const socket = join(home, "tmux.sock");
  /** Every tmux invocation for this row's own server, configured by nobody. */
  const control = (...args: string[]): string[] => ["-S", socket, "-f", "/dev/null", ...args];
  // Registered before the server exists, and it waits for the session to be
  // gone rather than for the kill to be accepted: a kill that was sent is not a
  // pane that has closed, and the pty belongs to the pane.
  yield* ensure(function* (): Operation<void> {
    yield* attempted("tmux", control("kill-server"));
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (!(yield* attempted("tmux", control("has-session", "-t", name))).ok) {
        return;
      }
      yield* sleep(50);
    }
    throw new Error(`the tmux session ${name} on ${socket} would not go away`);
  });
  const started = yield* attempted(
    "tmux",
    control(
      "new-session",
      "-d",
      "-s",
      name,
      "-x",
      String(WINDOW.columns),
      "-y",
      String(WINDOW.rows),
      "-c",
      process.cwd(),
      // Held open after the command ends, because tmux takes the pane away with
      // the last process in it — and the status and the printed location are on
      // that pane. The teardown above kills the server either way.
      `${inside}; sleep 300`,
    ),
  );
  if (!started.ok) {
    throw new Error(
      `tmux would not start a session for this row: ${described(started)}. ` +
        // The socket's length because a unix path is capped at 104 bytes and a
        // longer one fails here, which is a condition of this row's own making
        // rather than anything tmux can explain.
        `socket=${socket} (${socket.length} of the 104 bytes a unix socket path may use), ` +
        `session=${name}, window=${WINDOW.columns}x${WINDOW.rows}.`,
    );
  }
  /** The screen, or the reason there is no reading it — never a blank one. */
  function* captured(): Operation<string> {
    const pane = yield* attempted(
      "tmux",
      control("capture-pane", "-p", "-N", "-S", "-200", "-t", name),
    );
    if (!pane.ok) {
      // An unreadable screen used to read as an empty one, which this file then
      // reported as the REPL never drawing. A pane that cannot be captured is a
      // pty that has gone, and that is the fact worth printing.
      throw new Error(`the tmux pane for this row could not be read: ${described(pane)}.`);
    }
    return pane.output;
  }
  return {
    *shows(): Operation<string[]> {
      return (yield* captured()).split("\n");
    },
    *type(bytes: string): Operation<void> {
      // Literal, so what the decoder receives is what a keyboard sends.
      const sent = yield* attempted("tmux", control("send-keys", "-t", name, "-l", "--", bytes));
      if (!sent.ok) {
        // Typing that did not arrive is not typing: without this the row waits
        // out its deadline and blames the REPL for not reacting to a keystroke
        // it never received.
        throw new Error(
          `${JSON.stringify(bytes)} could not be typed into this row: ${described(sent)}.`,
        );
      }
    },
    *status(): Operation<number | undefined> {
      const found = (yield* captured()).match(new RegExp(`${SENTINEL}([0-9]+)`));
      return found === null ? undefined : Number(found[1]);
    },
  };
}

/** A `script` pty, whose screen has to be reassembled from what it wrote. */
function* scriptPty(inside: string): Operation<Pty> {
  const owned = yield* ownedChild(() =>
    spawnChild("script", ["-q", "-c", inside, "/dev/null"], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: process.cwd(),
    }),
  );
  return {
    // deno-lint-ignore require-yield
    *shows(): Operation<string[]> {
      return replayed(owned.written());
    },
    // deno-lint-ignore require-yield
    *type(bytes: string): Operation<void> {
      owned.child.stdin?.write(bytes);
    },
    // deno-lint-ignore require-yield
    *status(): Operation<number | undefined> {
      const found = replayed(owned.written())
        .join("\n")
        .match(new RegExp(`${SENTINEL}([0-9]+)`));
      return found === null ? undefined : Number(found[1]);
    },
  };
}

/**
 * What the terminal shows, by replaying what was written to it.
 *
 * A buffer rather than the bytes with escapes stripped, because this renderer
 * writes *diffs*: it moves the cursor to what changed and writes only that. A
 * focus marker arrives as "go to row 30, column 13, write `>`", so the text a
 * person reads as `> [exit]` is never a run of bytes anybody sent.
 */
function replayed(written: string): string[] {
  const rows: string[][] = [];
  let row = 0;
  let column = 0;
  const put = (character: string): void => {
    while (rows.length <= row) {
      rows.push([]);
    }
    const line = rows[row];
    while (line.length < column) {
      line.push(" ");
    }
    line[column] = character;
    column += 1;
  };
  for (let index = 0; index < written.length; index += 1) {
    const character = written[index];
    if (character !== "\u001B") {
      if (character === "\n") {
        row += 1;
        column = 0;
      } else if (character === "\r") {
        column = 0;
      } else {
        put(character);
      }
      continue;
    }
    const csi = /^\u001B\[([0-9;]*)([@-~])/.exec(written.slice(index));
    if (csi !== null) {
      const parameters = csi[1].split(";").map((one) => (one === "" ? 0 : Number(one)));
      if (csi[2] === "H") {
        row = Math.max(0, (parameters[0] ?? 1) - 1);
        column = Math.max(0, (parameters[1] ?? 1) - 1);
      } else if (csi[2] === "J") {
        rows.length = 0;
        row = 0;
        column = 0;
      }
      index += csi[0].length - 1;
      continue;
    }
    const osc = /^\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/.exec(written.slice(index));
    if (osc !== null) {
      index += osc[0].length - 1;
      continue;
    }
    index += 1;
  }
  return rows.map((line) => line.join(""));
}

/** Wait until the screen shows this text, or say what it shows instead. */
function* showing(pty: Pty, what: string, within: number): Operation<void> {
  const deadline = Date.now() + within;
  while (true) {
    const screen = yield* pty.shows();
    if (screen.some((line) => line.includes(what))) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `the terminal never showed ${what} within ${within}ms. screen=` +
          JSON.stringify(screen.map((line) => line.trimEnd()).filter((line) => line.length > 0)),
      );
    }
    yield* sleep(150);
  }
}

/**
 * Wait until the screen shows this text, wrapped wherever the frame wrapped it.
 *
 * For one case and one reason: a reading's column is narrower than a long
 * unbroken token — a URL, a Git object id — so the frame cuts that token across
 * rows, and the text a document printed is whole on the screen without being
 * whole on any row of it. The single-row question {@link showing} asks is the
 * right one for a label, a control or a status, and it is the wrong one here.
 *
 * What it proves: every non-space character of the expected text, in order,
 * within four adjacent rows of one column. What it gives up: the spacing
 * between words, since a wrap consumes the space it happened at. The rows are
 * rejoined inside their own column — a divider is where one reading ends and
 * the next begins, and joining across one would splice the pane alongside into
 * the middle of the text. It does not give up completeness — an elided
 * row keeps its `…`, so a truncated token still fails here, which is the whole
 * point of asking about a long one.
 */
function* showingAcross(pty: Pty, what: string, within: number): Operation<void> {
  /** The same text with every space taken out of it. */
  const bare = (line: string): string => line.replace(/\s+/g, "");
  const wanted = bare(what);
  const deadline = Date.now() + within;
  while (true) {
    const screen = yield* pty.shows();
    // Column by column, because a divider is where one reading ends and the
    // next begins: rejoining a block's rows across the whole width would
    // splice the pane beside it into the middle of the text being looked for.
    const columns = Math.max(...screen.map((line) => line.split("\u2502").length), 1);
    const joined: string[] = [];
    for (let column = 0; column < columns; column += 1) {
      const own = screen.map((line) => bare(line.split("\u2502")[column] ?? ""));
      // Four, because a token this long is cut at most once in a column this
      // wide and the label before it may sit on its own row above.
      for (let at = 0; at < own.length; at += 1) {
        joined.push(own.slice(at, at + 4).join(""));
      }
    }
    if (joined.some((rows) => rows.includes(wanted))) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `the terminal never showed ${what} within ${within}ms, on one row or across four. ` +
          "screen=" +
          JSON.stringify(screen.map((line) => line.trimEnd()).filter((line) => line.length > 0)),
      );
    }
    yield* sleep(150);
  }
}

/** How this suite names an outcome, and the mark the History rail gives it. */
const RAIL_MARKS: Readonly<Record<string, string>> = Object.freeze({
  ok: "\u2713",
  err: "\u00d7",
  cancelled: "\u002d",
  unfinished: "\u25cf",
});

/**
 * Wait until the History rail says this entry reached this outcome.
 *
 * The rail rather than the Entries catalog. `N. [ok] entry-N` is a row of that
 * catalog, and the catalog is a drawer on this screen — so a journey waiting
 * for one of its rows is waiting for a drawer nobody opened. What every frame
 * draws instead is the compact History band, which carries one mark per entry.
 *
 * Read up to the rule, which is where the rail ends and the sentence beside it
 * begins: a number past that belongs to the sentence and not to an entry.
 */
function* settledEntry(
  pty: Pty,
  order: number,
  outcome: keyof typeof RAIL_MARKS,
  within: number,
): Operation<void> {
  const mark = RAIL_MARKS[outcome];
  const found = new RegExp(`(?:^|\\s)${order}\\s*${mark}`);
  const deadline = Date.now() + within;
  while (true) {
    const screen = yield* pty.shows();
    const railed = screen.some((line) => {
      const at = line.indexOf("HISTORY");
      return at === -1 ? false : found.test(line.slice(at + 7).split("\u2500\u2500")[0] ?? "");
    });
    if (railed) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `the History rail never marked entry ${order} as ${outcome} within ${within}ms. screen=` +
          JSON.stringify(screen.map((line) => line.trimEnd()).filter((line) => line.length > 0)),
      );
    }
    yield* sleep(150);
  }
}

export type { Pty };
export { allocate, settledEntry, showing, showingAcross };
