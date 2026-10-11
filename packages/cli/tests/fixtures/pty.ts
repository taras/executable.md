/**
 * A real pty a suite can drive, and the screen it draws on.
 *
 * Every other piece of REPL evidence injects a terminal, which is what makes it
 * portable and deterministic. Two rows cannot: leaving (`repl-exit-pty`) and the
 * repository journey (`repl-repositories-pty`), because what each one is about
 * lives in the runtime's own reader and in the actual command a person runs.
 *
 * ## Two pty allocators, because no host has both
 *
 * `script` is the portable one and is what the Linux runners use, but the BSD
 * `script` on macOS refuses to start unless its *own* standard input is a
 * terminal — which a test runner's never is. `tmux` has no such requirement and
 * hands back the rendered screen directly. Either is a real pty with a real
 * window size; whichever this host can drive is the one a row uses, and a host
 * with neither says so rather than passing on nothing.
 *
 * This is a fixture rather than part of either suite: the machinery is one
 * subject — allocate a pty, read its screen, type into it, learn how the command
 * ended — and two copies of it would be two accounts of what a terminal is.
 */

import { ensure, scoped, sleep, withResolvers } from "effection";
import type { Operation } from "effection";
import { spawn as spawnChild } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import process from "node:process";
import { cliRuntime, shellQuote } from "@executablemd/test-support/launch";

/** The window the pty is given, which is a size this REPL draws at. */
export const WINDOW = { columns: 160, rows: 36 };

/**
 * How long reaching the screen may take, and how long leaving may take.
 *
 * Two deadlines because they are two claims. Reaching the screen compiles an
 * entrypoint, which is slow and uninteresting. Leaving is the subject: a command
 * that has been told to go and is waiting for a keystroke nobody will press is
 * the defect, and seconds are generous for a teardown that joins what it owns.
 */
export const REACH_MS = 180_000;
export const LEAVE_MS = 20_000;

/**
 * One chunk of typing, long enough that losing its tail would show.
 *
 * Plain characters, so every one of them reaches the draft and is drawn there:
 * what this proves is that a burst arrives whole, not what any key means.
 */
export const BURST = "abcdefghijklmnopqrstuvwxyz0123456789";

/** What this row printed when it ended, so a status can be read off the screen. */
export const SENTINEL = "XMD-PTY-EXIT=";

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
 * The lifecycle claim this file is about applies to the file itself: a test that
 * proved a command joins what it owns, while leaking the process it proved it
 * with, would be making the claim and breaking it in one row.
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

export interface ChildLike extends Listening {
  // oxlint-disable-next-line typescript/no-explicit-any
  kill(signal?: any): unknown;
  readonly exitCode: number | null;
  readonly signalCode: string | null;
  readonly stdout?: Listening | null;
  readonly stderr?: Listening | null;
}

