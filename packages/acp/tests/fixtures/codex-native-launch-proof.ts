/**
 * Issue #755 — the parts of a real Codex launch Markdown cannot observe.
 *
 * `CodexNativeLaunch.test.md` and `CodexZeroNativeTurnExit.test.md` own the
 * sequencing, the gating, the schemas, the assertions and everything an
 * operator reads. This fixture owns only what an authored document cannot
 * reach: a sized pseudo-terminal, child lifecycle, structured route and journal
 * reads, the vendored adapter's own snapshot identity, and exact-path cleanup.
 *
 * What it does not own is the product. The thing under test is the ordinary
 * production command:
 *
 *     dist/xmd run AGENTS.md#Implementor --default-agent codex --journal … --raw
 *
 * run inside a byte-for-byte copy of the repository's own `AGENTS.md` and
 * `.agents/implementor.md`. No role Markdown is built, interpolated or
 * rewritten here — a proof that assembled the document in TypeScript would be
 * proving something nobody runs.
 *
 * Three boundaries keep the evidence honest:
 *
 * - **Nothing provider-private is read.** Every observation comes from a value
 *   this fixture supplied, a process outcome, XMD's own diagnostic journal, the
 *   exact XMD route record for this run's natural key, or the terminal output
 *   of the production command. Nothing beneath `~/.codex` is opened — not
 *   rollouts, not history, not configuration — and `CODEX_HOME` is left exactly
 *   as the operator has it, because relocating it de-authenticates Codex.
 * - **No shim stands in front of the executable.** The Claude proofs put a
 *   recording wrapper on `PATH` to read the native argv. Doing that here would
 *   defeat the thing #755 freezes: the observer canonicalizes and hashes what it
 *   resolves, so a wrapper would bind the session to the wrapper's digest rather
 *   than to the Codex build in the compatibility tuple. The native identity is
 *   established from Codex's own terminal output instead — it prints
 *   `Session ID: <uuid>` as it leaves — which is stronger than an argv anyway: a
 *   picker or `--last` would print a different one.
 * - **Nothing sensitive is rendered.** One filtered JSON verdict reaches stdout:
 *   versions, digests this repository already checks in, the exact identity and
 *   its provenance, booleans, counts, phase and failure classes, usage figures,
 *   and cleanup outcomes. Raw terminal buffers, argv, environment and prepared
 *   instruction text never leave this file.
 *
 * Model turns are the one number nobody may be wrong about, so every one of them
 * is counted at the keystroke or at the record that proves it happened, never
 * summarized on the way out.
 */

import { ensure, main, race, scoped, sleep, until, withResolvers } from "effection";
import type { Operation } from "effection";
import { exists, rm } from "@effectionx/fs";
import { spawn as spawnChild } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readdir, readFile, realpath } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { createEmbeddedAdapters, embeddedAdapterIdentities } from "../../src/adapter-snapshots.ts";
import { ADVERTISED_NATIVE_LAUNCH } from "../../src/native-launch.ts";
import { agentSessionKeyDigest } from "@executablemd/runtime";
import type { AnswerQuestion, ScreenSnapshot, TerminalReader } from "./terminal-screen.ts";
import {
  presentedDuring,
  terminalChannels,
  terminalReader,
  waitForPresented,
} from "./terminal-screen.ts";
import type { StallClassification, SubmissionPort, SurfacePort } from "./codex-surfaces.ts";
import type { SubmissionRefusal } from "./codex-surfaces.ts";
import {
  classifyInitialSurface,
  classifyStall,
  reachComposer,
  refusalDetail,
  SCREEN_CHROME,
  submitWhenReady,
} from "./codex-surfaces.ts";

/** Opting in at all. Absent, every mode refuses before a Codex process. */
const PROOF_ENV = "XMD_CODEX_NATIVE_PROOF";
/** The separate, exact grant a mode that spends model turns needs. */
const TURNS_ENV = "XMD_CODEX_MODEL_TURNS_AUTHORIZED";

/** The production target, exactly as an operator would type it. */
const TARGET = "AGENTS.md#Implementor";

/** The document that reattaches to the launched session through ACP. */
const ACP_DOCUMENT = fileURLToPath(new URL("./codex-native-to-acp-prompt.md", import.meta.url));

/**
 * The compatibility point these journeys are only meaningful against
 * (`issue-755-codex-materialization-turn-implementor-handoff.md`).
 *
 * Frozen rather than read from the machine, because the whole claim is that one
 * exact build was proven. A run against another build is not a weaker pass; it
 * is a different question, and it says so.
 */
const REQUIRED_PLATFORM = "darwin";
const REQUIRED_ARCHITECTURE = "arm64";
const REQUIRED_CODEX_VERSION = "codex-cli 0.153.2";
const REQUIRED_CODEX_DIGEST = "195ace4100a634a9df39147f493e730e666b5bd87795f3c9f3251d8542400424";
const REQUIRED_ADAPTER_PACKAGE = "@agentclientprotocol/codex-acp";
const REQUIRED_ADAPTER_VERSION = "1.6.2";
const REQUIRED_ADAPTER_DIGEST = "3ee22bc6b1649d02fcef80b352516f395fe774e63b459193195a41c42930dd8b";

/** The one prompt version a Codex launch may spend a turn on. */
const PROMPT_VERSION = "codex-materialization.v1";

/**
 * The role contract's opening sentence.
 *
 * Never sent to the model. It reaches the session only as the prepared
 * instruction layer the launch installed, so a native answer carrying it is
 * evidence the layer governed that turn — evidence that needs no test-only token
 * planted in a production role document.
 */
const OPENING_SENTENCE = "The Implementor delivers an accepted plan as a focused, verified change.";

/** What a recovered marker has to be wrapped in, so a repaint cannot supply it. */
const RECALL_PREFIX = "RECOVERED-";

/** Rendered-output markers: one per role section, each unique to its section. */
const IMPLEMENTOR_MARKER = "Running this target prepares the session";
const SIBLING_MARKERS: readonly string[] = [
  ".agents/planner.md",
  ".agents/architect.md",
  "It has no contract document of its own",
];

const ENTER = "\r";
const INTERRUPT = "\u0003";
/** Two interrupts: the first asks the TUI to leave, the second insists. */
const EXIT_CONTROL_BYTES = "0303";

/**
 * How the one dialog Codex may put in front of a session is answered.
 *
 * It is not a conversation. It asks the person at the terminal for a standing
 * permission — may Codex load project-local configuration from this directory —
 * reaches no model and creates no user turn, so answering it is terminal control
 * and is reported on its own channel. The answer is the pre-selected
 * `1. Yes, continue` the dialog itself offers.
 */
const TRUST_SURFACE = "directory-trust";
const TRUST_BYTES = "0d";

/** What Codex prints as it leaves, naming the conversation it was in. */
const SESSION_ID_LINE = /Session ID:\s*([0-9a-fA-F-]{36})/u;

/** What XMD says on the terminal before it spends the reader's model turn. */
const NOTICE_BEFORE = "spending one model turn in session";
/** And what it says once that turn has been spent. */
const NOTICE_AFTER = "materialization turn completed in";

/**
 * Environment names an enclosing coding-agent session exports.
 *
 * A proof that runs inside one inherits them, and a provider behaves
 * differently when it does. `CODEX_PATH` in particular is the variable XMD's own
 * binding sets for the adapter child, so inheriting one would let this process
 * choose the build the product is supposed to resolve for itself.
 */
function inheritedAgentMarker(name: string): boolean {
  return (
    name === "CLAUDECODE" ||
    name === "CLAUDE_PID" ||
    name === "CLAUDE_EFFORT" ||
    name.startsWith("CLAUDE_CODE_") ||
    name.startsWith("CODEX_")
  );
}

/** Every phase is bounded on its own, well inside the document's block timeout. */
const VERSION_MS = 30_000;
const SURFACE_MS = 240_000;
/**
 * How long one native answer is waited for.
 *
 * Twice the Claude proof's bound, because two Codex answers reached that one and
 * the second was still showing a working state when the classifier read the
 * screen afterwards. A bound is not a claim about the product: reaching it says
 * this harness stopped waiting, and `answerSurface` says what was on screen.
 */
const ANSWER_MS = 600_000;
const SETTLE_MS = 120_000;
const DELETE_MS = 60_000;
const ADAPTER_MS = 120_000;
/** How long a surface is given to settle before a key is sent into it. */
const SETTLE_DELAY_MS = 3_000;

/**
 * How long the composer is given to turn out to have a dialog over it.
 *
 * Codex draws the composer first and the trust dialog over it, so a reader that
 * stops at the composer stops in front of a question nobody answered. This is
 * the window in which that turns out to be what happened.
 */
const TRUST_GRACE_MS = 20_000;

/** The pseudo-terminal's size. A zero-column terminal draws no TUI at all. */
const PTY_ROWS = 40;
const PTY_COLUMNS = 120;

type Mode = "preflight" | "zero-native-turn" | "native-launch";

/**
 * The exact model-turn budget each mode may spend, and the value its grant must
 * carry.
 *
 * `zero-native-turn` spends the one XMD-owned materialization turn and no native
 * user turn — which is what "zero native turn" names. `native-launch` spends
 * that one, plus the first native user turn, plus the ACP turn that asks the
 * reattached session what the native turn said.
 */
const AUTHORIZED_TURNS: Readonly<Record<Mode, string>> = {
  preflight: "0",
  "zero-native-turn": "1",
  "native-launch": "3",
};

/**
 * `UNDECIDED` is the state a journey starts in and never ends in: it says the
 * body classified nothing, which is the one state a decider may speak from. It
 * is a distinct value rather than a reused failure so that a body which does
 * classify — including one reporting that this harness stopped waiting — is not
 * mistaken for one that stayed silent and then overruled.
 */
type Verdict =
  | "UNDECIDED"
  | "PASS"
  | "REFUSED"
  | "ENVIRONMENT_BLOCKED"
  | "PRODUCT_FAILED"
  | "HARNESS_FAILED";

