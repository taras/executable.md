/**
 * Issue #520 — the parts of a real Claude launch Markdown cannot observe.
 *
 * `ClaudeNativeLaunch.test.md` and `ClaudeZeroTurnExit.test.md` own the
 * sequencing, the gating, the schemas, the assertions and everything an
 * operator reads. This fixture owns only what an authored document cannot
 * reach: a pseudo-terminal, child lifecycle, the argument vector a native CLI
 * actually received, file modes, structured route and journal reads, and
 * exact-path cleanup.
 *
 * What it does not own is the product. The thing under test is the ordinary
 * production command:
 *
 *     dist/xmd run AGENTS.md#Implementor --default-agent claude --journal … --raw
 *
 * run inside a byte-for-byte copy of the repository's own `AGENTS.md` and
 * `.agents/implementor.md`. No role Markdown is built, interpolated or
 * rewritten here — a proof that assembled the document in TypeScript would be
 * proving something nobody runs.
 *
 * Two boundaries keep the evidence honest:
 *
 * - **Nothing provider-private is read.** Every observation comes from a value
 *   this fixture supplied, a process outcome, XMD's own diagnostic journal, the
 *   exact XMD route record for this run's natural key, or the terminal output
 *   of the production command. Nothing beneath Claude's configuration, history
 *   or transcripts is opened, and `CLAUDE_CONFIG_DIR` is left exactly as the
 *   operator has it — relocating it de-authenticates Claude Code.
 * - **Nothing sensitive is rendered.** One filtered JSON verdict reaches
 *   stdout: versions, the exact identity and its provenance, filtered command
 *   shapes with the instruction path replaced by `<private-file>`, booleans,
 *   counts, phase and failure classes, and cleanup outcomes. Raw terminal
 *   buffers, argv, environment, prepared instruction text, the history marker
 *   and private paths never leave this file.
 */

import { ensure, main, race, scoped, sleep, spawn, until, withResolvers } from "effection";
import type { Operation } from "effection";
import { exists, rm } from "@effectionx/fs";
import { spawn as spawnChild } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { createAgentRegistry } from "../../src/acpx-runtime.ts";
import { agentSessionKeyDigest } from "@executablemd/runtime";
import { ADVERTISED_NATIVE_LAUNCH } from "../../src/native-launch.ts";

/** Opting in at all. Absent, every mode refuses before a provider child. */
const PROOF_ENV = "XMD_CLAUDE_NATIVE_PROOF";
/** The separate, exact grant only the two-turn journey spends. */
const TURNS_ENV = "XMD_CLAUDE_MODEL_TURNS_AUTHORIZED";
const AUTHORIZED_TURNS = "2";

/** The production target, exactly as an operator would type it. */
const TARGET = "AGENTS.md#Implementor";

/** The compatibility point these journeys are only meaningful against. */
const REQUIRED_CLAUDE_VERSION = "2.1.241 (Claude Code)";

/**
 * The role contract's opening sentence.
 *
 * Never sent to the model. It reaches the session only as part of the private
 * instruction layer the launch prepared, so an answer carrying it is evidence
 * the layer governed the first native turn — evidence that needs no test-only
 * token planted in a production role document.
 */
const OPENING_SENTENCE = "The Implementor delivers an accepted plan as a focused, verified change.";

/**
 * What a recovered marker has to be wrapped in.
 *
 * Resuming redraws the conversation that already exists, so the marker planted
 * in the first user turn is on screen again before the second turn is even
 * asked. Looking for the bare marker would find a repainted transcript and call
 * it recovered history. This prefix appears in no earlier turn and in nothing
 * Claude draws, so only an answer can produce it.
 */
const RECALL_PREFIX = "RECALLED-";

/** What a filtered command shape says instead of the private file's path. */
const PRIVATE_FILE = "<private-file>";

/** Rendered-output markers: one per role section, each unique to its section. */
const IMPLEMENTOR_MARKER = "Running this target prepares the session";
const SIBLING_MARKERS: readonly string[] = [
  ".agents/planner.md",
  ".agents/architect.md",
  "It has no contract document of its own",
];

const EOF_BYTE = "\u0004";
const ENTER = "\r";
const ESCAPE = "\u001b";
const EXIT_CONTROL_BYTES = "0404";

/**
 * The consent menus Claude may put in front of a new session, and the key that
 * answers each.
 *
 * None of them is a conversation. Each asks the person at the terminal for a
 * standing permission — may I work in this directory, may I drive your browser
 * — reaches no model and creates no user turn, so answering one is terminal
 * control and is reported on its own channel. Every answer is the conservative
 * one the dialog itself offers: `Enter` takes the pre-selected choice, and
 * `Esc` is the decline the dialog names.
 *
 * Each is recognized by wording that appears only in the dialog body, never in
 * the confirmation it leaves behind — so a menu already answered can never be
 * read as a second request.
 */
interface ConsentMenu {
  name: string;
  marker: string;
  answer: string;
  bytes: string;
}

const CONSENT_MENUS: readonly ConsentMenu[] = [
  // "❯ 1. Yes, I trust this folder" is pre-selected, so Enter confirms it.
  { name: "workspace-trust", marker: "Quick safety check", answer: ENTER, bytes: "0d" },
  // "Esc to keep browser tools off" — the launch widens no authority it was
  // not given, so the decline is the answer.
  {
    name: "chrome-extension",
    marker: "Claude in Chrome extension detected",
    answer: ESCAPE,
    bytes: "1b",
  },
];

/** At most one answer per menu, and a hard stop rather than a loop. */
const MAX_CONSENT_ROUNDS = CONSENT_MENUS.length + 1;

/**
 * Claude answers a first Ctrl-D with this rather than exiting.
 *
 * It is the surface's own affordance and proof the byte was received — but a
 * consent menu answers it too, so it only means "the conversation prompt is
 * there" once every menu has been answered.
 */
const CTRL_D_AFFORDANCE = "Press Ctrl-D again to exit";

/** The session UI's own banner, and the strongest signal the prompt is up. */
const WELCOME_BANNER = "Claude Code v";

/**
 * What a turn that produced no answer is showing instead.
 *
 * A bare timeout says only that a bound was spent, and a turn is too expensive
 * to spend twice learning the same nothing. These are fixed classes matched on
 * the surface's own wording — never terminal output, and never a transcript —
 * so a stalled turn says which kind of stall it was and the next decision can
 * be made without spending another one.
 */
const ANSWER_STALLS: readonly { tag: string; marker: string }[] = [
  { tag: "permission-request", marker: "Do you want to proceed" },
  { tag: "permission-request", marker: "requests permission" },
  { tag: "paste-pending", marker: "Pasted text" },
  { tag: "still-working", marker: "esc to interrupt" },
  { tag: "context-menu", marker: "Enter to confirm" },
];

