/**
 * Issue #561 — a native Claude session, continued through an ACP prompt.
 *
 * `ClaudeNativeToAcp.test.md` owns the sequencing, the gating, the schema, the
 * assertions and everything an operator reads. This fixture owns only what an
 * authored document cannot reach: a pseudo-terminal, child lifecycle, the
 * argument vector a native CLI actually received, file modes, structured route,
 * journal and provider-arrangement reads, and exact-path cleanup.
 *
 * What it does not own is the product. Two ordinary production commands run,
 * in one private project directory:
 *
 *     dist/xmd run AGENTS.md#Implementor --default-agent claude --journal … --raw
 *     dist/xmd run <checked-in prompt document> --default-agent claude --journal … --raw
 *
 * The first prepares a session Claude's native UI creates under an identity XMD
 * chose, and one authorized native turn plants a random marker in it. The
 * second is an authored, marker-free `<Session name="implementer"><Prompt>` —
 * an ordinary ACP turn, through the same built binary, in the same directory.
 *
 * Recovering the marker there is the whole claim. Equal identities are not:
 * two accounts agreeing about a UUID says nothing about whether the
 * conversation behind it is the one the native turn happened in.
 *
 * The first command runs inside a byte-for-byte copy of the repository's own
 * `AGENTS.md` and `.agents/implementor.md`, and the second runs the checked-in
 * document verbatim. No Markdown is built, interpolated or rewritten here — a
 * proof that assembled its own documents would be proving something nobody
 * runs.
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
import { agentSessionKeyDigest, createDenoExecutableObserver } from "@executablemd/runtime";
import { allocatesIdentity, nativeAdapterFor } from "../../src/native-launch.ts";
import { createDenoSessionRouteStore } from "../../src/session-route.ts";
import { deriveSessionKey } from "../../src/session-key.ts";

/** Opting in at all. Absent, this refuses before a provider child. */
const PROOF_ENV = "XMD_CLAUDE_ATTACHMENT_PROOF";
/**
 * The separate, exact grant this journey spends: one native marker turn and one
 * marker-free ACP recall turn. The missing-identity case spends none.
 */
const TURNS_ENV = "XMD_CLAUDE_MODEL_TURNS_AUTHORIZED";
const AUTHORIZED_TURNS = "2";

/** The checked-in ACP prompt document, run verbatim. It carries no marker. */
const ACP_DOCUMENT = fileURLToPath(new URL("./claude-native-to-acp-prompt.md", import.meta.url));

/**
 * The prefix the ACP answer must carry.
 *
 * Resuming a native session redraws what is already there, so a marker found on
 * a screen proves only that a transcript was repainted. An ACP turn draws
 * nothing, and this prefix appears in no earlier turn — so only an answer can
 * produce it beside the marker.
 */
const RECOVER_PREFIX = "RECOVERED-";

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