class PhaseTimeout extends Error {
  override name = "PhaseTimeout";
  constructor(readonly phase: string) {
    super(`phase "${phase}" exceeded its bound`);
  }
}

/** Run `op` under a bound. The loser is halted with the surrounding scope. */
function* bounded<T>(phase: string, ms: number, op: () => Operation<T>): Operation<T> {
  const outcome = yield* race([
    (function* (): Operation<{ done: true; value: T }> {
      return { done: true, value: yield* op() };
    })(),
    (function* (): Operation<{ done: false }> {
      yield* sleep(ms);
      return { done: false };
    })(),
  ]);
  if (!outcome.done) {
    throw new PhaseTimeout(phase);
  }
  return outcome.value;
}

/** A fixed-category description carrying no path, credential or transcript. */
function classify(error: unknown): string {
  if (error instanceof PhaseTimeout) {
    return `timeout in ${error.phase}`;
  }
  if (error instanceof Error) {
    return error.name;
  }
  return "unknown";
}

function isReachable(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killed(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone, which is the state this was asking for.
  }
}

function interrupted(pid: number): void {
  try {
    process.kill(pid, "SIGINT");
  } catch {
    // Already gone.
  }
}

const TEARDOWN_GRACE_MS = 8_000;

function settledWithin(pid: number, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const started = Date.now();
    const poll = () => {
      if (!isReachable(pid) || Date.now() - started >= ms) {
        resolve();
        return;
      }
      setTimeout(poll, 100);
    };
    poll();
  });
}

/** Collapse every run of whitespace, so a TUI's own layout cannot hide a word. */
function squeeze(text: string): string {
  return text.replaceAll(/\s+/gu, "");
}