/** What an owned child offers while it runs. */
export interface Owned<T extends ChildLike> {
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

export function* ownedChild<T extends ChildLike>(start: () => T): Operation<Owned<T>> {
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
export interface Pty {
  /** The screen, one string per row. */
  shows(): Operation<string[]>;
  /** Type these bytes. Nothing closes the input. */
  type(bytes: string): Operation<void>;
  /** The exit status once the command has ended, or none while it runs. */
  status(): Operation<number | undefined>;
}

/**
 * The module cache this host has already filled, named for the child.
 *
 * A row like this gives the command a home of its own, which is what keeps its
 * histories and its managed repositories out of the operator's. Deno keeps its
 * module cache under that same home, so the child inherits an *empty* one and
 * re-downloads its whole graph — minutes of registry traffic before the product
 * runs, and nothing at all on a host with no network. Whichever cache this
 * process is using is the one that is already warm, so the child is pointed at
 * it explicitly rather than left to derive one from a home that is a fixture.
 *
 * Asked of `deno` rather than assembled from a platform rule, because the
 * answer is the runtime's and it is already configurable by the operator. A
 * `deno` that will not answer leaves the variable unset, which is the behaviour
 * this had before: slow, but not wrong.
 */
function* moduleCache(): Operation<Readonly<Record<string, string>>> {
  const asked = yield* attempted("deno", ["info", "--json"]);
  if (!asked.ok) {
    return {};
  }
  try {
    const directory: unknown = JSON.parse(asked.output)?.denoDir;
    return typeof directory === "string" && directory.length > 0 ? { DENO_DIR: directory } : {};
  } catch {
    return {};
  }
}

/** Whichever allocator this host can drive. */
export function* allocate(
  line: string,
  home: string,
  cwd: string = process.cwd(),
  // What this row's own world needs the command to be standing in: a `PATH`
  // whose `git` reaches a local remote, a credential, a configured endpoint.
  // Exported inside the pty, beside the data root and the window, because all
  // of it is the same kind of thing — the environment a person's shell would
  // have had.
  environment: Readonly<Record<string, string>> = {},
): Operation<Pty> {
  // One shell line, run by whichever allocator's own `sh -c`: the data root is
  // isolated so this row cannot read or write the history of whoever ran it, the
  // window is sized *inside* the pty because one allocated by a parent that is
  // not a terminal has no window at all, and the status is printed where it can
  // be read off the screen.
  const inside = [
    `export HOME=${shellQuote(home)}`,
    // Before the caller's own exports, so a row that wants to say something
    // else about the cache still can.
    ...Object.entries(yield* moduleCache()).map(
      ([name, value]) => `export ${name}=${shellQuote(value)}`,
    ),
    `export XDG_DATA_HOME=${shellQuote(join(home, "share"))}`,
    ...Object.entries(environment).map(([name, value]) => `export ${name}=${shellQuote(value)}`),
    `stty rows ${WINDOW.rows} cols ${WINDOW.columns}`,
    line,
    `printf '${SENTINEL}%s\\n' "$?"`,
  ].join("; ");

  if ((yield* attempted("tmux", ["-V"])).ok) {
    return yield* tmuxPty(inside, home, cwd);
  }
  const flavour = yield* attempted("script", ["--version"]);
  if (flavour.ok && flavour.output.includes("util-linux")) {
    return yield* scriptPty(inside, cwd);
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
function* tmuxPty(inside: string, home: string, cwd: string): Operation<Pty> {
  const name = `xmd-pty-${randomBytes(6).toString("hex")}`;
  // Short on purpose: a unix socket path may use 104 bytes, this one lives
  // inside a temporary home that is already most of them, and tmux reports the
  // overrun as a connection failure rather than as a name it cannot use.
  const socket = join(home, "t.sock");
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
      cwd,
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
function* scriptPty(inside: string, cwd: string): Operation<Pty> {
  const owned = yield* ownedChild(() =>
    spawnChild("script", ["-q", "-c", inside, "/dev/null"], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd,
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
export function* showing(pty: Pty, what: string, within: number): Operation<void> {
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
 * Reach a control the way a person reaches it: walk the ring until it is marked.
 *
 * Nothing here knows how many stops that takes, which is the point — a row that
 * counted Tabs would be asserting the order of the ring on its way to asserting
 * something else.
 */
export function* reaching(pty: Pty, control: string, within: number): Operation<void> {
  const deadline = Date.now() + within;
  while (!(yield* pty.shows()).some((line) => line.includes(`> ${control}`))) {
    if (Date.now() > deadline) {
      throw new Error(
        `under ${cliRuntime()} focus never reached ${control} within ${within}ms. screen=` +
          JSON.stringify((yield* pty.shows()).map((one) => one.trimEnd())),
      );
    }
    yield* pty.type("\t");
    yield* sleep(300);
  }
}

/**
 * Wait for the command to end, and answer with the status it printed.
 *
 * `because` is the caller's own claim about why ending matters here, printed
 * with the screen: a command that was told to go and did not is a different
 * defect in each row that waits for one, and the deadline cannot say which.
 */
export function* ended(pty: Pty, within: number, because?: string): Operation<number> {
  const deadline = Date.now() + within;
  while (true) {
    const status = yield* pty.status();
    if (status !== undefined) {
      return status;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `under ${cliRuntime()} the command never finished within ${within}ms. ` +
          `${because === undefined ? "" : `${because} `}screen=` +
          JSON.stringify((yield* pty.shows()).map((one) => one.trimEnd())),
      );
    }
    yield* sleep(150);
  }
}