type Mode = "native-to-acp";

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

    const started = spawnChild(command, args, {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      ...(options.env === undefined ? {} : { env: options.env }),
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
  /** The second project, whose route names a conversation nobody ever had. */
  absentProject: string;
  /** That project's logical session key, so its records can be removed exactly. */
  absentKey: string;
  journals: [string, string, string];
  live: LiveSet;
  realClaude: string;
}

interface CleanupReport {
  liveChildren: number;
  privateFileRemoved: boolean;
  privateDirectoryRemoved: boolean;
  journalsRemoved: boolean;
  routeRecordsRemoved: boolean;
  providerArrangementRemoved: boolean;
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
  firstInvocationChildren: number;
  firstXmdExitCode: number;
  /** The ACP invocation: an ordinary `xmd run`, with no terminal to drive. */
  acpXmdExitCode: number;
  acpDocument: string;
  acpDocumentCarriesMarker: boolean;
  /** How many native children the ACP invocation started. Zero, or it launched. */
  acpInvocationChildren: number;

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
  /** The bound ACP adapter this attachment is proven against. */
  adapterCommand: string;
  /** How many markers of an enclosing agent session were kept out. */
  inheritedAgentMarkersRemoved: number;
  markerStored: boolean;
  markerRecovered: boolean;
  markerInReportedEvidence: boolean;
  answerSurface: string;
  outcome: string;

  route: {
    schema: string;
    kind: string;
    provenance: string;
    launcher: string;
    nativeSessionId: string;
    instructionsDigestPresent: boolean;
    buildVersion: string;
    buildDigestPresent: boolean;
  };
  journal: {
    provider: string;
    agent: string;
    launcher: string;
    provenance: string;
    nativeSessionId: string;
    sessionState: string[];
    instructionsDigestPresent: boolean;
    buildVersion: string;
    firstPhases: string[];
    failureClasses: string[];
  };
  /** What the ACP client's own arrangement asserts about this session. */
  arrangement: {
    present: boolean;
    agentSessionId: string;
  };
  /** The build this run observed, reobserved after the whole journey. */
  observed: {
    version: string;
    digestPresent: boolean;
    matchesRoute: boolean;
  };
  /** The independent case: a route naming a conversation nobody ever had. */
  absent: {
    ran: boolean;
    xmdExitCode: number;
    failureClass: string;
    modelTurns: number;
    nativeChildren: number;
    answered: boolean;
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
    firstInvocationChildren: 0,
    firstXmdExitCode: -1,
    acpXmdExitCode: -1,
    acpDocument: "claude-native-to-acp-prompt.md",
    acpDocumentCarriesMarker: false,
    acpInvocationChildren: 0,
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
    adapterCommand: "",
    inheritedAgentMarkersRemoved: 0,
    markerStored: false,
    markerRecovered: false,
    markerInReportedEvidence: false,
    answerSurface: "",
    outcome: "unresolved",
    route: {
      schema: "",
      kind: "",
      provenance: "",
      launcher: "",
      nativeSessionId: "",
      instructionsDigestPresent: false,
      buildVersion: "",
      buildDigestPresent: false,
    },
    journal: {
      provider: "",
      agent: "",
      launcher: "",
      provenance: "",
      nativeSessionId: "",
      sessionState: [],
      instructionsDigestPresent: false,
      buildVersion: "",
      firstPhases: [],
      failureClasses: [],
    },
    arrangement: { present: false, agentSessionId: "" },
    observed: { version: "", digestPresent: false, matchesRoute: false },
    absent: {
      ran: false,
      xmdExitCode: -1,
      failureClass: "",
      modelTurns: 0,
      nativeChildren: 0,
      answered: false,
    },
    cleanup: {
      liveChildren: 0,
      privateFileRemoved: false,
      privateDirectoryRemoved: false,
      journalsRemoved: false,
      routeRecordsRemoved: false,
      providerArrangementRemoved: false,
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

/** Where the ACP client keeps its own arrangement for one session key. */
const ACPX_SESSION_DIR = join(homedir(), ".acpx", "sessions");

/**
 * The one arrangement record this run's session key owns.
 *
 * The ACP client's own store, which is XMD's arrangement rather than Claude's
 * history: it says which conversation this client was told to open, and holds
 * no transcript. Nothing beneath Claude's configuration, projects or history is
 * opened anywhere in this fixture.
 */
function arrangementPath(sessionKey: string): string {
  return join(ACPX_SESSION_DIR, `${encodeURIComponent(sessionKey)}.json`);
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
  executableBinding?: unknown;
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
  // A second directory, so the absent-identity case is a different logical
  // session entirely. Naming a fresh identity for the session that just worked
  // would be overwriting the account this journey is about to read.
  const absentProject = join(root, "absent");
  yield* until(mkdir(absentProject, { recursive: true, mode: 0o700 }));

  const journey: Journey = {
    root,
    // Claude records a project under its resolved path, and on macOS a
    // temporary root reaches it through a symlink. Purging the unresolved
    // spelling would name a project that does not exist.
    project: yield* until(realpath(project)),
    binDirectory: join(root, "bin"),
    observations: join(root, "observations.log"),
    environmentDump: join(root, "environment.dump"),
    absentProject: yield* until(realpath(absentProject)),
    // Filled in once the absent case has derived it from the product's own key
    // rule; empty until then, so nothing is removed under a guessed name.
    absentKey: "",
    journals: [
      join(root, "journal-native.jsonl"),
      join(root, "journal-acp.jsonl"),
      join(root, "journal-absent.jsonl"),
    ],
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

function xmdArguments(root: string, journal: string): string[] {
  return ["run", root, "--default-agent", "claude", "--journal", journal, "--raw"];
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
  plan: TurnPlan,
): Operation<InvocationOutcome> {
  const before = (yield* observedInvocations(journey)).length;
  const channels: PtyChannels = {
    charged(bytes) {
      verdict.conversationInputByteCount += bytes;
      verdict.modelTurns += 1;
    },
    consented(surface, bytes) {
      verdict.consentSurfaces = [...verdict.consentSurfaces, surface];
      verdict.consentInputBytes += bytes;
    },
    exited(bytes) {
      verdict.exitControlBytes = bytes;
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
    xmdArguments(TARGET, journey.journals[0]),
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
 * then remove exactly the records for its own natural keys.
 *
 * The coordination namespace and the ACP client's session store are both
 * machine-wide and shared with whatever else the operator is running, so
 * nothing here sweeps either: exact absolute paths are named, and a path this
 * run did not create is not one of them.
 */
function* settleAccounts(journey: Journey, verdict: JourneyVerdict): Operation<void> {
  const native = yield* readLaunchRecords(journey.journals[0]);
  verdict.journal.firstPhases = native.map((record) => record.phase);
  verdict.journal.failureClasses = native
    .map((record) => record.failure?.class)
    .filter((entry): entry is string => typeof entry === "string");

  const prepared = native.filter((record) => record.phase === "prepared");
  const head = prepared[0];
  if (head) {
    verdict.journal.provider = head.provider ?? "";
    verdict.journal.agent = head.agent ?? "";
    verdict.journal.launcher = head.launcher ?? "";
    verdict.journal.provenance = head.identityProvenance ?? "";
    verdict.journal.nativeSessionId = head.nativeSessionId ?? "";
    verdict.journal.instructionsDigestPresent = typeof head.instructionsDigest === "string";
    verdict.journal.buildVersion = bindingVersion(head.executableBinding);
    verdict.instructionChannel = head.instructionChannel ?? "";
    verdict.identityProvenance = head.identityProvenance ?? "";
    verdict.nativeSessionId = head.nativeSessionId ?? "";
  }
  verdict.journal.sessionState = prepared
    .map((record) => record.sessionState)
    .filter((entry): entry is string => typeof entry === "string");

  const observed = yield* observedInvocations(journey);
  const opening = observed[0];
  if (opening) {
    verdict.firstCommand = filtered(opening);
  }
  const allocated = new Set(
    observed
      .map((invocation) => valueOf(invocation, "--session-id"))
      .filter((value): value is string => typeof value === "string"),
  );
  verdict.identityAllocations = allocated.size;
  // Nothing after the native launch may start a Claude of its own: an ACP turn
  // that spawned one would be a native UI, not an attachment.
  verdict.substitutedIdentity = observed.length > 1;
  verdict.freshFallback = allocated.size > 1;

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

  const agentCommand = createAgentRegistry().resolve("claude");
  const sessionKey = head?.sessionKey;
  let removed = true;
  if (typeof sessionKey === "string" && sessionKey.length > 0) {
    const paths = keyPaths(agentCommand, sessionKey);
    const [route] = paths;
    if (route !== undefined && (yield* exists(route))) {
      const parsed: unknown = JSON.parse(yield* until(readFile(route, "utf8")));
      if (isRecord(parsed)) {
        verdict.route.schema = typeof parsed.schema === "string" ? parsed.schema : "";
        verdict.route.kind = typeof parsed.route === "string" ? parsed.route : "";
        verdict.route.provenance =
          typeof parsed.identityProvenance === "string" ? parsed.identityProvenance : "";
        verdict.route.launcher = typeof parsed.launcher === "string" ? parsed.launcher : "";
        verdict.route.nativeSessionId =
          typeof parsed.nativeSessionId === "string" ? parsed.nativeSessionId : "";
        verdict.route.instructionsDigestPresent = typeof parsed.instructionsDigest === "string";
        verdict.route.buildVersion = bindingVersion(parsed.executableBinding);
        verdict.route.buildDigestPresent = bindingDigestPresent(parsed.executableBinding);
      }
    }
    // The ACP client's own arrangement for this exact session key. Present
    // means the attachment reached the client at all; what it asserts is which
    // conversation the client was told to open.
    const arrangement = arrangementPath(sessionKey);
    if (yield* exists(arrangement)) {
      const parsed: unknown = JSON.parse(yield* until(readFile(arrangement, "utf8")));
      if (isRecord(parsed)) {
        verdict.arrangement.present = true;
        verdict.arrangement.agentSessionId =
          typeof parsed.agentSessionId === "string" ? parsed.agentSessionId : "";
      }
    }
    for (const path of [...paths, arrangement]) {
      yield* rm(path, { recursive: false, force: true });
      removed &&= !(yield* exists(path));
    }
    verdict.cleanup.providerArrangementRemoved = !(yield* exists(arrangement));
  } else {
    verdict.cleanup.providerArrangementRemoved = true;
  }
  // The absent-identity case published a route of its own, under its own key.
  for (const path of keyPaths(agentCommand, journey.absentKey)) {
    yield* rm(path, { recursive: false, force: true });
    removed &&= !(yield* exists(path));
  }
  verdict.cleanup.routeRecordsRemoved = removed;
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

/** The canonical version a retained build binding names, or nothing. */
function bindingVersion(value: unknown): string {
  if (!isRecord(value)) {
    return "";
  }
  return typeof value.reportedVersion === "string" ? value.reportedVersion : "";
}

function bindingDigestPresent(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const digest = value.executableDigest;
  return isRecord(digest) && typeof digest.value === "string" && digest.value.length === 64;
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
 * The journey: one native marker turn, then a marker-free ACP prompt that has
 * to recover it, then an independent identity nobody ever had.
 */
function* runAttachment(
  journey: Journey,
  verdict: JourneyVerdict,
  marker: string,
): Operation<void> {
  if (!(yield* ready(journey, verdict))) {
    return;
  }
  verdict.adapterCommand = boundAdapterCommand();
  verdict.acpDocumentCarriesMarker = (yield* until(readFile(ACP_DOCUMENT, "utf8"))).includes(
    marker,
  );

  // One native turn. The marker is planted here and nowhere else — not in the
  // instruction file, the argument vector, the environment, the session key or
  // the document the ACP turn runs. The reply is a fixed word, so the marker
  // never reaches the screen either.
  const native = yield* invoke(journey, verdict, {
    say:
      "Do not use any tools. Remember this marker for later: " +
      `${marker}. Reply with exactly one line and nothing else: MARKER-STORED`,
    expect: "MARKER-STORED",
  });
  verdict.firstXmdExitCode = native.exitCode;
  verdict.firstInvocationChildren = native.children;
  verdict.markerStored = native.answered;
  verdict.answerSurface = native.answerSurface;
  if (!native.reachedSurface) {
    verdict.verdict = "HARNESS_FAILED";
    verdict.detail = "the native launch never reached a recognizable conversation surface";
    return;
  }
  if (!native.answered) {
    // A turn has been spent. Whether that is the product's answer or a surface
    // this harness could not drive is exactly what `answerSurface` says, and
    // neither is worth a second turn to rediscover.
    verdict.verdict = "PRODUCT_FAILED";
    verdict.detail = `the native turn stopped at a ${native.answerSurface} surface`;
    return;
  }

  // The second command: the checked-in document, verbatim, through the same
  // built binary in the same directory. No terminal, no consent, no native
  // child — an ordinary ACP turn against the session the native process made.
  const before = (yield* observedInvocations(journey)).length;
  const acp = yield* bounded("acp-prompt", ANSWER_MS, () =>
    runChild(XMD_BINARY, xmdArguments(ACP_DOCUMENT, journey.journals[1]), {
      cwd: journey.project,
      env: environmentFor(journey, verdict),
      live: journey.live,
    }),
  );
  verdict.modelTurns += 1;
  verdict.acpXmdExitCode = acp.code ?? -1;
  verdict.acpInvocationChildren = (yield* observedInvocations(journey)).length - before;
  // The one thing that crosses out of the answer is whether the marker came
  // back behind a prefix that appears in no earlier turn. The answer itself
  // stays here.
  verdict.markerRecovered = squeeze(acp.stdout).includes(`${RECOVER_PREFIX}${marker}`);
  verdict.outcome = verdict.markerRecovered ? "same-conversation" : "unresolved";

  // Reobserved after the whole journey, against what the route retained. A
  // build that moved is the same build; a build that changed is not.
  const reobserved = yield* observeBuild(journey);
  verdict.observed.version = reobserved.version;
  verdict.observed.digestPresent = reobserved.digest.length === 64;

  yield* runAbsentIdentity(journey, verdict);
}

/** The exact ACP adapter command a bound Claude attachment is proven against. */
function boundAdapterCommand(): string {
  const adapter = nativeAdapterFor("claude");
  if (!adapter || !allocatesIdentity(adapter)) {
    return "";
  }
  return adapter.binding.adapterCommand ?? "";
}

/** What this run's own observer says the installed Claude build is. */
function* observeBuild(journey: Journey): Operation<{ version: string; digest: string }> {
  const observer = createDenoExecutableObserver();
  if (!observer) {
    return { version: "", digest: "" };
  }
  const found = yield* observer.observe("claude");
  const adapter = nativeAdapterFor("claude");
  const version =
    adapter && allocatesIdentity(adapter)
      ? adapter.binding.version(found.versionOutput)
      : undefined;
  void journey;
  return { version: version ?? "", digest: found.digest.value };
}

/**
 * The independent case: a bound route naming a conversation nobody ever had.
 *
 * A second directory, so this is a different logical session and the account
 * the journey above is about to read is left exactly as it was. The route is
 * published directly — it is the input this case exists to supply — and no
 * provider arrangement is created for it, because the whole question is what
 * happens when the identity is absent.
 *
 * It spends no model turn, and a provider that quietly created empty history
 * instead of refusing would answer the prompt and fail this.
 */
function* runAbsentIdentity(journey: Journey, verdict: JourneyVerdict): Operation<void> {
  const agentCommand = createAgentRegistry().resolve("claude");
  const sessionKey = deriveSessionKey(agentCommand, journey.absentProject, "implementer");
  journey.absentKey = sessionKey;
  const store = createDenoSessionRouteStore(SESSION_COORDINATOR_ROOT);
  const observed = yield* observeBuild(journey);
  if (!store || observed.version.length === 0 || observed.digest.length !== 64) {
    verdict.verdict = "HARNESS_FAILED";
    verdict.detail = "the absent-identity case could not name a build to bind to";
    return;
  }
  yield* store.publish({
    schema: "session-route.v2",
    route: "client-native",
    provider: "acpx",
    agent: agentCommand,
    sessionKey,
    nativeSessionId: randomUUID(),
    identityProvenance: "client-allocated",
    instructionsDigest: createHash("sha256").update(sessionKey).digest("hex"),
    launcher: "claude",
    executableBinding: {
      schema: "executable-build.v1",
      reportedVersion: observed.version,
      executableDigest: { algorithm: "sha256", value: observed.digest },
    },
  });

  const before = (yield* observedInvocations(journey)).length;
  const turnsBefore = verdict.modelTurns;
  const attempt = yield* bounded("absent-identity", ANSWER_MS, () =>
    runChild(XMD_BINARY, xmdArguments(ACP_DOCUMENT, journey.journals[2]), {
      cwd: journey.absentProject,
      env: environmentFor(journey, verdict),
      live: journey.live,
    }),
  );
  verdict.absent.ran = true;
  verdict.absent.xmdExitCode = attempt.code ?? -1;
  verdict.absent.nativeChildren = (yield* observedInvocations(journey)).length - before;
  verdict.absent.modelTurns = verdict.modelTurns - turnsBefore;
  // An answer at all would mean history was created for an identity nobody
  // ever had. The failure class is the product's own, filtered.
  verdict.absent.answered = squeeze(attempt.stdout).includes(RECOVER_PREFIX);
  verdict.absent.failureClass = refusalClass(`${attempt.stdout}${attempt.stderr}`);
}

/**
 * Which refusal a failed run reported, from its own diagnostic wording.
 *
 * A fixed set of stable classes, matched literally. Nothing else from the
 * output is kept, and an unrecognized failure stays unnamed rather than being
 * quoted.
 */
function refusalClass(output: string): string {
  const known = [
    "identity-unavailable",
    "executable-binding-refused",
    "unsupported-capability",
    "session-busy",
    "session-recovery-required",
  ];
  const found = known.find((name) => output.includes(name));
  if (found) {
    return found;
  }
  // The `<Session>`/`<Prompt>` surface raises rather than retaining a class, so
  // its own settled wording is what names the same refusal.
  if (output.includes("could not open")) {
    return "identity-unavailable";
  }
  if (output.includes("before XMD recorded which build") || output.includes("would use")) {
    return "executable-binding-refused";
  }
  return "";
}

function decideAttachment(verdict: JourneyVerdict): void {
  if (verdict.acpDocumentCarriesMarker) {
    verdict.verdict = "HARNESS_FAILED";
    verdict.detail = "the ACP document carries the marker, so recovering it would prove nothing";
    return;
  }
  if (!verdict.markerStored) {
    verdict.verdict = "PRODUCT_FAILED";
    verdict.detail = "the native turn did not complete, so there is no history to continue";
    return;
  }
  if (!verdict.markerRecovered) {
    verdict.verdict = "PRODUCT_FAILED";
    verdict.detail = "the ACP prompt did not recover the native turn's history";
    return;
  }
  const identities = new Set([
    verdict.nativeSessionId,
    verdict.route.nativeSessionId,
    verdict.journal.nativeSessionId,
    verdict.arrangement.agentSessionId,
  ]);
  if (verdict.nativeSessionId.length === 0 || identities.size !== 1) {
    verdict.verdict = "PRODUCT_FAILED";
    verdict.detail = "the route, the journal and the ACP arrangement do not name one conversation";
    return;
  }
  verdict.observed.matchesRoute =
    verdict.observed.version.length > 0 && verdict.observed.version === verdict.route.buildVersion;
  if (
    !verdict.observed.matchesRoute ||
    verdict.journal.buildVersion !== verdict.route.buildVersion
  ) {
    verdict.verdict = "PRODUCT_FAILED";
    verdict.detail = "the retained build and the build this run would use are not the same";
    return;
  }
  if (verdict.substitutedIdentity || verdict.freshFallback || verdict.routeConverted) {
    verdict.verdict = "PRODUCT_FAILED";
    verdict.detail = "the attachment did not stand on the identity the launch published";
    return;
  }
  if (verdict.absent.answered || verdict.absent.failureClass !== "identity-unavailable") {
    verdict.verdict = "PRODUCT_FAILED";
    verdict.detail = "an absent conversation was not refused before a turn";
    return;
  }
  verdict.verdict = "PASS";
  verdict.detail =
    "a marker-free ACP prompt recovered the native turn's history under the same identity " +
    "and the same build, and an absent identity refused without a turn";
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
  if (process.env[TURNS_ENV] !== AUTHORIZED_TURNS) {
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

function render(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

main(function* () {
  // Planted only in the first native user turn and held here. It reaches no
  // instruction file, no argument vector, no environment, no session key, no
  // durable record, no document this run executes, and no rendered field.
  const marker = `MK${randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase()}`;
  const verdict = yield* runJourney(
    "native-to-acp",
    (journey, report) => runAttachment(journey, report, marker),
    decideAttachment,
  );
  // The last check, on the thing about to be printed: a verdict carrying the
  // marker would publish the one value this whole proof exists to keep private.
  verdict.markerInReportedEvidence = JSON.stringify(verdict).includes(marker);
  if (verdict.markerInReportedEvidence) {
    verdict.verdict = "HARNESS_FAILED";
    verdict.detail = "the verdict carried the history marker";
  }
  render(verdict);
});