/**
 * Environment names an enclosing Claude Code session exports.
 *
 * A proof that runs inside one inherits them, and Claude Code behaves
 * differently when it does — `CLAUDE_CODE_CHILD_SESSION` turns transcript
 * saving off, which is exactly the durable state `--resume` needs. An operator
 * running this command in an ordinary terminal has none of them, so neither
 * does the command this fixture runs. `CLAUDE_CODE_MESSAGING_TOKEN` is a
 * credential besides, and nothing here has any business forwarding one.
 */
function inheritedAgentMarker(name: string): boolean {
  return (
    name === "CLAUDECODE" ||
    name === "CLAUDE_PID" ||
    name === "CLAUDE_EFFORT" ||
    name.startsWith("CLAUDE_CODE_")
  );
}

/** Every phase is bounded on its own, well inside the document's block timeout. */
const VERSION_MS = 30_000;
const SURFACE_MS = 120_000;
const ANSWER_MS = 300_000;
const SETTLE_MS = 120_000;
const PURGE_MS = 60_000;
/** How long a surface is given to settle before the readiness probe. */
const READINESS_DELAY_MS = 5_000;
/** How long one readiness probe waits for the prompt's own answer. */
const READINESS_MS = 45_000;
/** How many times the prompt is asked before it is called unreachable. */
const READINESS_ATTEMPTS = 2;
/** How often the private instruction file is looked for while a child is live. */
const OBSERVE_POLL_MS = 100;

/** How much of the terminal's tail a stall is classified from. */
const CLASSIFY_TAIL = 8_000;

/** How much of a typed line has to be echoed back before Enter is pressed. */
const TYPED_TAIL = 24;

type Mode = "preflight" | "zero-turn" | "two-turn";

type Verdict = "PASS" | "REFUSED" | "ENVIRONMENT_BLOCKED" | "PRODUCT_FAILED" | "HARNESS_FAILED";

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
  return error instanceof Error ? error.name : "unknown";
}

/** Whether a process still exists. Signal 0 delivers nothing; it only asks. */
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

/** How long an interrupted command is given to finish its own cleanup. */
const TEARDOWN_GRACE_MS = 8_000;

/** Wait until `pid` is unreachable, or the grace period is spent. */
function settledWithin(pid: number, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const started = Date.now();
    const poll = setInterval(() => {
      if (!isReachable(pid) || Date.now() - started >= ms) {
        clearInterval(poll);
        resolve();
      }
    }, 50);
  });
}

/**
 * Terminal output compared with every space removed.
 *
 * A pseudo-terminal wraps at its width and a TUI indents what it draws, so a
 * sentence that is one string in an answer is several lines in the buffer.
 * Removing whitespace is what lets an exact comparison stay exact without
 * depending on how wide the terminal happened to be.
 */
function squeeze(text: string): string {
  return text.replace(/\s+/gu, "");
}

/**
 * Terminal output with its control sequences removed.
 *
 * A TUI's bytes are mostly instructions to the terminal — cursor moves, colors,
 * screen clears — and they land in the middle of words. Matching wording
 * against the raw stream finds nothing, and finding nothing is
 * indistinguishable from the surface never appearing.
 */
const CONTROL_SEQUENCE =
  // deno-lint-ignore no-control-regex
  /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/gu;

/** What a marker is compared against: no escapes, and no whitespace. */
function readable(text: string): string {
  return squeeze(text.replace(CONTROL_SEQUENCE, ""));
}