const CONTROL_SEQUENCE =
  // deno-lint-ignore no-control-regex
  /\x1B\[[0-9;?]*[ -\/]*[@-~]|\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)|\x1B[()][B0]|\x1B[<>=]|[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/gu;

/**
 * The glyphs a TUI draws its frame out of.
 *
 * Codex wraps a long answer inside a bordered pane, so a sentence can arrive
 * with a border between two of its words. No model emits these mid-sentence,
 * so removing them recovers the text without letting anything else through.
 */
const FRAME_GLYPH = /[─-╿▀-▟]/gu;

function readable(text: string): string {
  return text.replaceAll(CONTROL_SEQUENCE, "").replaceAll(FRAME_GLYPH, "");
}

/** Whether `text` shows `marker`, ignoring the layout a TUI drew around it. */
function shows(text: string, marker: string): boolean {
  return squeeze(readable(text)).includes(squeeze(marker));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface ChildOutcome {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
}

/** Every child a mode started, so cleanup can prove none outlived it. */
type LiveSet = Set<number>;

/** Run one captured child to settlement. Never a TUI. */
function runChild(
  command: string,
  args: string[],
  options: { cwd: string; input?: string; live: LiveSet; env?: Record<string, string> },
): Operation<ChildOutcome> {
  return (function* (): Operation<ChildOutcome> {
    const settled = withResolvers<ChildOutcome>();
    const failed = withResolvers<never>();
    let child: ChildProcess | undefined;

    // Registered before the spawn: a halt between acquiring a process and
    // registering its cleanup leaks the process.
    yield* ensure(() => {
      const running = child;
      if (!running?.pid) {
        return;
      }
      if (running.exitCode === null && running.signalCode === null) {
        killed(running.pid);
      }
      options.live.delete(running.pid);
    });

    child = spawnChild(command, args, {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      ...(options.env === undefined ? {} : { env: options.env }),
    });
    if (child.pid) {
      options.live.add(child.pid);
    }
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once("error", (error: Error) => failed.reject(error));
    child.once("close", (code: number | null, signal: string | null) => {
      if (child?.pid) {
        options.live.delete(child.pid);
      }
      settled.resolve({ code, signal, stdout, stderr });
    });

    if (options.input !== undefined) {
      child.stdin?.write(options.input);
    }
    child.stdin?.end();

    return yield* race([settled.operation, failed.operation]);
  })();
}

/**
 * A path this fixture may write into a generated shell command.
 *
 * Everything here is built from `tmpdir()`, the repository root and a UUID, so
 * this can only fail if one of them holds a quote or a newline. Refusing is the
 * only safe answer: a command assembled around one would run something else.
 */
function literal(path: string): string {
  if (/['\n\r]/u.test(path)) {
    throw new Error("a fixture path holds a character a shell command cannot carry safely");
  }
  return `'${path}'`;
}

/**
 * One production command running under a sized pseudo-terminal.
 *
 * `<Session.Launch>` takes the run's foreground-terminal lease and refuses a
 * host with no terminal, which is what a real operator gets and the reason this
 * cannot be a piped child. `/usr/bin/script` is the terminal boundary, so no PTY
 * dependency is added for a test.
 *
 * The size is set inside the pty and not by an environment variable, because a
 * TUI asks the terminal rather than the environment. `script` leaves a pty at
 * zero columns, and Codex draws nothing at all into one — a proof reading that
 * empty screen would conclude the surface never appeared.
 */
interface Pty {
  /**
   * Wait until output arriving *since the last handled surface* satisfies
   * `predicate`, then mark it handled.
   *
   * Windowed on purpose: a dialog that has already been answered stays in the
   * buffer, and re-reading it would answer it twice.
   */
  waitForAny(
    name: string,
    ms: number,
    tags: readonly { tag: string; marker: string }[],
  ): Operation<string>;
  /**
   * Wait until the reconstructed screen is showing the expected answer.
   *
   * Separate from {@link waitForAny} because an answer is not a surface
   * appearing in the byte stream. Codex addresses the cursor: it wraps, erases
   * and redraws what it has already drawn, so the expectation can arrive split
   * across rows, or be moved somewhere else by a later repaint, and the bytes
   * retain text that is no longer on the screen at all. The bytes are applied to
   * a terminal here and the terminal is what gets read.
   *
   * Available only to a run that submits a turn. A run that spoke none has no
   * reply to attribute, and its reader refuses to be asked for one.
   */
  waitForAnswer(ms: number, question: AnswerQuestion): Operation<void>;
  /**
   * Wait until what the terminal is *showing* satisfies `predicate`, and answer
   * with the frame that did.
   *
   * The stream answers a different question than the screen does, and every
   * surface decision is a question about the screen: bytes that drew a composer
   * are retained after a dialog was drawn over it, bytes that drew a refusal are
   * retained after a repaint wiped it, and a frame held back by `CSI ?2026h` has
   * arrived without having been shown to anybody.
   *
   * The frames rather than a flag, because one `data` event from the pty applies
   * every frame its bytes finished before anybody out here is woken. A caller
   * told only that a surface arrived would look at the screen and find whatever
   * that read ended on, which for a refusal Codex repaints over is a composer.
   *
   * Every frame that matched rather than the first, because a wait is answered
   * by a read and not by a frame: what satisfied it first is one of the things
   * that read presented, and the caller is the only thing that knows which of
   * them it was actually asking about.
   *
   * Empty when the bound is spent, because a surface that never arrived is
   * something to report rather than an error.
   */
  waitForScreen(
    name: string,
    ms: number,
    predicate: (snapshot: ScreenSnapshot) => boolean,
  ): Operation<readonly ScreenSnapshot[]>;
  /**
   * Wait out a fixed delay, and answer with what was presented during it.
   *
   * Nothing shortens it — that is what makes it a delay rather than a wait — but
   * the terminal does not stop drawing because a driver has stopped looking, so
   * the same answer a wait gives is owed here too. A caller reading the screen
   * once the delay is out is asking what survived it, which is a different
   * question from what happened during it.
   */
  pause(
    ms: number,
    predicate: (snapshot: ScreenSnapshot) => boolean,
  ): Operation<readonly ScreenSnapshot[]>;
  /** Whether everything seen so far contains `marker`, layout ignored. */
  saw(marker: string): boolean;
  /** The first match of `pattern` anywhere in what has been drawn. */
  captured(pattern: RegExp): string;
  /** What the terminal last presented. Never a frame still being drawn. */
  screen(): ScreenSnapshot;
  /** Write terminal-control bytes — never conversation. */
  control(bytes: string): void;
  /**
   * Type one conversation turn, without sending it.
   *
   * Separate from `send()` because a TUI reads text and a newline arriving
   * together as a pasted line rather than as a submitted one — the newline lands
   * in the box and nothing is sent.
   */
  type(text: string): void;
  /** Press Enter. Charged here: this is the keystroke that spends the turn. */
  send(typed: string): void;
  /** Wait for the process to leave. */
  settle(ms: number): Operation<void>;
  exitCode(): number;
}

/**
 * The three input channels, kept apart because they mean different things —
 * and each recorded at the moment it is written.
 *
 * These are callbacks rather than counters a caller reads afterwards, because
 * the phase that sends a turn is also the phase that can time out. A run that
 * spent a turn and then hung must still report the turn.
 */
interface PtyChannels {
  /** One conversation turn was submitted: this many bytes, and one turn. */
  charged(bytes: number): void;
  /** A consent dialog was answered with these bytes. Never a conversation. */
  consented(surface: string, bytes: string): void;
  /** Exit control was sent. */
  exited(bytes: string): void;
}

function ptyRun<T>(
  command: string,
  args: string[],
  options: {
    cwd: string;
    env: Record<string, string>;
    live: LiveSet;
    channels: PtyChannels;
    /**
     * The terminal this run draws on, supplied by its caller.
     *
     * Every run gets one, because every run decides which surface it is looking
     * at and that is a fact about the screen rather than about the bytes.
     * Whether it also watches for an answer is stated at the call site, so a
     * reply can only be attributed by a run that submitted a turn.
     */
    reader: TerminalReader;
  },
  body: (pty: Pty) => Operation<T>,
): Operation<T> {
  return scoped(function* (): Operation<T> {
    const settled = withResolvers<void>();
    const failed = withResolvers<never>();
    let child: ChildProcess | undefined;
    let text = "";
    let consumed = 0;
    let code = -1;
    // The waiter reports which tag it saw rather than only that it saw one, so
    // the tag it answers with is the one the screen actually showed.
    let pending:
      | { match: (fresh: string) => string | undefined; resolve: (tag: string) => void }
      | undefined;
    let answered: (() => void) | undefined;

    // Interrupt, then insist. A harness that reaches straight for SIGKILL takes
    // away the product's chance to retain its own exit and then reports what it
    // stranded as a product failure.
    yield* ensure(function* () {
      const running = child;
      if (!running?.pid) {
        return;
      }
      if (running.exitCode === null && running.signalCode === null) {
        interrupted(running.pid);
        yield* until(settledWithin(running.pid, TEARDOWN_GRACE_MS));
        if (isReachable(running.pid)) {
          killed(running.pid);
        }
      }
      options.live.delete(running.pid);
    });

    const line = [
      `stty rows ${PTY_ROWS} columns ${PTY_COLUMNS}`,
      `exec ${[command, ...args].map(literal).join(" ")}`,
    ].join("; ");
    child = spawnChild("/usr/bin/script", ["-q", "/dev/null", "/bin/sh", "-c", line], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (child.pid) {
      options.live.add(child.pid);
    }

    // Everything the run said, whichever channel said it. Surface detection
    // reads this, because a surface arriving is a thing the stream says.
    const record = (chunk: string | Uint8Array) => {
      text += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      const waiter = pending;
      if (!waiter) {
        return;
      }
      const tag = waiter.match(text.slice(consumed));
      if (tag === undefined) {
        return;
      }
      pending = undefined;
      consumed = text.length;
      waiter.resolve(tag);
    };
    const channels = terminalChannels(record, options.reader);

    // Only stdout went through the pty, so only stdout is what the terminal
    // showed. `script` and the shell beneath it report their own troubles on
    // stderr, which reached this process without ever being displayed —
    // evidence about the run, and not a thing anybody could have read on screen.
    // Screen waits are woken from inside the reader, at the commit that answered
    // them, rather than out here once a whole read has been applied. Where a
    // read carried several finished frames, out here is too late to tell them
    // apart: only the last one is still on the screen.
    child.stdout?.on("data", (chunk: Buffer) => {
      if (channels.display(chunk) && answered !== undefined) {
        const resolve = answered;
        answered = undefined;
        resolve();
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      channels.diagnostic(chunk);
    });
    child.once("error", (error: Error) => failed.reject(error));
    child.once("close", (status: number | null) => {
      code = status ?? -1;
      if (child?.pid) {
        options.live.delete(child.pid);
      }
      settled.resolve();
    });

    const write = (bytes: string) => {
      // Everything already on screen belongs to the surface being answered, so
      // the next wait reads only what this write provoked.
      consumed = text.length;
      child?.stdin?.write(bytes);
    };

    const pty: Pty = {
      waitForAny(name, ms, tags) {
        return bounded(name, ms, function* (): Operation<string> {
          const match = (fresh: string): string | undefined =>
            tags.find((entry) => shows(fresh, entry.marker))?.tag;
          const already = match(text.slice(consumed));
          if (already !== undefined) {
            consumed = text.length;
            return already;
          }
          const waiter = withResolvers<string>();
          pending = { match, resolve: waiter.resolve };
          return yield* race([waiter.operation, failed.operation]);
        });
      },
      waitForAnswer(ms, question) {
        return bounded("answer", ms, function* (): Operation<void> {
          // Arming answers against what is already showing, because the reply
          // can be complete before this is reached and no further byte arrive.
          // A reader that is not watching refuses the question outright.
          if (options.reader.ask(question)) {
            return;
          }
          const waiter = withResolvers<void>();
          answered = waiter.resolve;
          yield* race([waiter.operation, failed.operation]);
        });
      },
      waitForScreen(name, ms, predicate) {
        return waitForPresented(options.reader, predicate, function* (wait): Operation<void> {
          try {
            yield* bounded(name, ms, () => race([wait.matched, failed.operation]));
          } catch (error) {
            if (!(error instanceof PhaseTimeout)) {
              throw error;
            }
            // A bound that ran out is a surface that never arrived, which the
            // caller reports rather than raises.
          }
        });
      },
      pause(ms, predicate) {
        return presentedDuring(options.reader, predicate, sleep(ms));
      },
      saw(marker) {
        return shows(text, marker);
      },
      captured(pattern) {
        return readable(text).match(pattern)?.[1] ?? "";
      },
      screen() {
        return options.reader.snapshot();
      },
      control(bytes) {
        write(bytes);
      },
      type(spoken) {
        write(spoken);
      },
      send(typed) {
        // Charged before the write returns, so an answer that never arrives
        // cannot make this look like a turn nobody spent.
        options.channels.charged(Buffer.byteLength(`${typed}${ENTER}`, "utf8"));
        write(ENTER);
      },
      settle(ms) {
        return bounded("settle", ms, () => race([settled.operation, failed.operation]));
      },
      exitCode: () => code,
    };

    return yield* body(pty);
  });
}

/** One journey's owned paths. Every removal below names an exact one. */
interface Journey {
  root: string;
  /** Canonical, because a launch records the directory it resolved. */
  project: string;
  journals: [string, string, string];
  live: LiveSet;
  codex: string;
  /** Every native identity this journey caused to exist, for exact deletion. */
  created: Set<string>;
}

interface CleanupReport {
  liveChildren: number;
  journalsRemoved: boolean;
  routeRecordsRemoved: boolean;
  sessionDeleteOutcome: string;
  temporaryRootRemoved: boolean;
}

/** What one production invocation established. */
interface InvocationOutcome {
  exitCode: number;
  refused: boolean;
  reachedSurface: boolean;
  answered: boolean;
  /**
   * What a turn without an answer was showing, and what that makes the run.
   *
   * Read off the presented screen by {@link classifyStall} and kept whole. The
   * verdict travels with the tag rather than being derived from it later,
   * because a tag alone is a label this fixture could have written down itself.
   */
  answerStall: StallClassification | undefined;
  /**
   * Why no turn was submitted, when none was.
   *
   * Set only by a run that reached the composer and then declined to type into
   * it or to press Enter. It is the state that keeps a readiness failure from
   * being read as an answer that never came: nothing was asked, so nothing
   * about the product was established and nothing was charged.
   */
  submissionRefusal: SubmissionRefusal | undefined;
  /** The identity Codex named as it left, from its own output. */
  leftSessionId: string;
  noticedBeforeSpending: boolean;
  noticedAfterSpending: boolean;
}

interface TurnPlan {
  /** What to say once the composer is ready, or nothing at all. */
  say?: string;
  /** What proves the answer arrived. */
  expect?: string;
}

/** The one verdict shape every mode renders, exactly. */
interface JourneyVerdict {
  mode: string;
  verdict: Verdict;
  authorized: boolean;
  turnsAuthorized: boolean;
  authorizedTurnBudget: number;
  ran: boolean;
  refusal: string;
  detail: string;

  codexVersion: string;
  codexDigest: string;
  platform: string;
  architecture: string;
  adapterPackage: string;
  adapterVersion: string;
  adapterDigest: string;
  compatibilityTupleFrozen: boolean;

  target: string;
  projectCopyVerified: boolean;
  implementorMarkerRendered: boolean;
  siblingMarkersRendered: number;

  nativeSessionId: string;
  identityProvenance: string;
  reentryNativeSessionId: string;
  substitutedIdentity: boolean;
  routeConverted: boolean;

  firstXmdExitCode: number;
  secondXmdExitCode: number;
  instructionChannel: string;

  /** Every model turn this journey caused, however it was caused. */
  modelTurns: number;
  materializationTurns: number;
  nativeUserTurns: number;
  acpReattachTurns: number;
  /** How many of this journey's invocations reconstructed a terminal at all. */
  answerObserverInvocations: number;
  conversationInputByteCount: number;
  consentInputBytes: string;
  consentSurfaces: string[];
  exitControlBytes: string;
  reentryConsentInputBytes: string;
  reentryConsentSurfaces: string[];
  reentryExitControlBytes: string;
  inheritedAgentMarkersRemoved: number;

  noticedBeforeSpending: boolean;
  noticedAfterSpending: boolean;
  openingSentenceExact: boolean;
  markerRecovered: boolean;
  acpDocumentCarriesMarker: boolean;
  answerSurface: string;
  outcome: string;

  materialization: {
    promptVersion: string;
    requestIdStable: boolean;
    promptExact: boolean;
    turnNamed: boolean;
    turnProvider: string;
    durationReported: boolean;
    responsePresent: boolean;
    stopReason: string;
    reportedUsageFields: string[];
    unreportedUsageFields: string[];
    failureClasses: string[];
  };
  route: {
    kind: string;
    provider: string;
    buildVersion: string;
    buildDigest: string;
  };
  journal: {
    provider: string;
    agent: string;
    launcher: string;
    provenance: string;
    nativeSessionId: string;
    cwdIsProject: boolean;
    sessionState: string[];
    instructionsDigestPresent: boolean;
    firstPhases: string[];
    secondPhases: string[];
    failureClasses: string[];
  };
  cleanup: CleanupReport;
  privateStateInspected: boolean;
}

function blankJourney(mode: Mode): JourneyVerdict {
  return {
    mode,
    verdict: "UNDECIDED",
    authorized: false,
    turnsAuthorized: false,
    authorizedTurnBudget: Number(AUTHORIZED_TURNS[mode]),
    ran: false,
    refusal: "",
    detail: "the journey did not reach a verdict",
    codexVersion: "",
    codexDigest: "",
    platform: process.platform,
    architecture: process.arch,
    adapterPackage: "",
    adapterVersion: "",
    adapterDigest: "",
    compatibilityTupleFrozen: false,
    target: TARGET,
    projectCopyVerified: false,
    implementorMarkerRendered: false,
    siblingMarkersRendered: 0,
    nativeSessionId: "",
    identityProvenance: "",
    reentryNativeSessionId: "",
    substitutedIdentity: false,
    routeConverted: false,
    firstXmdExitCode: -1,
    secondXmdExitCode: -1,
    instructionChannel: "",
    modelTurns: 0,
    materializationTurns: 0,
    nativeUserTurns: 0,
    acpReattachTurns: 0,
    answerObserverInvocations: 0,
    conversationInputByteCount: 0,
    consentInputBytes: "",
    consentSurfaces: [],
    exitControlBytes: "",
    reentryConsentInputBytes: "",
    reentryConsentSurfaces: [],
    reentryExitControlBytes: "",
    inheritedAgentMarkersRemoved: 0,
    noticedBeforeSpending: false,
    noticedAfterSpending: false,
    openingSentenceExact: false,
    markerRecovered: false,
    acpDocumentCarriesMarker: false,
    answerSurface: "",
    outcome: "unresolved",
    materialization: {
      promptVersion: "",
      requestIdStable: false,
      promptExact: false,
      turnNamed: false,
      turnProvider: "",
      durationReported: false,
      responsePresent: false,
      stopReason: "",
      reportedUsageFields: [],
      unreportedUsageFields: [],
      failureClasses: [],
    },
    route: {
      kind: "",
      provider: "",
      buildVersion: "",
      buildDigest: "",
    },
    journal: {
      provider: "",
      agent: "",
      launcher: "",
      provenance: "",
      nativeSessionId: "",
      cwdIsProject: false,
      sessionState: [],
      instructionsDigestPresent: false,
      firstPhases: [],
      secondPhases: [],
      failureClasses: [],
    },
    cleanup: {
      liveChildren: 0,
      journalsRemoved: false,
      routeRecordsRemoved: false,
      sessionDeleteOutcome: "nothing-to-delete",
      temporaryRootRemoved: false,
    },
    privateStateInspected: false,
  };
}

const REPO_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
const XMD_BINARY = join(REPO_ROOT, "dist", "xmd");
const SESSION_COORDINATOR_ROOT = join(homedir(), ".acpx", "xmd-native-sessions", "v1");
/** Where the binary under proof materializes the adapters it carries. */
const ADAPTER_ROOT = join(homedir(), ".xmd", "adapters");

/**
 * The exact absolute paths one natural key owns, and nothing else.
 *
 * The natural key includes the agent command, and for a launch through this
 * build's own adapter that is the embedded snapshot's command line — settled by
 * the bytes the build carries, beneath the root the binary uses, so it is
 * knowable here without opening anything. Deriving it through the product's own
 * digest rather than searching for a record that matches means this reads only
 * the three files this journey's key owns, and never another key's.
 */
function keyPaths(sessionKey: string): string[] {
  const agent = createEmbeddedAdapters(ADAPTER_ROOT).command("codex");
  const digest = agentSessionKeyDigest({ provider: "acpx", agent, sessionKey });
  return [
    join(SESSION_COORDINATOR_ROOT, "routes", `${digest}.json`),
    join(SESSION_COORDINATOR_ROOT, "ownership", `${digest}.json`),
    join(SESSION_COORDINATOR_ROOT, "leases", `${digest}.lease`),
  ];
}

interface LaunchRecord {
  phase: string;
  agent?: string;
  sessionKey?: string;
  provider?: string;
  nativeSessionId?: string;
  sessionState?: string;
  instructionChannel?: string;
  identityProvenance?: string;
  instructionsDigest?: string;
  instructions?: string;
  cwd?: string;
  launcher?: string;
  executableBinding?: {
    reportedVersion?: string;
    executableDigest?: { value?: string };
  };
  materialization?: { promptVersion?: string; requestId?: string; prompt?: string };
  promptVersion?: string;
  requestId?: string;
  turn?: { provider?: string; kind?: string; value?: string };
  durationMs?: number;
  usage?: Record<string, unknown>;
  response?: string;
  stopReason?: string;
  failure?: { class?: string };
}

/** A member of an untrusted record, kept only if it is already text. */
function textOf(source: Record<string, unknown>, member: string): string | undefined {
  const value = source[member];
  return typeof value === "string" ? value : undefined;
}

/** The same for a member that is itself read through its own members. */
function recordOf(
  source: Record<string, unknown>,
  member: string,
): Record<string, unknown> | undefined {
  const value = source[member];
  return isRecord(value) ? value : undefined;
}

/**
 * One launch record, read out of a journal this fixture did not write.
 *
 * Every member is taken at the type a verdict reads it at and dropped
 * otherwise, so a journal line that carries the wrong shape reaches a verdict
 * as an absent member rather than as a value of a type it never held.
 */
function parseLaunchRecord(source: Record<string, unknown>): LaunchRecord | undefined {
  const phase = textOf(source, "phase");
  if (phase === undefined) {
    return undefined;
  }
  const materialization = recordOf(source, "materialization");
  const turn = recordOf(source, "turn");
  const failure = recordOf(source, "failure");
  const durationMs = source["durationMs"];
  return {
    phase,
    agent: textOf(source, "agent"),
    sessionKey: textOf(source, "sessionKey"),
    provider: textOf(source, "provider"),
    nativeSessionId: textOf(source, "nativeSessionId"),
    sessionState: textOf(source, "sessionState"),
    instructionChannel: textOf(source, "instructionChannel"),
    identityProvenance: textOf(source, "identityProvenance"),
    instructionsDigest: textOf(source, "instructionsDigest"),
    instructions: textOf(source, "instructions"),
    cwd: textOf(source, "cwd"),
    launcher: textOf(source, "launcher"),
    promptVersion: textOf(source, "promptVersion"),
    requestId: textOf(source, "requestId"),
    response: textOf(source, "response"),
    stopReason: textOf(source, "stopReason"),
    durationMs: typeof durationMs === "number" ? durationMs : undefined,
    usage: recordOf(source, "usage"),
    materialization: materialization && {
      promptVersion: textOf(materialization, "promptVersion"),
      requestId: textOf(materialization, "requestId"),
      prompt: textOf(materialization, "prompt"),
    },
    turn: turn && {
      provider: textOf(turn, "provider"),
      kind: textOf(turn, "kind"),
      value: textOf(turn, "value"),
    },
    failure: failure && { class: textOf(failure, "class") },
  };
}

/**
 * The launch records one diagnostic journal holds, in order.
 *
 * A retained preparation carries the prepared instruction text, so this reads it
 * and nothing that reaches a verdict repeats it: what crosses out of here is
 * whether a digest exists, never the text or the digest's own bytes.
 */
function* readLaunchRecords(path: string): Operation<LaunchRecord[]> {
  if (!(yield* exists(path))) {
    return [];
  }
  const text = yield* until(readFile(path, "utf8"));
  const records: LaunchRecord[] = [];
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) {
      continue;
    }
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(event) || event.type !== "yield" || !isRecord(event.description)) {
      continue;
    }
    if (event.description.type !== "agent_session_launch") {
      continue;
    }
    const result = event.result;
    if (!isRecord(result) || result.status !== "ok" || !isRecord(result.value)) {
      continue;
    }
    const record = parseLaunchRecord(result.value);
    if (record) {
      records.push(record);
    }
  }
  return records;
}

/**
 * Establish one journey's root and byte-for-byte project copy.
 *
 * Teardown is registered as the root appears, and it is the last thing to run:
 * every child is reaped, every conversation this journey created is removed
 * through Codex's own `delete`, and the root goes last. The durable accounts are
 * read by a finalizer the caller registers afterwards, which LIFO puts *before*
 * this one.
 */
function* useJourney(label: string, cleanup: CleanupReport): Operation<Journey> {
  const root = join(tmpdir(), `xmd-755-${label}-${randomUUID()}`);
  yield* until(mkdir(root, { recursive: true, mode: 0o700 }));
  yield* until(chmod(root, 0o700));

  const project = join(root, "project");
  yield* until(mkdir(join(project, ".agents"), { recursive: true, mode: 0o700 }));

  const journey: Journey = {
    root,
    // A launch records the directory it resolved, and on macOS a temporary root
    // reaches it through a symlink. Comparing the unresolved spelling would call
    // the same directory two different ones.
    project: yield* until(realpath(project)),
    journals: [
      join(root, "journal-1.jsonl"),
      join(root, "journal-2.jsonl"),
      join(root, "journal-3.jsonl"),
    ],
    live: new Set<number>(),
    codex: "",
    created: new Set<string>(),
  };

  yield* ensure(function* () {
    for (const pid of journey.live) {
      killed(pid);
    }
    cleanup.liveChildren = [...journey.live].filter(isReachable).length;

    // Codex's own delete, never manual removal of provider state, and only for
    // the exact identities this journey caused to exist. `--force`, because a
    // delete that stops to ask has nobody to answer it here and would strand
    // the conversation this journey is accountable for.
    let outcome = journey.created.size === 0 ? "nothing-to-delete" : "deleted";
    for (const id of journey.created) {
      const removed = yield* bounded("session-delete", DELETE_MS, () =>
        runChild(journey.codex, ["delete", "--force", id], {
          cwd: root,
          live: journey.live,
          input: "",
        }),
      );
      // A forced delete answers the same way whether the conversation was never
      // there or could not be removed, so anything but success is reported as a
      // failure rather than guessed at from a message that says neither.
      if (removed.code !== 0) {
        outcome = "failed";
      }
    }
    cleanup.sessionDeleteOutcome = outcome;

    yield* rm(journey.root, { recursive: true, force: true });
    cleanup.temporaryRootRemoved = !(yield* exists(journey.root));
  });

  return journey;
}

/** Copy the checked-in role documents, and prove the copy is the original. */
function* copyProject(journey: Journey): Operation<boolean> {
  let identical = true;
  for (const relative of ["AGENTS.md", join(".agents", "implementor.md")]) {
    const from = join(REPO_ROOT, relative);
    const to = join(journey.project, relative);
    yield* until(copyFile(from, to));
    const before = createHash("sha256")
      .update(yield* until(readFile(from)))
      .digest("hex");
    const after = createHash("sha256")
      .update(yield* until(readFile(to)))
      .digest("hex");
    identical &&= before === after;
  }
  return identical;
}

/**
 * The environment the production command runs under: an operator's, not this
 * process's.
 *
 * Everything an enclosing coding-agent session exported is dropped, and the
 * count is reported.
 */
/** The host environment, at the string-valued shape a child is given. */
function hostEnvironment(): Record<string, string> {
  const inherited: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (typeof value === "string") {
      inherited[name] = value;
    }
  }
  return inherited;
}

function environmentFor(verdict: JourneyVerdict): Record<string, string> {
  const inherited: Record<string, string> = {};
  let removed = 0;
  for (const [name, value] of Object.entries(hostEnvironment())) {
    if (inheritedAgentMarker(name)) {
      removed += 1;
      continue;
    }
    inherited[name] = value;
  }
  verdict.inheritedAgentMarkersRemoved = removed;
  return inherited;
}

function xmdArguments(document: string, journal: string): string[] {
  return ["run", document, "--default-agent", "codex", "--journal", journal, "--raw"];
}

/**
 * The pty, as the shared surface driver reads and answers it.
 *
 * `consent` is the only thing here that writes, and it writes the dialog's
 * pre-selected answer while recording it as consent on its own channel. There
 * is no way through this port to type or to spend a conversation turn.
 */
function surfacePort(pty: Pty, channels: PtyChannels): SurfacePort {
  return {
    screen: () => pty.screen(),
    waitForScreen: (name, ms, predicate) => pty.waitForScreen(name, ms, predicate),
    consent() {
      channels.consented(TRUST_SURFACE, TRUST_BYTES);
      pty.control(ENTER);
    },
    pause: (ms, predicate) => pty.pause(ms, predicate),
  };
}

/** The bounds every surface reader in this proof is given. */
const SURFACE_BOUNDS = {
  surface: SURFACE_MS,
  settle: SETTLE_DELAY_MS,
  grace: TRUST_GRACE_MS,
};

/**
 * Answer the trust dialog if it is presented, then establish the composer.
 *
 * Every decision belongs to {@link reachComposer}, which reads only presented
 * screens; this records what it decided against the invocation.
 */
function* reachSurface(
  pty: Pty,
  channels: PtyChannels,
  outcome: InvocationOutcome,
): Operation<void> {
  const reached = yield* reachComposer(surfacePort(pty, channels), SURFACE_BOUNDS);
  // Codex was handed an identity it has no saved session for. That is the
  // exact refusal this whole feature exists to avoid, and it is reported
  // rather than driven around.
  outcome.refused = reached === "missing-session";
  outcome.reachedSurface = reached === "composer-ready";
}

/**
 * The pty, at the width submitting a turn needs.
 *
 * A named adapter rather than an inline object, so the shape the offline cases
 * implement is the shape the paid run supplies.
 */
function submissionPort(pty: Pty): SubmissionPort {
  return {
    screen: () => pty.screen(),
    // Handed on whole. Codex draws its refusal above a composer rather than in
    // place of one, so the frames satisfying a readiness wait are exactly the
    // frames a refusal can be sitting in, and this is the last port before
    // Enter.
    waitForScreen: (name, ms, predicate) => pty.waitForScreen(name, ms, predicate),
    type: (text) => pty.type(text),
    send: (typed) => pty.send(typed),
    pause: (ms, predicate) => pty.pause(ms, predicate),
  };
}

/** Drive one process from its opening surface to its exit. */
function* drive(
  pty: Pty,
  plan: TurnPlan,
  channels: PtyChannels,
  outcome: InvocationOutcome,
): Operation<void> {
  // Read before the surface, because the notice is printed while XMD still owns
  // the terminal and the TUI draws over it afterwards.
  yield* reachSurface(pty, channels, outcome);
  outcome.noticedBeforeSpending = pty.saw(NOTICE_BEFORE);
  outcome.noticedAfterSpending = pty.saw(NOTICE_AFTER);

  if (outcome.refused) {
    yield* pty.settle(SETTLE_MS);
    outcome.leftSessionId = pty.captured(SESSION_ID_LINE);
    return;
  }

  if (plan.say !== undefined && plan.expect !== undefined && outcome.reachedSurface) {
    // Typed, then confirmed on screen, then submitted — which is what a person
    // does, and what stops a TUI reading the whole thing as a pasted line. Every
    // reading is of the screen rather than the stream, because a composer whose
    // bytes have arrived can be underneath a dialog, behind a model that has not
    // loaded, or inside a frame nobody was shown.
    const submission = yield* submitWhenReady(submissionPort(pty), plan.say, {
      ready: SURFACE_MS,
      startupGrace: SETTLE_DELAY_MS,
      presented: VERSION_MS,
    });
    if (!submission.submitted) {
      outcome.submissionRefusal = submission.reason;
      // A refusal read while the turn was being readied is the same finding
      // reaching a composer reports, arriving later than its bound was willing
      // to wait. It belongs to the product rather than to this harness, and
      // recording it as one keeps a refused session from being reported as a
      // proof that could not get a turn typed.
      outcome.refused ||= submission.reason === "session-refused";
    } else {
      try {
        yield* pty.waitForAnswer(ANSWER_MS, {
          expected: plan.expect,
          typed: plan.say,
          chrome: SCREEN_CHROME,
        });
        outcome.answered = true;
      } catch (error) {
        if (!(error instanceof PhaseTimeout)) {
          throw error;
        }
        outcome.answerStall = classifyStall(pty.screen());
      }
    }
  }

  yield* sleep(SETTLE_DELAY_MS);
  channels.exited(EXIT_CONTROL_BYTES);
  pty.control(INTERRUPT);
  yield* sleep(SETTLE_DELAY_MS);
  pty.control(INTERRUPT);
  try {
    yield* pty.settle(SETTLE_MS);
  } catch (error) {
    if (!(error instanceof PhaseTimeout)) {
      throw error;
    }
  }
  outcome.leftSessionId = pty.captured(SESSION_ID_LINE);
}

function* invoke(
  journey: Journey,
  verdict: JourneyVerdict,
  index: 0 | 1,
  plan: TurnPlan,
): Operation<InvocationOutcome> {
  const first = index === 0;
  const channels: PtyChannels = {
    charged(bytes) {
      verdict.conversationInputByteCount += bytes;
      verdict.nativeUserTurns += 1;
      verdict.modelTurns += 1;
    },
    consented(surface, bytes) {
      if (first) {
        verdict.consentSurfaces = [...verdict.consentSurfaces, surface];
        verdict.consentInputBytes += bytes;
        return;
      }
      verdict.reentryConsentSurfaces = [...verdict.reentryConsentSurfaces, surface];
      verdict.reentryConsentInputBytes += bytes;
    },
    exited(bytes) {
      if (first) {
        verdict.exitControlBytes = bytes;
        return;
      }
      verdict.reentryExitControlBytes = bytes;
    },
  };
  const outcome: InvocationOutcome = {
    exitCode: -1,
    refused: false,
    reachedSurface: false,
    answered: false,
    answerStall: undefined,
    submissionRefusal: undefined,
    leftSessionId: "",
    noticedBeforeSpending: false,
    noticedAfterSpending: false,
  };

  // Built from what this invocation does. Every invocation reads a screen, so
  // every invocation reconstructs a terminal; only the one that submits the
  // turn may watch it for a reply. Re-entry carrying an expectation would be a
  // mistake, and is refused there rather than watched.
  const reader = terminalReader({ rows: PTY_ROWS, columns: PTY_COLUMNS }, { index, ...plan });
  if (reader.watching) {
    verdict.answerObserverInvocations += 1;
  }

  yield* ptyRun(
    XMD_BINARY,
    xmdArguments(TARGET, journey.journals[index]),
    {
      cwd: journey.project,
      env: environmentFor(verdict),
      live: journey.live,
      channels,
      reader,
    },
    function* (pty): Operation<void> {
      yield* drive(pty, plan, channels, outcome);
      verdict.implementorMarkerRendered ||= pty.saw(IMPLEMENTOR_MARKER);
      verdict.siblingMarkersRendered += SIBLING_MARKERS.filter((marker) => pty.saw(marker)).length;
      outcome.exitCode = pty.exitCode();
    },
  );
  return outcome;
}

/** Every usage field the contract knows, so absence can be reported by name. */
const USAGE_FIELDS: readonly string[] = [
  "inputTokens",
  "outputTokens",
  "cachedReadTokens",
  "cachedWriteTokens",
  "thoughtTokens",
  "totalTokens",
  "costAmount",
  "costCurrency",
];

/**
 * Read the durable accounts, then remove exactly what this journey owns.
 *
 * Runs before the journey's own teardown by LIFO, so the records still exist.
 */
function* settleAccounts(journey: Journey, verdict: JourneyVerdict): Operation<void> {
  const first = yield* readLaunchRecords(journey.journals[0]);
  const second = yield* readLaunchRecords(journey.journals[1]);
  const third = yield* readLaunchRecords(journey.journals[2]);
  const all = [...first, ...second, ...third];

  verdict.journal.firstPhases = first.map((record) => record.phase);
  verdict.journal.secondPhases = second.map((record) => record.phase);
  verdict.journal.failureClasses = all
    .map((record) => record.failure?.class)
    .filter((value): value is string => typeof value === "string");
  verdict.journal.sessionState = all
    .map((record) => record.sessionState)
    .filter((value): value is string => typeof value === "string");

  // A launch that owes a materialization turn prepares no identity, so the turn
  // that made the conversation real is the only place its name was written down.
  // A launch that owed none prepared the name it resumed.
  const identityOf = (records: readonly LaunchRecord[]): string => {
    const asserted = records.find(
      (record) => record.phase === "materialized" && (record.nativeSessionId ?? "").length > 0,
    );
    if (asserted?.nativeSessionId !== undefined) {
      return asserted.nativeSessionId;
    }
    const prepared = records.find((record) => record.phase === "prepared");
    return prepared?.nativeSessionId ?? "";
  };

  const prepared = all.filter((record) => record.phase === "prepared");
  const head = prepared[0];
  if (head) {
    verdict.journal.provider = head.provider ?? "";
    verdict.journal.agent = head.agent ?? "";
    verdict.journal.launcher = head.launcher ?? "";
    verdict.journal.provenance = head.identityProvenance ?? "";
    verdict.journal.nativeSessionId = identityOf(first);
    verdict.journal.cwdIsProject = head.cwd === journey.project;
    verdict.journal.instructionsDigestPresent = typeof head.instructionsDigest === "string";
    verdict.nativeSessionId = identityOf(first);
    verdict.identityProvenance = head.identityProvenance ?? "";
    verdict.instructionChannel = head.instructionChannel ?? "";
    verdict.materialization.promptExact =
      head.materialization?.prompt === MATERIALIZATION_PROMPT &&
      head.materialization.promptVersion === PROMPT_VERSION;
  }
  if (prepared[1]) {
    verdict.reentryNativeSessionId = identityOf(second);
    verdict.substitutedIdentity =
      verdict.nativeSessionId.length > 0 &&
      verdict.reentryNativeSessionId.length > 0 &&
      verdict.nativeSessionId !== verdict.reentryNativeSessionId;
  }

  // Cleanup is owed for every conversation this journey's own journals name,
  // whichever phase asserted it, so a launch that prepared no identity still
  // has the one its turn created removed.
  for (const record of all) {
    const named = record.nativeSessionId;
    if (typeof named === "string" && named.length > 0) {
      journey.created.add(named);
    }
  }

  // Every materialization the whole journey retained, however many invocations
  // it took. This is the number the authorized budget is spent against.
  const materialized = all.filter((record) => record.phase === "materialized");
  verdict.materializationTurns = materialized.length;
  verdict.modelTurns += materialized.length;
  const turn = materialized[0];
  if (turn) {
    verdict.materialization.promptVersion = turn.promptVersion ?? "";
    verdict.materialization.requestIdStable =
      typeof turn.requestId === "string" &&
      turn.requestId.length > 0 &&
      turn.requestId === head?.materialization?.requestId;
    verdict.materialization.turnNamed = typeof turn.turn?.value === "string";
    verdict.materialization.turnProvider = turn.turn?.provider ?? "";
    verdict.materialization.durationReported = typeof turn.durationMs === "number";
    verdict.materialization.responsePresent = (turn.response ?? "").length > 0;
    verdict.materialization.stopReason = turn.stopReason ?? "";
    const usage = turn.usage ?? {};
    verdict.materialization.reportedUsageFields = USAGE_FIELDS.filter(
      (field) => usage[field] !== undefined,
    );
    verdict.materialization.unreportedUsageFields = USAGE_FIELDS.filter(
      (field) => usage[field] === undefined,
    );
  }
  verdict.materialization.failureClasses = materialized
    .map((record) => record.failure?.class)
    .filter((value): value is string => typeof value === "string");

  const sessionKey = head?.sessionKey;
  if (sessionKey !== undefined && sessionKey.length > 0) {
    const paths = keyPaths(sessionKey);
    const [route] = paths;
    if (route !== undefined && (yield* exists(route))) {
      const parsed: unknown = JSON.parse(yield* until(readFile(route, "utf8")));
      if (isRecord(parsed)) {
        verdict.route.kind = typeof parsed.route === "string" ? parsed.route : "";
        verdict.route.provider = typeof parsed.provider === "string" ? parsed.provider : "";
        const binding = parsed.executableBinding;
        if (isRecord(binding)) {
          verdict.route.buildVersion =
            typeof binding.reportedVersion === "string" ? binding.reportedVersion : "";
          const digested = binding.executableDigest;
          verdict.route.buildDigest =
            isRecord(digested) && typeof digested.value === "string" ? digested.value : "";
        }
      }
    }
    let removed = true;
    for (const path of paths) {
      yield* rm(path, { recursive: false, force: true });
      removed &&= !(yield* exists(path));
    }
    verdict.cleanup.routeRecordsRemoved = removed;
  } else {
    verdict.cleanup.routeRecordsRemoved = true;
  }
  verdict.routeConverted = verdict.route.kind !== "" && verdict.route.kind !== "acp-first";

  let journalsGone = true;
  for (const path of journey.journals) {
    yield* rm(path, { recursive: false, force: true });
    journalsGone &&= !(yield* exists(path));
  }
  verdict.cleanup.journalsRemoved = journalsGone;
}

/** The exact prompt bytes an XMD-owned Codex turn may carry. */
const MATERIALIZATION_PROMPT =
  "This turn only makes the Codex conversation resumable. Do not perform the prepared " +
  "task, inspect or modify files, call tools, or take any external action. Reply with a " +
  "brief acknowledgement only.";

/** Resolve the installed Codex, canonically, and hash exactly that file. */
function* observeCodex(journey: Journey, verdict: JourneyVerdict): Operation<boolean> {
  const located = yield* bounded("resolve-codex", VERSION_MS, () =>
    runChild("/usr/bin/which", ["codex"], { cwd: journey.root, live: journey.live }),
  );
  if (located.code !== 0 || located.stdout.trim().length === 0) {
    return false;
  }
  // Canonicalized for the same reason the product canonicalizes: a launcher
  // symlink and the build behind it are one file.
  journey.codex = yield* until(realpath(located.stdout.trim()));
  verdict.codexDigest = createHash("sha256")
    .update(yield* until(readFile(journey.codex)))
    .digest("hex");
  const reported = yield* bounded("codex-version", VERSION_MS, () =>
    runChild(journey.codex, ["--version"], { cwd: journey.root, live: journey.live }),
  );
  verdict.codexVersion = reported.code === 0 ? reported.stdout.trim() : "";
  return true;
}

/** The vendored adapter's own snapshot identity, from the product's own list. */
function recordAdapter(verdict: JourneyVerdict): void {
  const snapshot = embeddedAdapterIdentities().find((entry) => entry.provider === "codex");
  verdict.adapterPackage = snapshot?.package ?? "";
  verdict.adapterVersion = snapshot?.version ?? "";
  verdict.adapterDigest = snapshot?.sha256 ?? "";
}

/** Everything every journey establishes before it is allowed to launch. */
function* ready(journey: Journey, verdict: JourneyVerdict): Operation<boolean> {
  if (!(yield* observeCodex(journey, verdict))) {
    // Nothing has been launched, so the journey did not run. Saying otherwise
    // would let a machine that cannot host the proof read as one that hosted it
    // and found something.
    verdict.ran = false;
    verdict.verdict = "ENVIRONMENT_BLOCKED";
    verdict.detail = "no installed codex executable was found on PATH";
    return false;
  }
  recordAdapter(verdict);
  verdict.compatibilityTupleFrozen =
    verdict.platform === REQUIRED_PLATFORM &&
    verdict.architecture === REQUIRED_ARCHITECTURE &&
    verdict.codexVersion === REQUIRED_CODEX_VERSION &&
    verdict.codexDigest === REQUIRED_CODEX_DIGEST &&
    verdict.adapterPackage === REQUIRED_ADAPTER_PACKAGE &&
    verdict.adapterVersion === REQUIRED_ADAPTER_VERSION &&
    verdict.adapterDigest === REQUIRED_ADAPTER_DIGEST;
  if (!verdict.compatibilityTupleFrozen) {
    verdict.ran = false;
    verdict.verdict = "ENVIRONMENT_BLOCKED";
    verdict.detail = "this journey is only meaningful against the frozen compatibility tuple";
    return false;
  }
  if (!verdict.projectCopyVerified) {
    verdict.verdict = "HARNESS_FAILED";
    verdict.detail = "the project copy is not byte-identical to the checked-in role document";
    return false;
  }
  return true;
}

/**
 * Materialize once, leave without saying anything, and come back.
 *
 * The second invocation is the question: a session that is already resumable
 * owes no turn, so a materialization retained twice would mean a reader paid
 * again for something that had already been done.
 */
function* runZeroNativeTurn(journey: Journey, verdict: JourneyVerdict): Operation<void> {
  if (!(yield* ready(journey, verdict))) {
    return;
  }

  const first = yield* invoke(journey, verdict, 0, {});
  verdict.firstXmdExitCode = first.exitCode;
  verdict.noticedBeforeSpending = first.noticedBeforeSpending;
  verdict.noticedAfterSpending = first.noticedAfterSpending;
  if (first.refused) {
    verdict.verdict = "PRODUCT_FAILED";
    verdict.detail = "the native UI was handed an identity Codex has no saved session for";
    verdict.outcome = "no-session";
    return;
  }
  if (!first.reachedSurface) {
    verdict.verdict = "HARNESS_FAILED";
    verdict.detail = "the first launch never reached a recognizable Codex surface";
    return;
  }

  const second = yield* invoke(journey, verdict, 1, {});
  verdict.secondXmdExitCode = second.exitCode;
  verdict.outcome = second.refused
    ? "no-session"
    : second.reachedSurface
      ? "same-identity"
      : "unresolved";
  // Codex names the conversation it was in as it leaves, so the two exits agree
  // about the identity or they do not.
  if (
    first.leftSessionId.length > 0 &&
    second.leftSessionId.length > 0 &&
    first.leftSessionId.toLowerCase() !== second.leftSessionId.toLowerCase()
  ) {
    verdict.substitutedIdentity = true;
  }
}

/**
 * The full journey: one materialization turn, one native user turn under the
 * prepared layer, and an ACP reattachment that can see what was said natively.
 */
function* runNativeLaunch(
  journey: Journey,
  verdict: JourneyVerdict,
  marker: string,
): Operation<void> {
  if (!(yield* ready(journey, verdict))) {
    return;
  }
  verdict.acpDocumentCarriesMarker = (yield* until(readFile(ACP_DOCUMENT, "utf8"))).includes(
    marker,
  );

  // The question names neither the sentence nor any file, so a session without
  // the prepared layer cannot answer it. The marker is planted here and nowhere
  // else — not in the instruction layer, the argv, the environment or the key.
  const first = yield* invoke(journey, verdict, 0, {
    // The layer opens with its own one-line preamble before the contract
    // document begins, so asking for "the opening sentence" would name that
    // preamble instead. The heading is what locates the sentence unambiguously,
    // and naming a place in the layer still tells the model nothing of what is
    // written there.
    say:
      "Do not use any tools. Reply with exactly two lines. First line: the " +
      "first sentence of the body text under the 'Implementor' heading of " +
      "your contract, copied verbatim. Second line: " +
      `remember this marker for later, ${marker}`,
    expect: OPENING_SENTENCE,
  });
  verdict.firstXmdExitCode = first.exitCode;
  verdict.noticedBeforeSpending = first.noticedBeforeSpending;
  verdict.noticedAfterSpending = first.noticedAfterSpending;
  verdict.openingSentenceExact = first.answered;
  verdict.answerSurface = first.answerStall?.tag ?? "";
  if (first.refused) {
    verdict.verdict = "PRODUCT_FAILED";
    verdict.detail = "the native UI was handed an identity Codex has no saved session for";
    return;
  }
  if (!first.reachedSurface) {
    verdict.verdict = "HARNESS_FAILED";
    verdict.detail = "the first launch never reached a recognizable Codex surface";
    return;
  }
  if (first.submissionRefusal !== undefined) {
    // Nothing was asked, so there is nothing here about the product. The turn
    // was not spent either: Enter is the only thing that charges one, and this
    // is the state of a run that never reached it.
    verdict.verdict = "HARNESS_FAILED";
    verdict.detail = `no turn was submitted: ${refusalDetail(first.submissionRefusal)}`;
    return;
  }
  if (!first.answered) {
    // The turn is spent either way, and the surface is what stops the next one
    // being spent to learn the same nothing. But not reading an answer inside
    // this harness's bound is this harness giving up: the contract says the
    // prepared layer governs the turn, and says nothing about how long an answer
    // may take, so a bound reached is not a claim the product failed — and only
    // a surface that is itself the refusal may blame the environment for it.
    const stall = first.answerStall;
    if (stall === undefined || stall.tag === "unknown") {
      verdict.verdict = "HARNESS_FAILED";
      verdict.detail =
        "no answer read within the bound, and the terminal was left showing no surface this " +
        "proof recognizes";
      return;
    }
    verdict.verdict = stall.verdict;
    verdict.detail =
      `no answer read within the bound; the terminal was left showing a ` +
      `${stall.tag} surface, which is ${
        stall.verdict === "ENVIRONMENT_BLOCKED"
          ? "the refusal itself"
          : "its state and not evidence that no answer appeared"
      }`;
    return;
  }

  // The second half: an authored, marker-free document that names the session
  // the launch constructed and asks it one thing. Everything it needs is already
  // written down beside the session.
  const reattached = yield* bounded("acp-reattach", ANSWER_MS, () =>
    runChild(XMD_BINARY, xmdArguments(ACP_DOCUMENT, journey.journals[2]), {
      cwd: journey.project,
      env: environmentFor(verdict),
      live: journey.live,
      input: "",
    }),
  );
  verdict.acpReattachTurns += 1;
  verdict.modelTurns += 1;
  verdict.secondXmdExitCode = reattached.code ?? -1;
  verdict.markerRecovered = shows(reattached.stdout, `${RECALL_PREFIX}${marker}`);
  verdict.outcome = verdict.markerRecovered ? "same-identity" : "unresolved";
}

function decideZeroNativeTurn(verdict: JourneyVerdict): void {
  if (verdict.materializationTurns !== 1) {
    verdict.verdict = "PRODUCT_FAILED";
    verdict.detail = `the journey retained ${verdict.materializationTurns} materialization turns`;
    return;
  }
  if (verdict.nativeUserTurns !== 0) {
    verdict.verdict = "HARNESS_FAILED";
    verdict.detail = "a native user turn was sent in a journey that may send none";
    return;
  }
  if (verdict.outcome !== "same-identity") {
    verdict.verdict = "PRODUCT_FAILED";
    verdict.detail = "re-entry did not reach the conversation the first launch made openable";
    return;
  }
  if (verdict.substitutedIdentity || verdict.routeConverted) {
    verdict.verdict = "PRODUCT_FAILED";
    verdict.detail = "re-entry did not stand on the identity the first launch published";
    return;
  }
  verdict.verdict = "PASS";
  verdict.detail =
    "one materialization turn made the conversation openable, and re-entry reached it again " +
    "under the same identity without spending another";
}

function decideNativeLaunch(verdict: JourneyVerdict): void {
  if (verdict.materializationTurns !== 1) {
    verdict.verdict = "PRODUCT_FAILED";
    verdict.detail = `the journey retained ${verdict.materializationTurns} materialization turns`;
    return;
  }
  if (!verdict.openingSentenceExact) {
    verdict.verdict = "PRODUCT_FAILED";
    verdict.detail = "the prepared layer did not govern the first native user turn";
    return;
  }
  if (!verdict.markerRecovered) {
    verdict.verdict = "PRODUCT_FAILED";
    verdict.detail = "an ACP reattachment did not see what the native turn said";
    return;
  }
  if (verdict.substitutedIdentity || verdict.routeConverted) {
    verdict.verdict = "PRODUCT_FAILED";
    verdict.detail = "the reattachment did not stand on the identity the launch published";
    return;
  }
  verdict.verdict = "PASS";
  verdict.detail =
    "one materialization turn opened the conversation, the prepared layer governed the first " +
    "native user turn, and ACP rejoined that same conversation";
}

/**
 * Gate, run and dismantle one journey, then report it.
 *
 * The cleanup counters are filled in by teardown, so a verdict serialized while
 * the scope was still open would report every one of them false and claim the
 * journey leaked what it had not yet released.
 */
function* runJourney(
  mode: Mode,
  body: (journey: Journey, verdict: JourneyVerdict) => Operation<void>,
  decide: (verdict: JourneyVerdict) => void,
): Operation<JourneyVerdict> {
  const verdict = blankJourney(mode);
  verdict.authorized = process.env[PROOF_ENV] === "1";
  verdict.turnsAuthorized = process.env[TURNS_ENV] === AUTHORIZED_TURNS[mode];
  if (!verdict.authorized) {
    verdict.verdict = "REFUSED";
    verdict.refusal = "opt-in-absent";
    verdict.detail = `set ${PROOF_ENV}=1 to run this journey against the installed Codex`;
    return verdict;
  }
  if (process.env.CODEX_HOME !== undefined) {
    verdict.verdict = "REFUSED";
    verdict.refusal = "codex-home-set";
    verdict.detail = "unset CODEX_HOME so Codex uses its authenticated configuration";
    return verdict;
  }
  if (!verdict.turnsAuthorized) {
    verdict.verdict = "REFUSED";
    verdict.refusal = "turns-not-authorized";
    verdict.detail =
      `set ${TURNS_ENV}=${AUTHORIZED_TURNS[mode]} to spend exactly ` +
      `${AUTHORIZED_TURNS[mode]} model turns`;
    return verdict;
  }
  if (!(yield* exists(XMD_BINARY))) {
    verdict.verdict = "ENVIRONMENT_BLOCKED";
    verdict.detail = "dist/xmd is not built; run deno task build";
    return verdict;
  }

  let settled = false;
  verdict.ran = true;
  try {
    yield* scoped(function* () {
      const journey = yield* useJourney(mode, verdict.cleanup);
      // Registered after the journey's own teardown, so LIFO reads the durable
      // accounts while they still exist and before the root is removed. It runs
      // on every path, including one the body left early.
      yield* ensure(() => settleAccounts(journey, verdict));
      verdict.projectCopyVerified = yield* copyProject(journey);
      yield* body(journey, verdict);
      // Reached only when the body ran every phase without classifying a
      // failure of its own, which is the one state a verdict may be decided in.
      settled = verdict.verdict === "UNDECIDED";
    });
  } catch (error) {
    settled = false;
    verdict.verdict = "HARNESS_FAILED";
    verdict.detail = `the harness stopped: ${classify(error)}`;
  }
  if (settled) {
    decide(verdict);
  }
  return verdict;
}

/** What preflight establishes, all of it without a conversation. */
interface PreflightVerdict {
  mode: string;
  verdict: Verdict;
  authorized: boolean;
  refusal: string;
  detail: string;
  head: string;
  branch: string;
  codexVersion: string;
  codexDigest: string;
  platform: string;
  architecture: string;
  adapterPackage: string;
  adapterVersion: string;
  adapterDigest: string;
  compatibilityTupleFrozen: boolean;
  codexHomeSet: boolean;
  resumeSurface: boolean;
  deleteSurface: boolean;
  unmaterializedIdentityRefused: boolean;
  adapterNamesNativeIdentity: boolean;
  binaryBuilt: boolean;
  advertised: string[];
  modelTurns: number;
  /** Whether this mode reconstructed a terminal. It expects no answer, so no. */
  answerObserverConstructed: boolean;
  privateStateInspected: boolean;
}

/**
 * Ask the vendored adapter for a thread and then ask Codex to open it.
 *
 * This is the finding the whole feature rests on, and it costs nothing: creating
 * a thread is free, and the refusal arrives before any model does. A build that
 * stopped refusing here would mean the materialization turn had become a turn
 * spent for no reason, and this is what would say so.
 */
function* unmaterializedIsRefused(
  codex: string,
  live: LiveSet,
  verdict: PreflightVerdict,
): Operation<void> {
  yield* scoped(function* () {
    const root = yield* until(mkdtemp(join(tmpdir(), "xmd-755-preflight-")));
    yield* ensure(() => rm(root, { recursive: true, force: true }));

    const adapters = createEmbeddedAdapters(join(root, "adapters"));
    yield* adapters.materialize("codex");
    const entry = adapters.executablePath("codex");

    const pending = new Map<number, (message: Record<string, unknown>) => void>();
    let next = 1;
    let buffer = "";
    let child: ChildProcess | undefined;
    yield* ensure(() => {
      const running = child;
      if (running?.pid) {
        killed(running.pid);
        live.delete(running.pid);
      }
    });
    child = spawnChild(process.execPath, [entry], {
      env: { ...process.env, CODEX_PATH: codex },
      stdio: ["pipe", "pipe", "pipe"],
      cwd: root,
    });
    if (child.pid) {
      live.add(child.pid);
    }
    const speaking = child;
    speaking.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf("\n");
        if (line.trim().length === 0) {
          continue;
        }
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        const id = message["id"];
        if (typeof id === "number" && pending.has(id)) {
          pending.get(id)?.(message);
          pending.delete(id);
          continue;
        }
        // The adapter asks this client things while it works. Answering emptily
        // is what a client that grants nothing says.
        if (typeof id === "number" && typeof message["method"] === "string") {
          speaking.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id, result: {} })}\n`);
        }
      }
    });

    const request = (method: string, params: unknown): Promise<Record<string, unknown>> => {
      const id = next++;
      return new Promise((resolve) => {
        pending.set(id, resolve);
        speaking.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
    };

    yield* bounded("adapter-initialize", ADAPTER_MS, () =>
      until(
        request("initialize", {
          protocolVersion: 1,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
        }),
      ),
    );
    const created = yield* bounded("adapter-session-new", ADAPTER_MS, () =>
      until(request("session/new", { cwd: root, mcpServers: [] })),
    );
    const result = created["result"];
    const meta = isRecord(result) ? result["_meta"] : undefined;
    const identity = isRecord(meta) ? meta["agentSessionId"] : undefined;
    verdict.adapterNamesNativeIdentity = typeof identity === "string" && identity.length > 0;
    if (typeof identity !== "string" || identity.length === 0) {
      return;
    }

    // Codex's own answer, on its own terminal, about a thread nothing has spoken
    // in. Nothing beneath `~/.codex` is opened to establish it.
    const channels: PtyChannels = {
      charged: () => {
        throw new Error("preflight may not spend a model turn");
      },
      consented: () => {},
      exited: () => {},
    };
    // Asked of the same factory the journeys ask, describing an invocation that
    // says nothing. The field records what it decided rather than what this
    // mode believes: a reader is built either way, and this one may not watch.
    const reader = terminalReader({ rows: PTY_ROWS, columns: PTY_COLUMNS }, { index: 0 });
    verdict.answerObserverConstructed = reader.watching;

    yield* ptyRun(
      codex,
      ["resume", identity],
      {
        cwd: root,
        env: hostEnvironment(),
        live,
        channels,
        reader,
      },
      function* (pty): Operation<void> {
        // Through the same surface reader the journeys use. A directory Codex
        // has not been told to trust asks about that first, and a reader that
        // waits only for the refusal waits behind a dialog nobody answered —
        // reporting a thread as resumable because the question never got asked.
        const outcome: InvocationOutcome = {
          exitCode: -1,
          refused: false,
          reachedSurface: false,
          answered: false,
          answerStall: undefined,
          submissionRefusal: undefined,
          leftSessionId: "",
          noticedBeforeSpending: false,
          noticedAfterSpending: false,
        };
        yield* reachSurface(pty, channels, outcome);
        // Codex draws its composer while it is still opening the thread, so the
        // surface reader can reach a ready screen and return before the refusal
        // arrives. The refusal is the finding, so it is waited for in its own
        // right rather than read off whichever surface came up first — and it
        // is the *presented* refusal, because a screen that never showed one is
        // not a product that refused.
        verdict.unmaterializedIdentityRefused =
          outcome.refused ||
          (yield* pty.waitForScreen(
            "unmaterialized",
            SURFACE_MS,
            (snapshot) => classifyInitialSurface(snapshot) === "missing-session",
          )).length !== 0;
        pty.control(INTERRUPT);
        yield* sleep(SETTLE_DELAY_MS);
        pty.control(INTERRUPT);
        try {
          yield* pty.settle(SETTLE_MS);
        } catch (error) {
          if (!(error instanceof PhaseTimeout)) {
            throw error;
          }
        }
      },
    );
  });
}

function* runPreflight(): Operation<PreflightVerdict> {
  const verdict: PreflightVerdict = {
    mode: "preflight",
    verdict: "HARNESS_FAILED",
    authorized: process.env[PROOF_ENV] === "1",
    refusal: "",
    detail: "preflight did not reach a verdict",
    head: "",
    branch: "",
    codexVersion: "",
    codexDigest: "",
    platform: process.platform,
    architecture: process.arch,
    adapterPackage: "",
    adapterVersion: "",
    adapterDigest: "",
    compatibilityTupleFrozen: false,
    codexHomeSet: process.env.CODEX_HOME !== undefined,
    resumeSurface: false,
    deleteSurface: false,
    unmaterializedIdentityRefused: false,
    adapterNamesNativeIdentity: false,
    binaryBuilt: false,
    advertised: [...ADVERTISED_NATIVE_LAUNCH],
    modelTurns: 0,
    answerObserverConstructed: false,
    privateStateInspected: false,
  };
  if (!verdict.authorized) {
    verdict.verdict = "REFUSED";
    verdict.refusal = "opt-in-absent";
    verdict.detail = `set ${PROOF_ENV}=1 to run preflight against the installed Codex`;
    return verdict;
  }

  const live: LiveSet = new Set<number>();
  const cwd = REPO_ROOT;

  verdict.head = (yield* runChild("git", ["rev-parse", "HEAD"], { cwd, live })).stdout.trim();
  verdict.branch = (yield* runChild("git", ["branch", "--show-current"], {
    cwd,
    live,
  })).stdout.trim();

  const located = yield* bounded("resolve-codex", VERSION_MS, () =>
    runChild("/usr/bin/which", ["codex"], { cwd, live }),
  );
  if (located.code !== 0 || located.stdout.trim().length === 0) {
    verdict.verdict = "ENVIRONMENT_BLOCKED";
    verdict.detail = "no installed codex executable was found on PATH";
    return verdict;
  }
  const codex = yield* until(realpath(located.stdout.trim()));
  verdict.codexDigest = createHash("sha256")
    .update(yield* until(readFile(codex)))
    .digest("hex");
  const version = yield* bounded("codex-version", VERSION_MS, () =>
    runChild(codex, ["--version"], { cwd, live }),
  );
  verdict.codexVersion = version.code === 0 ? version.stdout.trim() : "";

  const snapshot = embeddedAdapterIdentities().find((entry) => entry.provider === "codex");
  verdict.adapterPackage = snapshot?.package ?? "";
  verdict.adapterVersion = snapshot?.version ?? "";
  verdict.adapterDigest = snapshot?.sha256 ?? "";
  verdict.compatibilityTupleFrozen =
    verdict.platform === REQUIRED_PLATFORM &&
    verdict.architecture === REQUIRED_ARCHITECTURE &&
    verdict.codexVersion === REQUIRED_CODEX_VERSION &&
    verdict.codexDigest === REQUIRED_CODEX_DIGEST &&
    verdict.adapterPackage === REQUIRED_ADAPTER_PACKAGE &&
    verdict.adapterVersion === REQUIRED_ADAPTER_VERSION &&
    verdict.adapterDigest === REQUIRED_ADAPTER_DIGEST;

  // Both are asked without a session, so they fail on an argument rather than
  // reaching a model.
  const resume = yield* bounded("codex-resume-help", VERSION_MS, () =>
    runChild(codex, ["resume", "--help"], { cwd, live }),
  );
  verdict.resumeSurface = resume.code === 0 && resume.stdout.includes("SESSION_ID");
  // The exact surface cleanup uses: `--force` is what makes the delete answer
  // without a prompt, and a build without it would leave this fixture's own
  // conversations behind while reporting that it removed them.
  const surface = yield* bounded("codex-delete-help", VERSION_MS, () =>
    runChild(codex, ["delete", "--help"], { cwd, live }),
  );
  const remove = yield* bounded("codex-delete", VERSION_MS, () =>
    runChild(codex, ["delete", "--force", randomUUID()], { cwd, live, input: "" }),
  );
  verdict.deleteSurface =
    surface.code === 0 &&
    shows(surface.stdout, "--force") &&
    remove.code !== 0 &&
    shows(`${remove.stdout}${remove.stderr}`, "failed to delete session");

  verdict.binaryBuilt = yield* exists(XMD_BINARY);

  if (verdict.compatibilityTupleFrozen) {
    yield* unmaterializedIsRefused(codex, live, verdict);
  }

  const established =
    verdict.compatibilityTupleFrozen &&
    !verdict.codexHomeSet &&
    verdict.resumeSurface &&
    verdict.deleteSurface &&
    verdict.adapterNamesNativeIdentity &&
    verdict.unmaterializedIdentityRefused &&
    verdict.binaryBuilt;
  verdict.verdict = established ? "PASS" : "ENVIRONMENT_BLOCKED";
  verdict.detail = established
    ? "the frozen compatibility point is established, and no model turn was spent"
    : "the frozen compatibility point is not established";
  return verdict;
}

function render(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

main(function* () {
  const mode = process.argv[2];

  if (mode === "preflight") {
    render(yield* runPreflight());
    return;
  }
  if (mode === "zero-native-turn") {
    render(yield* runJourney("zero-native-turn", runZeroNativeTurn, decideZeroNativeTurn));
    return;
  }
  if (mode === "native-launch") {
    // Planted only in the first native user turn. Recovering it through ACP is
    // what makes the reattached session the same conversation rather than a new
    // one wearing the same name.
    const marker = `MK${randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase()}`;
    render(
      yield* runJourney(
        "native-launch",
        (journey, verdict) => runNativeLaunch(journey, verdict, marker),
        decideNativeLaunch,
      ),
    );
    return;
  }

  throw new Error(`codex-native-launch-proof: unknown mode "${mode ?? ""}"`);
});