function shows(text: string, marker: string): boolean {
  return readable(text).includes(squeeze(marker));
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

/** Run one captured child to settlement. Never the production command. */
function runChild(
  command: string,
  args: string[],
  options: { cwd: string; input?: string; live: LiveSet },
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

    const started = spawnChild(command, args, {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    child = started;
    if (started.pid) {
      options.live.add(started.pid);
    }
    let stdout = "";
    let stderr = "";

    const onStdout = (chunk: Buffer): void => {
      stdout += chunk.toString();
    };
    const onStderr = (chunk: Buffer): void => {
      stderr += chunk.toString();
    };
    const onError = (error: Error): void => failed.reject(error);
    const onClose = (code: number | null, signal: string | null): void => {
      if (started.pid) {
        options.live.delete(started.pid);
      }
      settled.resolve({ code, signal, stdout, stderr });
    };

    // Registered after the cleanup above and so torn down before it: the child
    // stops being observed before it is signalled, and a race this arm loses
    // leaves nothing attached to a process somebody else is still reading.
    // Established before the subscriptions, because `yield* ensure(...)` is
    // itself a suspension an owner can be halted at.
    yield* ensure(() => {
      started.stdout?.off("data", onStdout);
      started.stderr?.off("data", onStderr);
      started.off("error", onError);
      started.off("close", onClose);
    });

    started.stdout?.on("data", onStdout);
    started.stderr?.on("data", onStderr);
    started.on("error", onError);
    started.on("close", onClose);

    if (options.input !== undefined) {
      started.stdin?.write(options.input);
    }
    started.stdin?.end();

    return yield* race([settled.operation, failed.operation]);
  })();
}

/**
 * One production command running under a pseudo-terminal.
 *
 * `<Session.Launch>` takes the run's foreground-terminal lease and refuses a
 * host with no terminal, which is what a real operator gets and the reason this
 * cannot be a piped child. `/usr/bin/script` is the terminal boundary, so no
 * PTY dependency is added for a test.
 */
interface Pty {
  /**
   * Wait until output arriving *since the last handled surface* satisfies
   * `predicate`, then mark it handled.
   *
   * Windowed on purpose: a dialog that has already been answered stays in the
   * buffer, and re-reading it would answer it twice.
   */
  waitFor(name: string, ms: number, predicate: (fresh: string) => boolean): Operation<void>;
  /**
   * Wait until one of `tags` matches, and say which.
   *
   * Several answers are possible at a surface and only one arrives, so a
   * sequence of single waits would block on whichever it happened to ask about
   * first.
   */
  waitForAny(
    name: string,
    ms: number,
    tags: readonly { tag: string; marker: string }[],
  ): Operation<string>;
  /** Whether everything seen so far contains `marker`, whitespace ignored. */
  saw(marker: string): boolean;
  /**
   * Which of `tags` the screen is showing now.
   *
   * Asked once, after a wait has already given up. Racing these against the
   * answer would be worse than useless: "esc to interrupt" is what a model
   * that is working prints, so a race would classify every slow answer as a
   * stall and stop waiting for it.
   */
  classify(tags: readonly { tag: string; marker: string }[]): string;
  /** Write terminal-control bytes — never conversation. */
  control(bytes: string): void;
  /**
   * Type one conversation turn, without sending it.
   *
   * Separate from `send()` because a TUI reads text and a newline arriving
   * together as a pasted line rather than as a submitted one — the newline lands
   * in the box and nothing is sent. Typing, then confirming the box holds it,
   * then pressing Enter is what a person does and what this does.
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
  /** A consent menu was answered with these bytes. Never a conversation. */
  consented(surface: string, bytes: string): void;
  /** Exit control was sent. */
  exited(bytes: string): void;
}

/**
 * Run one production command under a pseudo-terminal.
 *
 * `channels` is written through as each byte is sent rather than summarized
 * afterwards. A phase that times out never returns, and accounting that settled
 * on the way out would report zero turns for a run that had already spent one —
 * the one number nobody may be wrong about.
 */
function ptyRun<T>(
  command: string,
  args: string[],
  options: { cwd: string; env: Record<string, string>; live: LiveSet; channels: PtyChannels },
  body: (pty: Pty) => Operation<T>,
): Operation<T> {
  return scoped(function* (): Operation<T> {
    const settled = withResolvers<void>();
    const failed = withResolvers<never>();
    let child: ChildProcess | undefined;
    let text = "";
    let consumed = 0;
    let code = -1;
    let pending:
      | { predicate: (fresh: string) => boolean; resolve: (tag: string) => void }
      | undefined;

    // Interrupt, then insist. XMD removes the private instruction file while it
    // still owns the session, and a harness that reaches straight for SIGKILL
    // takes that chance away and then reports the file it stranded as a product
    // failure. So this asks first and escalates only if asked twice.
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

    const started = spawnChild("/usr/bin/script", ["-q", "/dev/null", command, ...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    child = started;
    if (started.pid) {
      options.live.add(started.pid);
    }

    const react = (chunk: Buffer): void => {
      text += chunk.toString();
      const waiter = pending;
      if (waiter && waiter.predicate(text.slice(consumed))) {
        pending = undefined;
        consumed = text.length;
        waiter.resolve("");
      }
    };
    const onError = (error: Error): void => failed.reject(error);
    const onClose = (status: number | null): void => {
      code = status ?? -1;
      if (started.pid) {
        options.live.delete(started.pid);
      }
      settled.resolve();
    };

    // Registered after the interrupt cleanup above and so torn down before it:
    // the terminal stops being read before the process holding it is signalled.
    // Established before the subscriptions, because `yield* ensure(...)` is
    // itself a suspension an owner can be halted at.
    yield* ensure(() => {
      started.stdout?.off("data", react);
      started.stderr?.off("data", react);
      started.off("error", onError);
      started.off("close", onClose);
    });

    started.stdout?.on("data", react);
    started.stderr?.on("data", react);
    started.on("error", onError);
    started.on("close", onClose);

    const write = (bytes: string) => {
      // Everything already on screen belongs to the surface being answered, so
      // the next wait reads only what this write provoked.
      consumed = text.length;
      child?.stdin?.write(bytes);
    };

    const pty: Pty = {
      waitFor(name, ms, predicate) {
        return bounded(name, ms, function* (): Operation<void> {
          if (predicate(text.slice(consumed))) {
            consumed = text.length;
            return;
          }
          const waiter = withResolvers<void>();
          pending = { predicate, resolve: () => waiter.resolve() };
          yield* race([waiter.operation, failed.operation]);
        });
      },
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
          let found: string | undefined;
          pending = {
            predicate: (fresh) => {
              found = match(fresh);
              return found !== undefined;
            },
            resolve: () => waiter.resolve(found!),
          };
          return yield* race([waiter.operation, failed.operation]);
        });
      },
      saw(marker) {
        return shows(text, marker);
      },
      classify(tags) {
        // The tail only: a marker from a surface that has since been answered
        // is not what the screen is showing.
        const tail = text.slice(Math.max(0, text.length - CLASSIFY_TAIL));
        return tags.find((entry) => shows(tail, entry.marker))?.tag ?? "unknown";
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

const NO_SESSION_MARKER = "No conversation found";

/** What one process's opening surfaces turned out to be. */
interface SurfaceOutcome {
  ready: boolean;
  refused: boolean;
  probeSent: boolean;
  /** The consent menus answered, in the order they appeared. */
  consented: string[];
}

/**
 * Answer every consent menu once, then establish that the prompt is there.
 *
 * The order and the number of menus belong to the installed Claude and to the
 * machine — a directory it already trusts shows no trust dialog, a machine with
 * no browser extension shows no browser dialog — so this reacts to what appears
 * rather than following a fixed script. Each menu is answered at most once, and
 * a menu that asks twice is a harness failure rather than something to keep
 * answering.
 *
 * Only once no menu is left does a Ctrl-D mean anything: a menu answers one
 * with its own "press again to exit" affordance, so taking that as proof of a
 * conversation prompt would be reading a dialog as a session.
 */
function* reachSurface(pty: Pty, channels: PtyChannels): Operation<SurfaceOutcome> {
  const outcome: SurfaceOutcome = { ready: false, refused: false, probeSent: false, consented: [] };
  const tags = [
    { tag: "no-session", marker: NO_SESSION_MARKER },
    { tag: "ready", marker: WELCOME_BANNER },
    ...CONSENT_MENUS.map((menu) => ({ tag: menu.name, marker: menu.marker })),
  ];

  for (let round = 0; round < MAX_CONSENT_ROUNDS; round++) {
    let seen: string;
    try {
      seen = yield* pty.waitForAny("surface", SURFACE_MS, tags);
    } catch (error) {
      if (!(error instanceof PhaseTimeout)) {
        throw error;
      }
      // Nothing recognizable, which is what a *resumed* session looks like: it
      // redraws the conversation it already has and prints no banner. The
      // readiness probe below is what asks such a surface whether it is there,
      // and it is surface-agnostic on purpose.
      break;
    }
    if (seen === "no-session") {
      outcome.refused = true;
      return outcome;
    }
    if (seen === "ready") {
      outcome.ready = true;
      return outcome;
    }
    if (outcome.consented.includes(seen)) {
      // Answered already. Answering again would be consenting twice to a
      // question that was only asked once.
      return outcome;
    }
    const menu = CONSENT_MENUS.find((entry) => entry.name === seen)!;
    outcome.consented.push(menu.name);
    channels.consented(menu.name, menu.bytes);
    pty.control(menu.answer);
  }

  // Every menu is behind us and no banner arrived. Ask the prompt whether it is
  // there, and accept only its own affordance as the answer. A resumed session
  // is still repainting its conversation when it first appears, so it is given
  // a moment, and asked twice before being called unreachable — a byte that
  // landed mid-redraw is not an answer about the surface.
  const answers = [
    { tag: "no-session", marker: NO_SESSION_MARKER },
    { tag: "ready", marker: CTRL_D_AFFORDANCE },
    { tag: "ready", marker: WELCOME_BANNER },
  ];
  for (let attempt = 0; attempt < READINESS_ATTEMPTS; attempt++) {
    yield* sleep(READINESS_DELAY_MS);
    outcome.probeSent = true;
    pty.control(EOF_BYTE);
    try {
      const answer = yield* pty.waitForAny("conversation-surface", READINESS_MS, answers);
      outcome.refused = answer === "no-session";
      outcome.ready = answer === "ready";
      return outcome;
    } catch (error) {
      if (!(error instanceof PhaseTimeout)) {
        throw error;
      }
    }
  }
  return outcome;
}

/** One journey's owned paths. Every removal below names an exact one. */
interface Journey {
  root: string;
  /** Canonical, because Claude keys a project by its resolved path. */
  project: string;
  binDirectory: string;
  observations: string;
  environmentDump: string;
  journals: [string, string];
  live: LiveSet;
  realClaude: string;
}

interface CleanupReport {
  liveChildren: number;
  privateFileRemoved: boolean;
  privateDirectoryRemoved: boolean;
  journalsRemoved: boolean;
  routeRecordsRemoved: boolean;
  projectPurgeOutcome: string;
  temporaryRootRemoved: boolean;
}

/** The one verdict shape both journeys render, exactly. */
interface JourneyVerdict {
  mode: string;
  verdict: Verdict;
  authorized: boolean;
  /**
   * Whether the journey was entered at all.
   *
   * Not the same question as `authorized`: an opted-in run still refuses for a
   * relocated configuration directory or an ungranted turn, and a reader that
   * branched on authorization would judge a run that never started.
   */
  ran: boolean;
  refusal: string;
  detail: string;

  claudeVersion: string;
  platform: string;
  architecture: string;

  target: string;
  projectCopyVerified: boolean;
  implementorMarkerRendered: boolean;
  siblingMarkersRendered: number;

  nativeSessionId: string;
  identityProvenance: string;
  identityAllocations: number;
  substitutedIdentity: boolean;
  routeConverted: boolean;
  freshFallback: boolean;

  firstCommand: string[];
  secondCommand: string[];
  firstInvocationChildren: number;
  secondInvocationChildren: number;
  firstXmdExitCode: number;
  secondXmdExitCode: number;

  instructionChannel: string;
  privateFileMode: string;
  privateFileRegular: boolean;
  preparedTextInArgv: boolean;
  preparedTextInEnvironment: boolean;

  modelTurns: number;
  conversationInputByteCount: number;
  consentInputBytes: string;
  consentSurfaces: string[];
  exitControlBytes: string;
  reentryConsentInputBytes: string;
  reentryConsentSurfaces: string[];
  reentryExitControlBytes: string;
  /** How many markers of an enclosing agent session were kept out. */
  inheritedAgentMarkersRemoved: number;
  openingSentenceExact: boolean;
  markerRecovered: boolean;
  answerSurface: string;
  outcome: string;

  route: {
    kind: string;
    provenance: string;
    launcher: string;
    nativeSessionId: string;
    instructionsDigestPresent: boolean;
  };
  journal: {
    provider: string;
    agent: string;
    launcher: string;
    provenance: string;
    nativeSessionId: string;
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
    verdict: "HARNESS_FAILED",
    authorized: false,
    ran: false,
    refusal: "",
    detail: "the journey did not reach a verdict",
    claudeVersion: "",
    platform: process.platform,
    architecture: process.arch,
    target: TARGET,
    projectCopyVerified: false,
    implementorMarkerRendered: false,
    siblingMarkersRendered: 0,
    nativeSessionId: "",
    identityProvenance: "",
    identityAllocations: 0,
    substitutedIdentity: false,
    routeConverted: false,
    freshFallback: false,
    firstCommand: [],
    secondCommand: [],
    firstInvocationChildren: 0,
    secondInvocationChildren: 0,
    firstXmdExitCode: -1,
    secondXmdExitCode: -1,
    instructionChannel: "",
    privateFileMode: "",
    privateFileRegular: false,
    preparedTextInArgv: false,
    preparedTextInEnvironment: false,
    modelTurns: 0,
    conversationInputByteCount: 0,
    consentInputBytes: "",
    consentSurfaces: [],
    exitControlBytes: "",
    reentryConsentInputBytes: "",
    reentryConsentSurfaces: [],
    reentryExitControlBytes: "",
    inheritedAgentMarkersRemoved: 0,
    openingSentenceExact: false,
    markerRecovered: false,
    answerSurface: "",
    outcome: "unresolved",
    route: {
      kind: "",
      provenance: "",
      launcher: "",
      nativeSessionId: "",
      instructionsDigestPresent: false,
    },
    journal: {
      provider: "",
      agent: "",
      launcher: "",
      provenance: "",
      nativeSessionId: "",
      sessionState: [],
      instructionsDigestPresent: false,
      firstPhases: [],
      secondPhases: [],
      failureClasses: [],
    },
    cleanup: {
      liveChildren: 0,
      privateFileRemoved: false,
      privateDirectoryRemoved: false,
      journalsRemoved: false,
      routeRecordsRemoved: false,
      projectPurgeOutcome: "failed",
      temporaryRootRemoved: false,
    },
    privateStateInspected: false,
  };
}

const REPO_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
const XMD_BINARY = join(REPO_ROOT, "dist", "xmd");
const SESSION_COORDINATOR_ROOT = join(homedir(), ".acpx", "xmd-native-sessions", "v1");

/** The exact absolute paths one natural key owns, and nothing else. */
function keyPaths(agentCommand: string, sessionKey: string): string[] {
  const digest = agentSessionKeyDigest({ provider: "acpx", agent: agentCommand, sessionKey });
  return [
    join(SESSION_COORDINATOR_ROOT, "routes", `${digest}.json`),
    join(SESSION_COORDINATOR_ROOT, "ownership", `${digest}.json`),
    join(SESSION_COORDINATOR_ROOT, "leases", `${digest}.lease`),
  ];
}

/**
 * A path this fixture may write into a generated shell script.
 *
 * Everything here is built from `tmpdir()` and a UUID, so this can only fail if
 * the operator's temporary directory holds a quote or a newline. Refusing is
 * the only safe answer: a script assembled around one would run something else.
 */
function literal(path: string): string {
  if (/['\n\r]/u.test(path)) {
    throw new Error("a fixture path holds a character a shell script cannot carry safely");
  }
  return `'${path}'`;
}

/**
 * The transparent observer XMD's launch reaches instead of `claude`.
 *
 * It records the exact argument vector and the environment it was handed, then
 * `exec`s the resolved CLI with that vector unchanged and the terminal
 * untouched — so what runs afterwards is the installed Claude and not a
 * simulation. Nothing it writes is rendered: the argv is filtered before it
 * reaches a verdict, and the environment dump exists only long enough to answer
 * whether prepared text reached it, then is removed.
 */
function shimSource(journey: Journey): string {
  return [
    "#!/bin/sh",
    `printf 'invocation\\n' >> ${literal(journey.observations)}`,
    'for argument in "$@"; do',
    `  printf 'arg %s\\n' "$argument" >> ${literal(journey.observations)}`,
    "done",
    `env >> ${literal(journey.environmentDump)}`,
    `exec ${literal(journey.realClaude)} "$@"`,
    "",
  ].join("\n");
}

/** One recorded native invocation: the argv the installed CLI received. */
interface Invocation {
  argv: string[];
}

function parseObservations(text: string): Invocation[] {
  const invocations: Invocation[] = [];
  let current: Invocation | undefined;
  for (const line of text.split("\n")) {
    if (line === "invocation") {
      current = { argv: [] };
      invocations.push(current);
      continue;
    }
    if (line.startsWith("arg ") && current) {
      current.argv.push(line.slice(4));
    }
  }
  return invocations;
}

function* observedInvocations(journey: Journey): Operation<Invocation[]> {
  if (!(yield* exists(journey.observations))) {
    return [];
  }
  return parseObservations(yield* until(readFile(journey.observations, "utf8")));
}

function valueOf(invocation: Invocation, flag: string): string | undefined {
  const index = invocation.argv.indexOf(flag);
  return index >= 0 ? invocation.argv[index + 1] : undefined;
}

/** The command shape a verdict may carry: the private path is never in it. */
function filtered(invocation: Invocation): string[] {
  const argv = ["claude", ...invocation.argv];
  const index = argv.indexOf("--system-prompt-file");
  if (index >= 0 && index + 1 < argv.length) {
    argv[index + 1] = PRIVATE_FILE;
  }
  return argv;
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
  launcher?: string;
  failure?: { class?: string };
}

/**
 * The launch records one diagnostic journal holds, in order.
 *
 * A retained preparation carries the prepared instruction text, so this reads
 * it and nothing that reaches a verdict repeats it: what crosses out of here is
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
    if (typeof result.value.phase !== "string") {
      continue;
    }
    records.push(result.value as unknown as LaunchRecord);
  }
  return records;
}

/**
 * Establish one journey's root, byte-for-byte project copy and observer.
 *
 * Teardown is registered as the root appears, and it is the last thing to run:
 * every child is reaped, Claude's own path-scoped purge removes the project it
 * recorded, and the root goes last. The durable accounts are read by a
 * finalizer the caller registers afterwards, which LIFO puts *before* this one.
 */
function* useJourney(label: string, cleanup: CleanupReport): Operation<Journey> {
  const root = join(tmpdir(), `xmd-520-${label}-${randomUUID()}`);
  yield* until(mkdir(root, { recursive: true, mode: 0o700 }));
  yield* until(chmod(root, 0o700));

  const project = join(root, "project");
  yield* until(mkdir(join(project, ".agents"), { recursive: true, mode: 0o700 }));

  const journey: Journey = {
    root,
    // Claude records a project under its resolved path, and on macOS a
    // temporary root reaches it through a symlink. Purging the unresolved
    // spelling would name a project that does not exist.
    project: yield* until(realpath(project)),
    binDirectory: join(root, "bin"),
    observations: join(root, "observations.log"),
    environmentDump: join(root, "environment.dump"),
    journals: [join(root, "journal-1.jsonl"), join(root, "journal-2.jsonl")],
    live: new Set<number>(),
    realClaude: "",
  };

  yield* ensure(function* () {
    for (const pid of journey.live) {
      killed(pid);
    }
    cleanup.liveChildren = [...journey.live].filter(isReachable).length;

    // Claude's own path-scoped purge, never manual deletion of provider state.
    // The dry run is permission to proceed; its raw output is not kept.
    const dryRun = yield* bounded("project-purge-dry-run", PURGE_MS, () =>
      runChild("claude", ["project", "purge", "--dry-run", journey.project], {
        cwd: root,
        live: journey.live,
      }),
    );
    if (dryRun.code === 0) {
      const purge = yield* bounded("project-purge", PURGE_MS, () =>
        runChild("claude", ["project", "purge", "--yes", journey.project], {
          cwd: root,
          live: journey.live,
        }),
      );
      cleanup.projectPurgeOutcome = purge.code === 0 ? "purged" : "failed";
    } else if (`${dryRun.stdout}${dryRun.stderr}`.includes("No Claude Code project state found")) {
      // A journey that never got as far as Claude recording a project has left
      // nothing behind, which is what cleanup is asserting.
      cleanup.projectPurgeOutcome = "nothing-to-purge";
    } else {
      cleanup.projectPurgeOutcome = "failed";
    }

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

/** Resolve the installed CLI, then put the observer in front of it. */
function* installObserver(journey: Journey): Operation<void> {
  const located = yield* bounded("resolve-claude", VERSION_MS, () =>
    runChild("/usr/bin/which", ["claude"], { cwd: journey.root, live: journey.live }),
  );
  journey.realClaude = located.code === 0 ? located.stdout.trim() : "";
  if (journey.realClaude.length === 0) {
    return;
  }
  yield* until(mkdir(journey.binDirectory, { recursive: true, mode: 0o700 }));
  yield* until(writeFile(journey.observations, "", { mode: 0o600 }));
  yield* until(writeFile(journey.environmentDump, "", { mode: 0o600 }));
  const shim = join(journey.binDirectory, "claude");
  yield* until(writeFile(shim, shimSource(journey), { mode: 0o700 }));
  yield* until(chmod(shim, 0o700));
}

/**
 * The environment the production command runs under: an operator's, not this
 * process's.
 *
 * Everything an enclosing Claude Code session exported is dropped, and the
 * count is reported. It is not tidiness: `CLAUDE_CODE_CHILD_SESSION` turns
 * Claude's transcript saving off, and a proof that inherited it would be asking
 * whether a session resumes while having quietly stopped it being saved.
 */
function environmentFor(journey: Journey, verdict: JourneyVerdict): Record<string, string> {
  const inherited: Record<string, string> = {};
  let removed = 0;
  for (const [name, value] of Object.entries(process.env)) {
    if (typeof value !== "string") {
      continue;
    }
    if (inheritedAgentMarker(name)) {
      removed += 1;
      continue;
    }
    inherited[name] = value;
  }
  verdict.inheritedAgentMarkersRemoved = removed;
  inherited.PATH = `${journey.binDirectory}:${inherited.PATH ?? ""}`;
  return inherited;
}

function xmdArguments(journal: string): string[] {
  return ["run", TARGET, "--default-agent", "claude", "--journal", journal, "--raw"];
}

/**
 * Watch for the private instruction file while the child that reads it is live.
 *
 * Mode and kind are facts about a file that exists only for the length of one
 * launch, so they can only be established from inside it. Spawned into the
 * launch's own scope, which is what ends the watch when the launch does.
 */
function* watchPrivateFile(journey: Journey, verdict: JourneyVerdict): Operation<void> {
  while (true) {
    for (const invocation of yield* observedInvocations(journey)) {
      const path = valueOf(invocation, "--system-prompt-file");
      if (path === undefined) {
        continue;
      }
      try {
        const found = yield* until(stat(path));
        verdict.privateFileRegular = found.isFile();
        verdict.privateFileMode = `0${(found.mode & 0o777).toString(8)}`;
        return;
      } catch {
        // Not created yet, or already removed: keep looking while the launch is
        // live, and let the post-launch check settle its absence.
      }
    }
    yield* sleep(OBSERVE_POLL_MS);
  }
}

/** What one production invocation established. */
interface InvocationOutcome {
  exitCode: number;
  children: number;
  refused: boolean;
  reachedSurface: boolean;
  answered: boolean;
  /** What a turn without an answer was showing: a fixed class, never output. */
  answerSurface: string;
  consented: string[];
}

interface TurnPlan {
  /** What to say once the conversation surface is ready, or nothing at all. */
  say?: string;
  /** What proves the answer arrived. */
  expect?: string;
}

function* invoke(
  journey: Journey,
  verdict: JourneyVerdict,
  index: 0 | 1,
  plan: TurnPlan,
): Operation<InvocationOutcome> {
  const before = (yield* observedInvocations(journey)).length;
  const first = index === 0;
  const channels: PtyChannels = {
    charged(bytes) {
      verdict.conversationInputByteCount += bytes;
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
    children: 0,
    refused: false,
    reachedSurface: false,
    answered: false,
    answerSurface: "",
    consented: [],
  };

  yield* ptyRun(
    XMD_BINARY,
    xmdArguments(journey.journals[index]),
    {
      cwd: journey.project,
      env: environmentFor(journey, verdict),
      live: journey.live,
      channels,
    },
    function* (pty): Operation<void> {
      yield* spawn(() => watchPrivateFile(journey, verdict));
      yield* drive(pty, channels, plan, outcome);
      verdict.implementorMarkerRendered ||= pty.saw(IMPLEMENTOR_MARKER);
      verdict.siblingMarkersRendered += SIBLING_MARKERS.filter((marker) => pty.saw(marker)).length;
      outcome.exitCode = pty.exitCode();
    },
  );

  outcome.children = (yield* observedInvocations(journey)).length - before;
  return outcome;
}

/** Drive one process from its opening surface to its exit. */
function* drive(
  pty: Pty,
  channels: PtyChannels,
  plan: TurnPlan,
  outcome: InvocationOutcome,
): Operation<void> {
  const surface = yield* reachSurface(pty, channels);
  outcome.refused = surface.refused;
  outcome.reachedSurface = surface.ready;
  outcome.consented = surface.consented;

  if (surface.refused) {
    // Claude refused this exact identity. XMD's own filtered failure is what
    // the document reads next; nothing is retyped at the surface.
    yield* pty.settle(SETTLE_MS);
    return;
  }
  if (!surface.ready) {
    return;
  }

  const expected = plan.expect ?? "";
  if (plan.say !== undefined && expected.length > 0) {
    pty.type(plan.say);
    // The box has to be holding the whole line before Enter means "send this".
    // Matched on its own tail, which the input box echoes back verbatim.
    const tail = plan.say.slice(-TYPED_TAIL);
    yield* pty.waitFor("typed", SURFACE_MS, (fresh) => shows(fresh, tail));
    pty.send(plan.say);
    try {
      yield* pty.waitFor("answer", ANSWER_MS, (fresh) => shows(fresh, expected));
      outcome.answered = true;
    } catch (error) {
      if (!(error instanceof PhaseTimeout)) {
        throw error;
      }
      // The turn is spent either way. Saying which surface it stopped at is
      // what stops the next one being spent to learn the same nothing.
      outcome.answerSurface = pty.classify(ANSWER_STALLS);
      return;
    }
  }

  // Two Ctrl-D bytes: one to ask the prompt whether it is there, one to leave.
  // A surface reached through the readiness probe has already answered the
  // first, so only the second is owed — unless a turn was typed since, because
  // typing at the prompt cancels the pending exit and a lone Ctrl-D would only
  // re-arm it while this waited for a process that is not leaving.
  if (!surface.probeSent || plan.say !== undefined) {
    pty.control(EOF_BYTE);
    yield* pty.waitFor("affordance", SURFACE_MS, (fresh) => shows(fresh, CTRL_D_AFFORDANCE));
  }
  pty.control(EOF_BYTE);
  channels.exited(EXIT_CONTROL_BYTES);
  yield* pty.settle(SETTLE_MS);
}

/**
 * Read every durable account this journey left, reduce it to filtered evidence,
 * then remove exactly the records for its own natural key.
 *
 * The coordination namespace is machine-wide and shared with whatever else the
 * operator is running, so nothing here sweeps it: three exact absolute paths
 * are named, and a path this run did not create is not one of them.
 */
function* settleAccounts(journey: Journey, verdict: JourneyVerdict): Operation<void> {
  const first = yield* readLaunchRecords(journey.journals[0]);
  const second = yield* readLaunchRecords(journey.journals[1]);
  verdict.journal.firstPhases = first.map((record) => record.phase);
  verdict.journal.secondPhases = second.map((record) => record.phase);
  verdict.journal.failureClasses = [...first, ...second]
    .map((record) => record.failure?.class)
    .filter((entry): entry is string => typeof entry === "string");

  const prepared = [...first, ...second].filter((record) => record.phase === "prepared");
  const head = prepared[0];
  if (head) {
    verdict.journal.provider = head.provider ?? "";
    verdict.journal.agent = head.agent ?? "";
    verdict.journal.launcher = head.launcher ?? "";
    verdict.journal.provenance = head.identityProvenance ?? "";
    verdict.journal.nativeSessionId = head.nativeSessionId ?? "";
    verdict.journal.instructionsDigestPresent = typeof head.instructionsDigest === "string";
    verdict.instructionChannel = head.instructionChannel ?? "";
    verdict.identityProvenance = head.identityProvenance ?? "";
    verdict.nativeSessionId = head.nativeSessionId ?? "";
  }
  verdict.journal.sessionState = prepared
    .map((record) => record.sessionState)
    .filter((entry): entry is string => typeof entry === "string");

  const observed = yield* observedInvocations(journey);
  const opening = observed[0];
  const reentry = observed[1];
  if (opening) {
    verdict.firstCommand = filtered(opening);
  }
  if (reentry) {
    verdict.secondCommand = filtered(reentry);
  }
  const allocated = new Set(
    observed
      .map((invocation) => valueOf(invocation, "--session-id"))
      .filter((value): value is string => typeof value === "string"),
  );
  verdict.identityAllocations = allocated.size;
  verdict.freshFallback = reentry !== undefined && valueOf(reentry, "--session-id") !== undefined;
  const resumed = reentry ? valueOf(reentry, "--resume") : undefined;
  const created = opening ? valueOf(opening, "--session-id") : undefined;
  verdict.substitutedIdentity =
    resumed !== undefined && created !== undefined && resumed !== created;

  // The prepared text, held here and nowhere else. It answers the two questions
  // about where it travelled, and reaches no rendered field.
  const instructions = head?.instructions ?? "";
  if (instructions.length > 0) {
    const probes = [instructions.trim(), OPENING_SENTENCE];
    verdict.preparedTextInArgv = observed.some((invocation) =>
      invocation.argv.some((argument) => probes.some((probe) => argument.includes(probe))),
    );
    const dump = (yield* exists(journey.environmentDump))
      ? yield* until(readFile(journey.environmentDump, "utf8"))
      : "";
    verdict.preparedTextInEnvironment = probes.some((probe) => dump.includes(probe));
  }
  // Removed as soon as it has answered rather than at teardown: it is the one
  // artifact here that holds the operator's whole environment.
  yield* rm(journey.environmentDump, { recursive: false, force: true });

  const sessionKey = head?.sessionKey;
  if (typeof sessionKey === "string" && sessionKey.length > 0) {
    const paths = keyPaths(createAgentRegistry().resolve("claude"), sessionKey);
    const [route] = paths;
    if (route !== undefined && (yield* exists(route))) {
      const parsed: unknown = JSON.parse(yield* until(readFile(route, "utf8")));
      if (isRecord(parsed)) {
        verdict.route.kind = typeof parsed.route === "string" ? parsed.route : "";
        verdict.route.provenance =
          typeof parsed.identityProvenance === "string" ? parsed.identityProvenance : "";
        verdict.route.launcher = typeof parsed.launcher === "string" ? parsed.launcher : "";
        verdict.route.nativeSessionId =
          typeof parsed.nativeSessionId === "string" ? parsed.nativeSessionId : "";
        verdict.route.instructionsDigestPresent = typeof parsed.instructionsDigest === "string";
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
  verdict.routeConverted = verdict.route.kind !== "" && verdict.route.kind !== "client-native";

  // The private file belonged to the launch that wrote it. It and the directory
  // holding it are gone once that ownership ended.
  const privatePaths = observed
    .map((invocation) => valueOf(invocation, "--system-prompt-file"))
    .filter((path): path is string => typeof path === "string");
  let fileGone = true;
  let directoryGone = true;
  for (const path of privatePaths) {
    fileGone &&= !(yield* exists(path));
    directoryGone &&= !(yield* exists(dirname(path)));
  }
  verdict.cleanup.privateFileRemoved = fileGone;
  verdict.cleanup.privateDirectoryRemoved = directoryGone;

  let journalsGone = true;
  for (const path of journey.journals) {
    yield* rm(path, { recursive: false, force: true });
    journalsGone &&= !(yield* exists(path));
  }
  verdict.cleanup.journalsRemoved = journalsGone;
}

function* claudeVersion(journey: Journey): Operation<string> {
  const reported = yield* bounded("claude-version", VERSION_MS, () =>
    runChild("claude", ["--version"], { cwd: journey.root, live: journey.live }),
  );
  return reported.code === 0 ? reported.stdout.trim() : "";
}

/** Everything both journeys establish before they are allowed to launch. */
function* ready(journey: Journey, verdict: JourneyVerdict): Operation<boolean> {
  if (journey.realClaude.length === 0) {
    verdict.verdict = "ENVIRONMENT_BLOCKED";
    verdict.detail = "no installed claude executable was found on PATH";
    return false;
  }
  verdict.claudeVersion = yield* claudeVersion(journey);
  if (verdict.claudeVersion !== REQUIRED_CLAUDE_VERSION) {
    verdict.verdict = "ENVIRONMENT_BLOCKED";
    verdict.detail = `this journey is only meaningful against ${REQUIRED_CLAUDE_VERSION}`;
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
 * The zero-turn journey: leave a launched session without saying anything, then
 * come back to it through the same production command.
 */
function* runZeroTurn(journey: Journey, verdict: JourneyVerdict): Operation<void> {
  if (!(yield* ready(journey, verdict))) {
    return;
  }

  const first = yield* invoke(journey, verdict, 0, {});
  verdict.firstXmdExitCode = first.exitCode;
  verdict.firstInvocationChildren = first.children;
  if (!first.reachedSurface) {
    verdict.verdict = "HARNESS_FAILED";
    verdict.detail = "the first launch never reached a recognizable conversation surface";
    return;
  }

  const second = yield* invoke(journey, verdict, 1, {});
  verdict.secondXmdExitCode = second.exitCode;
  verdict.secondInvocationChildren = second.children;
  verdict.outcome = second.refused
    ? "no-session"
    : second.reachedSurface
      ? "same-identity"
      : "unresolved";
}

/**
 * The two-turn journey: one first turn in a session the adapter named, and one
 * turn after a second independent invocation resumed that same identity.
 */
function* runTwoTurn(journey: Journey, verdict: JourneyVerdict, marker: string): Operation<void> {
  if (!(yield* ready(journey, verdict))) {
    return;
  }

  // The question names neither the sentence nor any file, so a session without
  // the prepared layer cannot answer it. The marker is planted here and nowhere
  // else — not in the instruction file, the argv, the environment or the key.
  const first = yield* invoke(journey, verdict, 0, {
    say:
      "Do not use any tools. Reply with exactly two lines. First line: the " +
      "opening sentence of your role contract, copied verbatim. Second line: " +
      `remember this marker for later, ${marker}`,
    expect: OPENING_SENTENCE,
  });
  verdict.firstXmdExitCode = first.exitCode;
  verdict.firstInvocationChildren = first.children;
  verdict.openingSentenceExact = first.answered;
  verdict.answerSurface = first.answerSurface;
  if (!first.reachedSurface) {
    verdict.verdict = "HARNESS_FAILED";
    verdict.detail = "the first launch never reached a recognizable conversation surface";
    return;
  }
  if (!first.answered) {
    // A turn has been spent. Whether that is the product's answer or a surface
    // the harness could not drive is exactly what `answerSurface` says, and
    // neither is something to spend a second turn discovering.
    verdict.verdict = "PRODUCT_FAILED";
    verdict.detail = `the first native turn stopped at a ${first.answerSurface} surface`;
    return;
  }

  const second = yield* invoke(journey, verdict, 1, {
    say:
      "Do not use any tools. Reply with exactly one line and nothing else: " +
      `${RECALL_PREFIX} followed immediately by the marker you were asked to ` +
      "remember in the preceding user turn.",
    expect: `${RECALL_PREFIX}${marker}`,
  });
  verdict.secondXmdExitCode = second.exitCode;
  verdict.secondInvocationChildren = second.children;
  verdict.markerRecovered = second.answered;
  if (!second.answered) {
    verdict.answerSurface = second.answerSurface;
  }
  verdict.outcome = second.answered ? "same-identity" : "unresolved";
}

const ZERO_TURN_ACCEPTED: readonly string[] = ["same-identity", "no-session"];

function decideZeroTurn(verdict: JourneyVerdict): void {
  if (!ZERO_TURN_ACCEPTED.includes(verdict.outcome)) {
    verdict.verdict = "PRODUCT_FAILED";
    verdict.detail = "re-entry was neither the same identity nor an explicit refusal";
    return;
  }
  if (verdict.substitutedIdentity || verdict.freshFallback || verdict.routeConverted) {
    verdict.verdict = "PRODUCT_FAILED";
    verdict.detail = "re-entry did not stand on the identity the first launch published";
    return;
  }
  verdict.verdict = "PASS";
  verdict.detail =
    verdict.outcome === "same-identity"
      ? "re-entry reached its conversation surface under the exact retained identity"
      : "re-entry refused the exact retained identity, and XMD failed closed";
}

function decideTwoTurn(verdict: JourneyVerdict): void {
  if (!verdict.openingSentenceExact) {
    verdict.verdict = "PRODUCT_FAILED";
    verdict.detail = "the prepared layer did not govern the first native turn";
    return;
  }
  if (!verdict.markerRecovered) {
    verdict.verdict = "PRODUCT_FAILED";
    verdict.detail = "the resumed session did not carry the first turn's history";
    return;
  }
  if (verdict.substitutedIdentity || verdict.freshFallback || verdict.routeConverted) {
    verdict.verdict = "PRODUCT_FAILED";
    verdict.detail = "the second invocation did not resume the identity the first published";
    return;
  }
  verdict.verdict = "PASS";
  verdict.detail = "the prepared layer governed the first turn and the same identity resumed it";
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
  if (!verdict.authorized) {
    verdict.verdict = "REFUSED";
    verdict.refusal = "opt-in-absent";
    verdict.detail = `set ${PROOF_ENV}=1 to run this journey against the installed Claude`;
    return verdict;
  }
  if (process.env.CLAUDE_CONFIG_DIR !== undefined) {
    verdict.verdict = "REFUSED";
    verdict.refusal = "claude-config-dir-set";
    verdict.detail = "unset CLAUDE_CONFIG_DIR so Claude uses its authenticated configuration";
    return verdict;
  }
  if (mode === "two-turn" && process.env[TURNS_ENV] !== AUTHORIZED_TURNS) {
    verdict.verdict = "REFUSED";
    verdict.refusal = "turns-not-authorized";
    verdict.detail = `set ${TURNS_ENV}=${AUTHORIZED_TURNS} to spend exactly two model turns`;
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
      yield* installObserver(journey);
      yield* body(journey, verdict);
      // Reached only when the body ran every phase without classifying a
      // failure of its own, which is the one state a verdict may be decided in.
      settled = verdict.verdict === "HARNESS_FAILED";
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
  claudeVersion: string;
  platform: string;
  architecture: string;
  claudeConfigDirSet: boolean;
  sessionIdFlag: boolean;
  systemPromptFileFlag: boolean;
  resumeFlag: boolean;
  projectPurgeSurface: boolean;
  credentialsUsable: boolean;
  ptyUsable: boolean;
  binaryBuilt: boolean;
  advertised: string[];
  modelTurns: number;
  conversationInputByteCount: number;
  privateStateInspected: boolean;
}

/**
 * Whether the installed CLI recognizes one option, established without a turn.
 *
 * An option this build does not have is reported by name; one it has fails on
 * its value instead. Both answers arrive before a model request, so asking the
 * question costs nothing.
 */
function recognized(outcome: ChildOutcome, option: string): boolean {
  return !`${outcome.stdout}${outcome.stderr}`.includes(`unknown option '${option}'`);
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
    claudeVersion: "",
    platform: process.platform,
    architecture: process.arch,
    claudeConfigDirSet: process.env.CLAUDE_CONFIG_DIR !== undefined,
    sessionIdFlag: false,
    systemPromptFileFlag: false,
    resumeFlag: false,
    projectPurgeSurface: false,
    credentialsUsable: false,
    ptyUsable: false,
    binaryBuilt: false,
    advertised: [...ADVERTISED_NATIVE_LAUNCH],
    modelTurns: 0,
    conversationInputByteCount: 0,
    privateStateInspected: false,
  };
  if (!verdict.authorized) {
    verdict.verdict = "REFUSED";
    verdict.refusal = "opt-in-absent";
    verdict.detail = `set ${PROOF_ENV}=1 to run preflight against the installed Claude`;
    return verdict;
  }

  const live: LiveSet = new Set<number>();
  const cwd = REPO_ROOT;

  verdict.head = (yield* runChild("git", ["rev-parse", "HEAD"], { cwd, live })).stdout.trim();
  verdict.branch = (yield* runChild("git", ["branch", "--show-current"], {
    cwd,
    live,
  })).stdout.trim();

  const version = yield* bounded("claude-version", VERSION_MS, () =>
    runChild("claude", ["--version"], { cwd, live }),
  );
  verdict.claudeVersion = version.code === 0 ? version.stdout.trim() : "";

  // Every invocation below is given empty stdin and fails on an argument rather
  // than reaching a model.
  const missing = join(tmpdir(), `xmd-520-absent-${randomUUID()}`);
  const options = yield* bounded("claude-options", VERSION_MS, () =>
    runChild("claude", ["--session-id", randomUUID(), "--system-prompt-file", missing, "--print"], {
      cwd,
      live,
      input: "",
    }),
  );
  verdict.sessionIdFlag = recognized(options, "--session-id");
  verdict.systemPromptFileFlag =
    recognized(options, "--system-prompt-file") &&
    `${options.stdout}${options.stderr}`.includes("System prompt file not found");
  const resume = yield* bounded("claude-resume", VERSION_MS, () =>
    runChild("claude", ["--resume", randomUUID(), "--print"], { cwd, live, input: "" }),
  );
  verdict.resumeFlag = recognized(resume, "--resume");

  const purge = yield* bounded("claude-purge-help", VERSION_MS, () =>
    runChild("claude", ["project", "purge", "--help"], { cwd, live }),
  );
  verdict.projectPurgeSurface = purge.code === 0 && purge.stdout.includes("--dry-run");

  // Whether an account is usable, and nothing about whose it is.
  const auth = yield* bounded("claude-auth-status", VERSION_MS, () =>
    runChild("claude", ["auth", "status"], { cwd, live }),
  );
  if (auth.code === 0) {
    try {
      const parsed: unknown = JSON.parse(auth.stdout);
      verdict.credentialsUsable = isRecord(parsed) && parsed.loggedIn === true;
    } catch {
      verdict.credentialsUsable = false;
    }
  }

  const pty = yield* bounded("pty-capability", VERSION_MS, () =>
    runChild("/usr/bin/script", ["-q", "/dev/null", "/bin/sh", "-c", "test -t 1 && echo PTY"], {
      cwd,
      live,
    }),
  );
  verdict.ptyUsable = pty.stdout.includes("PTY");
  verdict.binaryBuilt = yield* exists(XMD_BINARY);

  const established =
    verdict.claudeVersion === REQUIRED_CLAUDE_VERSION &&
    verdict.platform === "darwin" &&
    verdict.architecture === "arm64" &&
    !verdict.claudeConfigDirSet &&
    verdict.sessionIdFlag &&
    verdict.systemPromptFileFlag &&
    verdict.resumeFlag &&
    verdict.projectPurgeSurface &&
    verdict.credentialsUsable &&
    verdict.ptyUsable &&
    verdict.binaryBuilt &&
    verdict.advertised.length === 1 &&
    verdict.advertised[0] === "claude";
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
  if (mode === "zero-turn") {
    render(yield* runJourney("zero-turn", runZeroTurn, decideZeroTurn));
    return;
  }
  if (mode === "two-turn") {
    // Planted only in the first native user turn. Recovering it in the second
    // is what makes the resumed session the same conversation rather than a new
    // one wearing the same name.
    const marker = `MK${randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase()}`;
    render(
      yield* runJourney(
        "two-turn",
        (journey, verdict) => runTwoTurn(journey, verdict, marker),
        decideTwoTurn,
      ),
    );
    return;
  }

  throw new Error(`claude-native-launch-proof: unknown mode "${mode ?? ""}"`);
});
