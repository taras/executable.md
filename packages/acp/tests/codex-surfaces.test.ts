/**
 * Tier CS — Codex surface classification and submission readiness
 * (specs/native-agent-session-launch-spec.md §Provider-returned adapters).
 *
 * Two decisions in the Codex native proof are worth more than the turns they
 * guard. One reads a screen that produced no answer and says whether the
 * environment refused; the other decides whether a composer will take a turn at
 * all, and so whether a model turn is spent. Both were wrong in ways only a paid
 * run could show:
 *
 * - A bare `usage limit` substring matched Codex's own benign banner —
 *   `You have 2 usage limit resets available` — which an account with headroom
 *   to spare shows. Two authorized runs were reported as blocked by a quota that
 *   a `/status` on the same account said was 42% unspent.
 * - Readiness was read off the byte stream, so a composer whose bytes had
 *   arrived counted as ready even while `model: loading` was still painted
 *   behind it, and the confirmation that the turn had been typed swallowed its
 *   own timeout and pressed Enter anyway.
 *
 * These cases drive the exact predicates and the exact driver the fixture
 * consumes, against hand-written frames. No Codex process starts and no model
 * turn is spent.
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import type { Operation } from "effection";
import {
  presentedDuring,
  TerminalReader,
  TerminalScreen,
  waitForPresented,
} from "./fixtures/terminal-screen.ts";
import type { ScreenSnapshot } from "./fixtures/terminal-screen.ts";
import {
  classifyInitialSurface,
  classifyStall,
  COMPOSER,
  composerReady,
  exhaustedUsage,
  MISSING_SESSION,
  MODEL_LOADING,
  PROMPT_TAIL,
  promptPresented,
  reachComposer,
  submitWhenReady,
  TRUST_DIALOG,
} from "./fixtures/codex-surfaces.ts";
import type {
  SubmissionBounds,
  SubmissionPort,
  SurfaceBounds,
  SurfacePort,
} from "./fixtures/codex-surfaces.ts";

/** The pty the proof opens, so these frames wrap where that one wraps. */
const ROWS = 40;
const COLUMNS = 120;

const ESC = String.fromCharCode(0x1b);
const csi = (body: string): string => `${ESC}[${body}`;
const at = (row: number, column: number): string => csi(`${row};${column}H`);
const ALT_ON = csi("?1049h");
const CLEAR = csi("2J");
/** Hold the drawing back, and put the finished frame on show. */
const SYNC_ON = csi("?2026h");
const SYNC_OFF = csi("?2026l");

function paint(rows: readonly string[]): string {
  return rows.map((row, index) => `${at(index + 1, 1)}${csi("2K")}${row}`).join("");
}

/** A bordered pane row, padded to its right border as a TUI pads one. */
function pane(text: string, width = 80): string {
  return `│ ${text.padEnd(width)} │`;
}

/** A whole frame, drawn over whatever was there. */
function frame(rows: readonly string[]): string {
  return `${CLEAR}${paint(rows)}`;
}

/**
 * One read of a pty, carrying several finished frames.
 *
 * Each is committed in its own right, so every one of them is a frame a terminal
 * put on show — and all of them arrive together, because a `data` event is
 * however many bytes happened to be waiting rather than however much of a
 * drawing was finished.
 */
function oneRead(...frames: readonly (readonly string[])[]): string {
  return frames.map((rows) => `${SYNC_ON}${frame(rows)}${SYNC_OFF}`).join("");
}

function showing(rows: readonly string[]): ScreenSnapshot {
  const terminal = new TerminalScreen({ rows: ROWS, columns: COLUMNS });
  terminal.write(`${ALT_ON}${frame(rows)}`);
  return terminal.presented();
}

/** Codex's own banner, offering the resets an account still has in hand. */
const BENIGN_RESETS = "You have 2 usage limit resets available. Run /usage to use one.";
/** What `/status` reports on the same account: headroom, in the same words. */
const BENIGN_STATUS = "Usage limit: 42% left this week (resets Monday)";
/** Help text about the refusal, which is not the refusal. */
const CONDITIONAL_HELP = "If you've hit your usage limit, run /usage to see when it resets.";
/** What an account with nothing left is actually told. */
const GENUINE_REFUSAL = "You've hit your usage limit.";

/**
 * The wording the previous round accepted, none of which anybody has witnessed.
 *
 * Kept as cases rather than deleted quietly: each one was a way for a screen
 * that is not the refusal to reach `ENVIRONMENT_BLOCKED`, and a list that names
 * them fails loudly if one is ever put back.
 */
/**
 * The refusal's own words, inside a sentence that is somebody else's.
 *
 * What separates these from the refusal is where the sentence begins, and
 * nothing else — the wording, the punctuation and the whole of the phrase are
 * all present. They are the cases the run-prefix rule exists for; a containment
 * test over the same run accepts every one of them.
 */
const EMBEDDED: readonly string[] = [
  "Note: You've hit your usage limit.",
  "We don't think you've hit your usage limit.",
  "It looks like you've hit your usage limit.",
];

const UNWITNESSED: readonly string[] = [
  "You've hit your weekly limit.",
  "You've reached your usage limit.",
  "You've reached your weekly limit.",
  "You have hit your usage limit.",
  "You have reached your usage limit.",
  "Usage limit reached",
  // The sentence's own opening, carrying on into a limit that is not the one
  // this proof was refused by. Where it ends is part of what was witnessed.
  "You've hit your usage limit for images.",
];

const READY = [pane("OpenAI Codex (v0.153.2)"), "", pane(COMPOSER), pane("model: gpt-5.6-sol")];
const LOADING = [pane("OpenAI Codex (v0.153.2)"), "", pane(COMPOSER), pane(MODEL_LOADING)];
const TRUSTING = [pane(TRUST_DIALOG), pane("1. Yes, continue"), "", pane(COMPOSER)];

describe("Tier CS — Codex surface classification", () => {
  it("CS1: the resets banner is not exhaustion, composer or no composer", function* () {
    // Bare, as it lands over a session that is about to work perfectly well.
    expect(exhaustedUsage(showing([pane(BENIGN_RESETS)]))).toBe(false);
    expect(classifyStall(showing([pane(BENIGN_RESETS)]))).toEqual({
      tag: "unknown",
      verdict: "HARNESS_FAILED",
    });

    // And where it actually appears: above a composer waiting for a turn. The
    // classification is the composer's resting state, which explains nothing.
    const withComposer = showing([pane(BENIGN_RESETS), "", pane(COMPOSER)]);
    expect(exhaustedUsage(withComposer)).toBe(false);
    expect(classifyStall(withComposer)).toEqual({
      tag: "composer-idle",
      verdict: "HARNESS_FAILED",
    });
  });

  it("CS2: status and headroom text is not exhaustion", function* () {
    const status = showing([pane(BENIGN_STATUS), pane("Weekly limit: 42% left")]);
    expect(exhaustedUsage(status)).toBe(false);
    expect(classifyStall(status).verdict).toBe("HARNESS_FAILED");

    // The words are on the screen. It is the sentence that decides, not them.
    const terminal = new TerminalScreen({ rows: ROWS, columns: COLUMNS });
    terminal.write(`${ALT_ON}${frame([pane(BENIGN_STATUS)])}`);
    expect(terminal.presented().rows.join("")).toContain("Usage limit");
  });

  it("CS3: the exhausted-limit sentence is exhaustion", function* () {
    const refused = showing([pane(GENUINE_REFUSAL), "", pane(COMPOSER)]);
    expect(exhaustedUsage(refused)).toBe(true);
    // Ahead of the idle composer drawn under it, which is the surface a refusal
    // leaves behind and would otherwise be all this reported.
    expect(classifyStall(refused)).toEqual({
      tag: "usage-limited",
      verdict: "ENVIRONMENT_BLOCKED",
    });

    // Case and typographic apostrophes are the terminal's, not the sentence's.
    expect(exhaustedUsage(showing([pane("you’ve hit your usage limit.")]))).toBe(true);
    // Wrapped across two rows by a 40-column pane, which is where a substring
    // search on a single row would lose it.
    expect(exhaustedUsage(showing([pane("You've hit your usage", 20), pane("limit.", 20)]))).toBe(
      true,
    );
  });

  it("CS4: a refusal inside an uncommitted frame is not classified until shown", function* () {
    const terminal = new TerminalScreen({ rows: ROWS, columns: COLUMNS });
    terminal.write(`${ALT_ON}${frame([pane("Working"), pane("esc to interrupt")])}`);
    expect(classifyStall(terminal.presented()).tag).toBe("still-working");

    // The refusal is drawn inside a hold: cells this screen has and no terminal
    // ever put on show. Reading them would blame an environment for a frame
    // nobody was looking at.
    terminal.write(`${SYNC_ON}${frame([pane(GENUINE_REFUSAL), "", pane(COMPOSER)])}`);
    expect(exhaustedUsage(terminal.presented())).toBe(false);
    expect(classifyStall(terminal.presented())).toEqual({
      tag: "still-working",
      verdict: "HARNESS_FAILED",
    });

    // It counts from the commit, and not before.
    terminal.write(SYNC_OFF);
    expect(classifyStall(terminal.presented())).toEqual({
      tag: "usage-limited",
      verdict: "ENVIRONMENT_BLOCKED",
    });
  });

  it("CS5: only the witnessed refusal may blame the environment", function* () {
    // Reading a screen is the only way to get here. There is no exported
    // tag-to-verdict step, so no caller can hand this proof a `usage-limited`
    // it decided on for itself — the refusal has to be on a screen.
    expect(classifyStall(showing([pane(GENUINE_REFUSAL)])).verdict).toBe("ENVIRONMENT_BLOCKED");

    // Everything else describes where the terminal got to, and a proof that read
    // any of them as an explanation would name a cause the screen never gave.
    for (const rows of [
      [pane(BENIGN_RESETS), "", pane(COMPOSER)],
      [pane(BENIGN_STATUS)],
      [pane(CONDITIONAL_HELP), "", pane(COMPOSER)],
      [pane("Working"), pane("esc to interrupt")],
      [pane("Allow command"), pane("codex wants to run something")],
      [pane(COMPOSER)],
      [pane("something no version of this proof has ever seen")],
    ]) {
      expect(exhaustedUsage(showing(rows))).toBe(false);
      expect(classifyStall(showing(rows)).verdict).toBe("HARNESS_FAILED");
    }

    // The refusal is the sentence, not the words in it. A run that begins
    // somewhere else began somewhere else.
    for (const sentence of EMBEDDED) {
      expect(exhaustedUsage(showing([pane(sentence)]))).toBe(false);
      expect(classifyStall(showing([pane(sentence)])).verdict).toBe("HARNESS_FAILED");
    }

    // Wording nobody has seen stays wording nobody has seen. An unrecognized
    // screen costs an investigation; a wrongly recognized one costs the truth.
    for (const wording of UNWITNESSED) {
      expect(exhaustedUsage(showing([pane(wording)]))).toBe(false);
      expect(classifyStall(showing([pane(wording)])).verdict).toBe("HARNESS_FAILED");
    }
  });
});

/**
 * A port over scripted *reads*, built out of the pieces the pty is built out of.
 *
 * The same {@link TerminalReader} and the same {@link waitForPresented} the live
 * path uses, for the same reason {@link surfaceFake} uses them: one entry of the
 * script is one read, and a read can finish several frames. Submission needs
 * that as much as reaching a composer does — Codex draws its refusal above a
 * composer, so the refusal and the ready composer it must not be typed into can
 * arrive in one read, with only the last of them left on screen.
 */
function fakePort(script: readonly string[]): {
  port: SubmissionPort;
  log: { typed: string[]; sent: string[]; waited: string[]; paused: number[]; charged: number };
} {
  const reader = new TerminalReader({ rows: ROWS, columns: COLUMNS }, false);
  reader.write(ALT_ON);
  const log = { typed: [], sent: [], waited: [], paused: [], charged: 0 } as {
    typed: string[];
    sent: string[];
    waited: string[];
    paused: number[];
    charged: number;
  };
  let next = 0;
  const advance = (): boolean => {
    const chunk = script[next];
    if (chunk === undefined) {
      return false;
    }
    next += 1;
    reader.write(chunk);
    return true;
  };
  return {
    log,
    port: {
      screen: () => reader.snapshot(),
      waitForScreen(name, _ms, predicate) {
        log.waited.push(name);
        return waitForPresented(reader, predicate, function* (wait): Operation<void> {
          // A script that runs out is a bound that ran out: no further byte is
          // ever going to arrive, which is what a spent bound means.
          while (!wait.settled() && advance()) {
            // Reads, until one of them answers or there are none left.
          }
        });
      },
      type(text) {
        log.typed.push(text);
      },
      send(typed) {
        // Ordered as the pty orders it: the turn is charged at the keystroke,
        // ahead of the byte, so a run that reaches here has spent one either way.
        log.charged += 1;
        log.sent.push(typed);
      },
      pause(ms, predicate) {
        log.paused.push(ms);
        // Time passing is frames arriving, which is how an overlay or a model
        // that is still loading gets its chance to show up — and how a refusal
        // gets its chance to be drawn and painted back over with nobody waiting.
        return presentedDuring(
          reader,
          predicate,
          (function* (): Operation<void> {
            advance();
          })(),
        );
      },
    },
  };
}

const BOUNDS: SubmissionBounds = { ready: 1_000, startupGrace: 10, presented: 1_000 };

/** Minted for one run, and so the only text on the screen unique to that run. */
const MARKER = "MK4A17BE0C9D31";

/** Shaped like the proof's turn: long, and ending in a marker minted per run. */
const TURN =
  "Do not use any tools. Reply with exactly two lines. First line: the first " +
  "sentence of the body text under the 'Implementor' heading of your contract, " +
  "copied verbatim. Second line: remember this marker for later, MK4A17BE0C9D31";

/** The composer with the turn in it — placeholder gone, as a real one is. */
const TYPED_IN = [pane("OpenAI Codex (v0.153.2)"), "", pane(TURN.slice(-40)), pane("Send with ⏎")];

/**
 * The refusal where Codex draws it: above a composer, rather than instead of one.
 *
 * The shape that makes this path dangerous, and the same one CS15 pins for the
 * surface classifier. A screen can carry the refusal and a composer at once, so
 * every predicate about the composer is satisfied by a screen that has already
 * said the session does not exist.
 */
const REFUSED_READY = [
  pane("OpenAI Codex (v0.153.2)"),
  pane(`${MISSING_SESSION} 019a-…`),
  "",
  pane(COMPOSER),
];

/**
 * The refusal once the composer has gone with it.
 *
 * The other half of why a batch is not the whole answer. This screen fails
 * {@link composerReady}, so a wait collecting on readiness can never be holding
 * it — it can only be the screen a read ended on, which nothing but a read of
 * the screen itself will find.
 */
const REFUSED_ALONE = [pane("OpenAI Codex (v0.153.2)"), pane(`${MISSING_SESSION} 019a-…`)];

/** The same refusal, over a composer holding the turn this run typed. */
const REFUSED_TYPED = [
  pane("OpenAI Codex (v0.153.2)"),
  pane(`${MISSING_SESSION} 019a-…`),
  "",
  pane(TURN.slice(-40)),
  pane("Send with ⏎"),
];

describe("Tier CS — submission readiness", () => {
  it("CS6: a model still loading takes no input at all", function* () {
    expect(composerReady(showing(LOADING))).toBe(false);
    // The composer is drawn and its bytes have arrived, which is exactly what
    // the stream-reading version accepted.
    expect(showing(LOADING).rows.join("")).toContain("Ask Codex to do anything");

    const { port, log } = fakePort([frame(LOADING), frame(LOADING)]);
    const outcome = yield* submitWhenReady(port, TURN, BOUNDS);

    expect(outcome).toEqual({ submitted: false, reason: "composer-never-ready" });
    // Nothing was typed, so nothing was queued into a composer that could take
    // it later, and Enter was never reached.
    expect(log.typed).toEqual([]);
    expect(log.sent).toEqual([]);
  });

  it("CS7: a later ready frame permits exactly one submission", function* () {
    const { port, log } = fakePort([
      frame(LOADING),
      frame(READY),
      frame(READY),
      frame(TYPED_IN),
      frame(TYPED_IN),
    ]);
    const outcome = yield* submitWhenReady(port, TURN, BOUNDS);

    expect(outcome).toEqual({ submitted: true });
    expect(log.typed).toEqual([TURN]);
    expect(log.sent).toEqual([TURN]);
    // The grace was taken, and the readiness read on both sides of it.
    expect(log.paused).toEqual([BOUNDS.startupGrace]);
    expect(log.waited).toEqual(["composer-ready", "prompt-presented"]);
  });

  it("CS8: a turn that never appears is never sent", function* () {
    const { port, log } = fakePort([frame(READY), frame(READY), frame(READY)]);
    const outcome = yield* submitWhenReady(port, TURN, BOUNDS);

    expect(outcome).toEqual({ submitted: false, reason: "prompt-never-presented" });
    // Typed, and that is all: the keystroke that spends the turn is the one
    // thing this path may not reach.
    expect(log.typed).toEqual([TURN]);
    expect(log.sent).toEqual([]);
  });

  it("CS9: a composer under a dialog is not ready, and is waited for again", function* () {
    expect(composerReady(showing(TRUSTING))).toBe(false);

    // Ready, then a dialog over it during the grace — which is the window the
    // recheck exists for — then ready again.
    const { port, log } = fakePort([frame(READY), frame(TRUSTING), frame(READY), frame(TYPED_IN)]);
    expect(yield* submitWhenReady(port, TURN, BOUNDS)).toEqual({ submitted: true });
    expect(log.waited).toEqual(["composer-ready", "composer-ready-again", "prompt-presented"]);
    expect(log.sent).toEqual([TURN]);

    // And when it does not come back, nothing is typed and nothing is sent.
    const stuck = fakePort([frame(READY), frame(TRUSTING), frame(TRUSTING)]);
    expect(yield* submitWhenReady(stuck.port, TURN, BOUNDS)).toEqual({
      submitted: false,
      reason: "composer-unready-after-grace",
    });
    expect(stuck.log.typed).toEqual([]);
    expect(stuck.log.sent).toEqual([]);
  });

  it("CS10: readiness is read off the presented screen, not the held one", function* () {
    // The whole ready frame is drawn inside a hold. Its bytes have arrived; no
    // terminal has shown them.
    const { port, log } = fakePort([
      `${SYNC_ON}${frame(READY)}`,
      SYNC_OFF,
      frame(READY),
      frame(TYPED_IN),
    ]);
    expect(composerReady(port.screen())).toBe(false);

    expect(yield* submitWhenReady(port, TURN, BOUNDS)).toEqual({ submitted: true });
    expect(log.sent).toEqual([TURN]);

    // The same is true of the turn's own appearance: a composer showing it only
    // in cells that were never committed has not presented it.
    const held = new TerminalScreen({ rows: ROWS, columns: COLUMNS });
    held.write(`${ALT_ON}${frame(READY)}${SYNC_ON}${frame(TYPED_IN)}`);
    expect(promptPresented(held.presented(), TURN)).toBe(false);
    held.write(SYNC_OFF);
    expect(promptPresented(held.presented(), TURN)).toBe(true);
  });

  it("CS11: every refusal on this path charges no turn at all", function* () {
    // The two ways a submission can be refused, and the accounting each owes.
    // `sent` is the byte; `charged` is what the run reports having spent, and
    // the pty counts it before writing the byte so neither can outrun the other.
    const unready = fakePort([frame(LOADING), frame(LOADING)]);
    expect(yield* submitWhenReady(unready.port, TURN, BOUNDS)).toEqual({
      submitted: false,
      reason: "composer-never-ready",
    });
    expect(unready.log.charged).toBe(0);

    const unpresented = fakePort([frame(READY), frame(READY), frame(READY)]);
    expect(yield* submitWhenReady(unpresented.port, TURN, BOUNDS)).toEqual({
      submitted: false,
      reason: "prompt-never-presented",
    });
    expect(unpresented.log.charged).toBe(0);

    // And the one path that does spend a turn spends exactly one.
    const sending = fakePort([frame(READY), frame(READY), frame(TYPED_IN)]);
    expect(yield* submitWhenReady(sending.port, TURN, BOUNDS)).toEqual({ submitted: true });
    expect(sending.log.charged).toBe(1);
  });

  it("CS12: the marker is absent before typing and presented before Enter", function* () {
    // The tail is what `promptPresented` looks for, so the marker has to fit
    // inside it or the thing being recognized is shared with every other run.
    expect(TURN.slice(-PROMPT_TAIL)).toContain(MARKER);

    // Before typing, the composer is empty and there is nowhere else on screen
    // for the marker to be: nothing has been sent, so no transcript carries it.
    const ready = showing(READY);
    expect(composerReady(ready)).toBe(true);
    expect(ready.rows.join("")).not.toContain(MARKER);
    expect(promptPresented(ready, TURN)).toBe(false);

    // Between typing and Enter it is on the screen, in the composer, which is
    // what makes the turn about to be charged the turn this run prepared.
    const composed = showing(TYPED_IN);
    expect(composed.rows.join("")).toContain(MARKER);
    expect(promptPresented(composed, TURN)).toBe(true);

    // A composer holding some other run's turn is not this run's turn presented.
    const stale = showing([pane("OpenAI Codex (v0.153.2)"), "", pane("MK0000000000000")]);
    expect(promptPresented(stale, TURN)).toBe(false);
  });

  it("CS22: a refusal reached while readying the turn charges nothing", function* () {
    // Reaching a composer establishes the session was not refused, but only for
    // as long as its grace was willing to wait — and Codex draws the composer
    // before it resolves the thread. A refusal slower than that grace lands
    // here, where the turn is already being readied and Enter is next.
    //
    // What makes it dangerous is that it is invisible to every predicate on this
    // path. Codex draws `No saved session found with ID` *above* a composer
    // rather than in place of one, so a refused screen is one the readiness test
    // calls ready and the presentation test calls presented.
    expect(composerReady(showing(REFUSED_READY))).toBe(true);
    expect(promptPresented(showing(REFUSED_TYPED), TURN)).toBe(true);
    // Only the surface classifier orders the refusal above them, which is why
    // it, and not readiness, is what the gates below ask.
    expect(classifyInitialSurface(showing(REFUSED_READY))).toBe("missing-session");
    expect(classifyInitialSurface(showing(REFUSED_TYPED))).toBe("missing-session");

    // Gate one: the refusal is in the batch that satisfied the readiness wait,
    // and the read ends on an ordinary composer, so the screen afterwards shows
    // nothing wrong.
    const atReady = fakePort([oneRead(REFUSED_READY, READY)]);
    expect(yield* submitWhenReady(atReady.port, TURN, BOUNDS)).toEqual({
      submitted: false,
      reason: "session-refused",
    });
    expect(atReady.log.charged).toBe(0);
    expect(atReady.log.sent).toEqual([]);
    // Nothing was even typed: the refusal was read before there was any reason to.
    expect(atReady.log.typed).toEqual([]);

    // Gate two: the composer came undone over the grace, and the refusal rides
    // in the batch that answers the second readiness wait.
    const atReadyAgain = fakePort([frame(READY), frame(LOADING), oneRead(REFUSED_READY, READY)]);
    expect(yield* submitWhenReady(atReadyAgain.port, TURN, BOUNDS)).toEqual({
      submitted: false,
      reason: "session-refused",
    });
    expect(atReadyAgain.log.charged).toBe(0);
    expect(atReadyAgain.log.waited).toEqual(["composer-ready", "composer-ready-again"]);

    // Gate three: the turn is typed, and the read that confirms it on screen is
    // the read carrying the refusal. Typing spends nothing, so this still costs
    // no turn — but it is one Enter away from costing one.
    const atPresented = fakePort([frame(READY), frame(READY), oneRead(REFUSED_TYPED, TYPED_IN)]);
    expect(yield* submitWhenReady(atPresented.port, TURN, BOUNDS)).toEqual({
      submitted: false,
      reason: "session-refused",
    });
    expect(atPresented.log.charged).toBe(0);
    expect(atPresented.log.sent).toEqual([]);
    expect(atPresented.log.typed).toEqual([TURN]);

    // Gate four: the refusal is in no batch at all. It arrives in the same read
    // as the confirmed turn but *after* it, so it satisfies no predicate on this
    // path and is collected by nothing — it is only there to be seen by reading
    // the screen as it stands, which is what the last thing before Enter does.
    const atEnter = fakePort([frame(READY), frame(READY), oneRead(TYPED_IN, REFUSED_READY)]);
    expect(yield* submitWhenReady(atEnter.port, TURN, BOUNDS)).toEqual({
      submitted: false,
      reason: "session-refused",
    });
    expect(atEnter.log.charged).toBe(0);
    expect(atEnter.log.sent).toEqual([]);

    // And the priority is the refusal's alone. The same shape with nothing
    // refused still submits, so what was added is a finding and not a new way
    // for an ordinary run to lose its turn.
    const clean = fakePort([frame(READY), frame(READY), frame(TYPED_IN)]);
    expect(yield* submitWhenReady(clean.port, TURN, BOUNDS)).toEqual({ submitted: true });
    expect(clean.log.charged).toBe(1);
    expect(clean.log.sent).toEqual([TURN]);
  });

  it("CS23: a refusal left on the screen stops the turn at either decision taken against it", function* () {
    // Every check CS22 added reads a batch, and a batch is the frames that
    // answered a wait rather than the screen the read ended on. Two decisions
    // here are taken against the screen instead — whether the composer needs a
    // second wait, and whether it survived one — and both are followed by
    // typing. Neither had anything collecting a refusal for it.

    // After the startup grace. The refusal drawn during the pause leaves
    // `composerReady` true, which is the shape this whole tier turns on, so the
    // second wait is not taken, no batch exists to be checked, and the read that
    // confirms the turn repaints a clean composer over the refusal.
    const duringGrace = fakePort([frame(READY), frame(REFUSED_READY), frame(TYPED_IN)]);
    expect(yield* submitWhenReady(duringGrace.port, TURN, BOUNDS)).toEqual({
      submitted: false,
      reason: "session-refused",
    });
    expect(duringGrace.log.charged).toBe(0);
    expect(duringGrace.log.sent).toEqual([]);
    // Nothing was typed either: this stops before the composer is touched, not
    // at the last moment before Enter.
    expect(duringGrace.log.typed).toEqual([]);
    expect(duringGrace.log.waited).toEqual(["composer-ready"]);

    // After a `composer-ready-again` batch. Here the refusal is what the read
    // ended on and it carries no composer — which is what sent this run to a
    // second wait to begin with, and is exactly what keeps it out of a batch
    // collected on readiness. An earlier frame in the same read satisfied the
    // wait, so the batch is honestly ready and honestly not refused.
    const afterAgain = fakePort([
      frame(READY),
      frame(LOADING),
      oneRead(READY, REFUSED_ALONE),
      frame(TYPED_IN),
    ]);
    expect(yield* submitWhenReady(afterAgain.port, TURN, BOUNDS)).toEqual({
      submitted: false,
      reason: "session-refused",
    });
    expect(afterAgain.log.charged).toBe(0);
    expect(afterAgain.log.typed).toEqual([]);
    expect(afterAgain.log.waited).toEqual(["composer-ready", "composer-ready-again"]);

    // The two refusals are opposite shapes, and that is the point: one is caught
    // because it passes for ready, the other because it cannot be collected by a
    // wait that asks for ready. A batch check answers for neither.
    expect(composerReady(showing(REFUSED_READY))).toBe(true);
    expect(composerReady(showing(REFUSED_ALONE))).toBe(false);

    // A composer that simply came back after the grace still types and still
    // submits, so the second wait keeps its ordinary ending.
    const recovered = fakePort([
      frame(READY),
      frame(LOADING),
      oneRead(LOADING, READY),
      frame(TYPED_IN),
    ]);
    expect(yield* submitWhenReady(recovered.port, TURN, BOUNDS)).toEqual({ submitted: true });
    expect(recovered.log.charged).toBe(1);
    expect(recovered.log.sent).toEqual([TURN]);
    expect(recovered.log.waited).toEqual([
      "composer-ready",
      "composer-ready-again",
      "prompt-presented",
    ]);
  });

  it("CS24: a refusal a wait was not watching for still ends that wait", function* () {
    // The third place a refusal can hide, and the one neither a batch nor the
    // screen afterwards reaches. A wait ends at the read that satisfied it, so a
    // frame its predicate says nothing about does not merely go uncollected — it
    // does not stop the wait at all, and the next read repaints over it. This
    // refusal carries no composer, so `composerReady` and `promptPresented` are
    // both false on it, and both of these waits ran straight past it.
    expect(composerReady(showing(REFUSED_ALONE))).toBe(false);
    expect(promptPresented(showing(REFUSED_ALONE), TURN)).toBe(false);
    expect(classifyInitialSurface(showing(REFUSED_ALONE))).toBe("missing-session");

    // Waiting for the composer to come back. The refusal is presented, then a
    // composer is drawn over it in a read of its own, and the batch that answers
    // is honestly ready while the screen afterwards is honestly clean.
    const whileWaitingReady = fakePort([
      frame(READY),
      frame(LOADING),
      frame(REFUSED_ALONE),
      frame(READY),
      frame(TYPED_IN),
    ]);
    expect(yield* submitWhenReady(whileWaitingReady.port, TURN, BOUNDS)).toEqual({
      submitted: false,
      reason: "session-refused",
    });
    // Nothing typed: this wait is upstream of the composer being touched, so the
    // refusal that ends it ends the run before there is a turn in the box.
    expect(whileWaitingReady.log.typed).toEqual([]);
    expect(whileWaitingReady.log.sent).toEqual([]);
    expect(whileWaitingReady.log.charged).toBe(0);

    // Waiting for the typed turn to appear. Here the turn is already in the
    // composer, so what is left to protect is Enter — and the refusal is again
    // presented in a read the wait had no reason to stop at.
    const whileWaitingPresented = fakePort([
      frame(READY),
      frame(READY),
      frame(REFUSED_ALONE),
      frame(TYPED_IN),
    ]);
    expect(yield* submitWhenReady(whileWaitingPresented.port, TURN, BOUNDS)).toEqual({
      submitted: false,
      reason: "session-refused",
    });
    // The typing stands — it happened before anything was refused, and typing
    // into a composer costs nothing. Enter is what must not follow it.
    expect(whileWaitingPresented.log.typed).toEqual([TURN]);
    expect(whileWaitingPresented.log.sent).toEqual([]);
    expect(whileWaitingPresented.log.charged).toBe(0);

    // Neither wait is now a wait for anything that happens to end it: a run
    // where nothing is refused still waits out its full script and submits.
    const patient = fakePort([
      frame(READY),
      frame(LOADING),
      frame(LOADING),
      frame(READY),
      frame(TYPED_IN),
    ]);
    expect(yield* submitWhenReady(patient.port, TURN, BOUNDS)).toEqual({ submitted: true });
    expect(patient.log.charged).toBe(1);
    expect(patient.log.sent).toEqual([TURN]);
  });

  it("CS26: a refusal presented during the startup grace is seen, and charges nothing", function* () {
    // The grace exists because Codex draws its composer before it has finished
    // deciding anything, so it is the window a late refusal is most likely to
    // land in — and it was the one window nothing was watching. Presented and
    // painted over inside a single read, the refusal leaves a ready composer
    // behind it, which is what every question asked after the grace sees.
    const refusedDuringGrace = fakePort([
      frame(READY),
      oneRead(REFUSED_READY, READY),
      frame(TYPED_IN),
    ]);
    expect(yield* submitWhenReady(refusedDuringGrace.port, TURN, BOUNDS)).toEqual({
      submitted: false,
      reason: "session-refused",
    });
    expect(refusedDuringGrace.log.typed).toEqual([]);
    expect(refusedDuringGrace.log.sent).toEqual([]);
    expect(refusedDuringGrace.log.charged).toBe(0);
    // Decided against something the screen no longer shows: afterwards it is an
    // ordinary ready composer, and asking it would have typed a turn.
    expect(composerReady(refusedDuringGrace.port.screen())).toBe(true);

    // The refusal need not be repainted to count, and a grace that ends on one
    // is still the same finding rather than a composer that came undone.
    const refusedAndLeft = fakePort([frame(READY), frame(REFUSED_ALONE), frame(TYPED_IN)]);
    expect(yield* submitWhenReady(refusedAndLeft.port, TURN, BOUNDS)).toEqual({
      submitted: false,
      reason: "session-refused",
    });
    expect(refusedAndLeft.log.charged).toBe(0);

    // An ordinary repaint during the grace still submits, so what the grace now
    // watches for is the refusal and not change in general.
    const repaintedDuringGrace = fakePort([frame(READY), oneRead(LOADING, READY), frame(TYPED_IN)]);
    expect(yield* submitWhenReady(repaintedDuringGrace.port, TURN, BOUNDS)).toEqual({
      submitted: true,
    });
    expect(repaintedDuringGrace.log.charged).toBe(1);
    expect(repaintedDuringGrace.log.sent).toEqual([TURN]);

    // A refusal drawn during the grace and held back was never on show, so the
    // grace has nothing to report and the turn is typed. The run then ends
    // waiting for a composer this hold never lets it see — not as a refusal,
    // which is what a hold counting would have made it — and sends nothing.
    const heldDuringGrace = fakePort([
      frame(READY),
      `${SYNC_ON}${frame(REFUSED_ALONE)}`,
      frame(TYPED_IN),
    ]);
    expect(yield* submitWhenReady(heldDuringGrace.port, TURN, BOUNDS)).toEqual({
      submitted: false,
      reason: "prompt-never-presented",
    });
    expect(heldDuringGrace.log.typed).toEqual([TURN]);
    expect(heldDuringGrace.log.charged).toBe(0);
  });
});

/**
 * A port over scripted *reads*, built out of the pieces the pty is built out of.
 *
 * Deliberately not a screen with a predicate checked beside it. The live path is
 * a {@link TerminalReader} fed one read at a time, with waits woken from inside
 * it by {@link waitForPresented}; this is the same reader and the same wait, and
 * differs only in what makes a read arrive. That is what lets one entry of the
 * script carry several finished frames — as a pty's `data` event routinely does
 * — and have this driver see each of them, rather than only the one the read
 * ended on.
 */
function surfaceFake(script: readonly string[]): {
  port: SurfacePort;
  log: { consents: number; waited: string[]; paused: number[] };
} {
  const reader = new TerminalReader({ rows: ROWS, columns: COLUMNS }, false);
  reader.write(ALT_ON);
  const log = { consents: 0, waited: [], paused: [] } as {
    consents: number;
    waited: string[];
    paused: number[];
  };
  let next = 0;
  const advance = (): boolean => {
    const chunk = script[next];
    if (chunk === undefined) {
      return false;
    }
    next += 1;
    reader.write(chunk);
    return true;
  };
  return {
    log,
    port: {
      screen: () => reader.snapshot(),
      waitForScreen(name, _ms, predicate) {
        log.waited.push(name);
        return waitForPresented(reader, predicate, function* (wait): Operation<void> {
          // Nothing happens between reads here, as nothing happens between a
          // pty's. A script that runs out is a bound that ran out: no further
          // byte is ever going to arrive, which is what a spent bound means.
          while (!wait.settled() && advance()) {
            // Reads, until one of them answers or there are none left.
          }
        });
      },
      consent() {
        log.consents += 1;
      },
      pause(ms, predicate) {
        log.paused.push(ms);
        return presentedDuring(
          reader,
          predicate,
          (function* (): Operation<void> {
            advance();
          })(),
        );
      },
    },
  };
}

const SURFACE: SurfaceBounds = { surface: 1_000, settle: 10, grace: 10 };

const MISSING = [pane("OpenAI Codex (v0.153.2)"), "", pane(`${MISSING_SESSION} 019a-…`)];
const STARTING = [pane("OpenAI Codex (v0.153.2)"), pane(MODEL_LOADING)];

describe("Tier CS — reaching a composer", () => {
  it("CS13: the trust dialog is answered once, and only while it is up", function* () {
    const { port, log } = surfaceFake([frame(TRUSTING), frame(TRUSTING), frame(READY)]);
    expect(yield* reachComposer(port, SURFACE)).toBe("composer-ready");
    expect(log.consents).toBe(1);
    // The settle came before the Enter, and the answered dialog was waited out
    // rather than read again as a second question.
    expect(log.paused).toEqual([SURFACE.settle]);
    expect(log.waited).toEqual(["surface", "trust-answered", "surface", "readiness-grace"]);

    // A dialog that goes away during the settle is not answered at all: the
    // Enter would land in whatever replaced it.
    const vanishing = surfaceFake([frame(TRUSTING), frame(READY), frame(READY)]);
    expect(yield* reachComposer(vanishing.port, SURFACE)).toBe("composer-ready");
    expect(vanishing.log.consents).toBe(0);
  });

  it("CS14: a directory Codex already trusts is consented to zero times", function* () {
    const { port, log } = surfaceFake([frame(READY), frame(READY)]);
    expect(yield* reachComposer(port, SURFACE)).toBe("composer-ready");
    expect(log.consents).toBe(0);
    // The grace was still spent watching for the readiness to come undone.
    expect(log.waited).toEqual(["surface", "readiness-grace"]);

    // And when one does arrive over the composer during that grace, it is
    // answered — which is the ordering Codex actually draws.
    const late = surfaceFake([frame(READY), frame(TRUSTING), frame(TRUSTING), frame(READY)]);
    expect(yield* reachComposer(late.port, SURFACE)).toBe("composer-ready");
    expect(late.log.consents).toBe(1);
  });

  it("CS15: a refused identity is a finding, not something to press Enter at", function* () {
    const { port, log } = surfaceFake([frame(MISSING)]);
    expect(yield* reachComposer(port, SURFACE)).toBe("missing-session");
    expect(log.consents).toBe(0);

    // Codex draws its composer while still opening the thread, so the refusal
    // and a ready-looking composer share a screen. The refusal is what it is.
    expect(classifyInitialSurface(showing([...MISSING, "", pane(COMPOSER)]))).toBe(
      "missing-session",
    );
  });

  it("CS16: a held frame decides nothing until the terminal commits it", function* () {
    for (const [held, committed] of [
      [TRUSTING, "trust-dialog"],
      [MISSING, "missing-session"],
      [READY, "composer-ready"],
      // A loading model is not a surface either way. What it must never do is
      // become readiness, and cells nobody has been shown are the one place
      // that could happen without anybody seeing it.
      [LOADING, "starting"],
    ] as const) {
      const terminal = new TerminalScreen({ rows: ROWS, columns: COLUMNS });
      terminal.write(`${ALT_ON}${frame(STARTING)}`);
      terminal.write(`${SYNC_ON}${frame(held)}`);
      // The bytes are in. Nothing is on show but the frame from before them.
      expect(classifyInitialSurface(terminal.presented())).toBe("starting");
      expect(composerReady(terminal.presented())).toBe(false);
      terminal.write(SYNC_OFF);
      expect(classifyInitialSurface(terminal.presented())).toBe(committed);
    }

    // Driven end to end: a dialog that is only ever held is a dialog this never
    // answers, and the same dialog committed is answered exactly once.
    const uncommitted = surfaceFake([`${SYNC_ON}${frame(TRUSTING)}`]);
    expect(yield* reachComposer(uncommitted.port, SURFACE)).toBe("unresolved");
    expect(uncommitted.log.consents).toBe(0);

    const shown = surfaceFake([
      `${SYNC_ON}${frame(TRUSTING)}`,
      SYNC_OFF,
      frame(TRUSTING),
      frame(READY),
    ]);
    expect(yield* reachComposer(shown.port, SURFACE)).toBe("composer-ready");
    expect(shown.log.consents).toBe(1);
  });

  it("CS17: readiness that comes undone during the grace is not readiness", function* () {
    // Codex draws its composer before it reports that it holds no such thread,
    // so the refusal can land on a screen this driver has already read as ready.
    // A grace watching only for the trust dialog runs out in front of it and
    // returns the composer — sending a turn at a session that does not exist.
    const refused = surfaceFake([frame(READY), frame(MISSING)]);
    expect(yield* reachComposer(refused.port, SURFACE)).toBe("missing-session");
    expect(refused.log.consents).toBe(0);

    // The grace ends at the first screen that is no longer ready, so a refusal
    // it sees is the answer even where a composer is drawn over it afterwards.
    // A grace that ran on past it would report the composer and lose the
    // finding this whole feature exists to establish.
    const repainted = surfaceFake([frame(READY), frame(MISSING), frame(READY)]);
    expect(yield* reachComposer(repainted.port, SURFACE)).toBe("missing-session");

    // The same for a model that goes back to loading: input typed there may be
    // queued rather than taken, so this is not a composer to submit into.
    const relapsed = surfaceFake([frame(READY), frame(LOADING)]);
    expect(yield* reachComposer(relapsed.port, SURFACE)).toBe("unresolved");
    expect(relapsed.log.consents).toBe(0);

    // Unless the model finishes loading, at which point it is ready again and
    // this says so. The grace refuses a screen, not a session.
    const recovered = surfaceFake([frame(READY), frame(LOADING), frame(READY)]);
    expect(yield* reachComposer(recovered.port, SURFACE)).toBe("composer-ready");
    expect(recovered.log.consents).toBe(0);

    // And a composer that simply stays ready is still reached, which is what
    // every accepted run of this proof has done.
    const stable = surfaceFake([frame(READY), frame(READY), frame(READY)]);
    expect(yield* reachComposer(stable.port, SURFACE)).toBe("composer-ready");
    expect(stable.log.consents).toBe(0);
  });

  it("CS18: a transition held back during the grace decides at its commit", function* () {
    // The refusal is drawn inside a hold that never commits. Its bytes arrived
    // during the grace; no terminal showed them, so the screen is still the
    // ready one and that is what this returns.
    const held = surfaceFake([frame(READY), `${SYNC_ON}${frame(MISSING)}`]);
    expect(yield* reachComposer(held.port, SURFACE)).toBe("composer-ready");

    // Commit the same frame and the grace has something to see.
    const committed = surfaceFake([frame(READY), `${SYNC_ON}${frame(MISSING)}`, SYNC_OFF]);
    expect(yield* reachComposer(committed.port, SURFACE)).toBe("missing-session");
    expect(committed.log.consents).toBe(0);

    // A loading model held back and then committed reads the same way round.
    const loading = surfaceFake([frame(READY), `${SYNC_ON}${frame(LOADING)}`, SYNC_OFF]);
    expect(yield* reachComposer(loading.port, SURFACE)).toBe("unresolved");
    expect(loading.log.consents).toBe(0);
  });

  it("CS19: a surface presented and repainted inside one read is still presented", function* () {
    // Codex commits its refusal and draws the composer over it within
    // milliseconds of each other, and a pty hands over however many bytes were
    // waiting — so both frames routinely arrive in one read, with nothing in
    // between for a waiter outside the reader to be woken by. Everything above
    // scripts a read per frame, which is the one arrangement that cannot show
    // this.
    const refusedThenDrawn = surfaceFake([oneRead(MISSING, READY)]);
    expect(yield* reachComposer(refusedThenDrawn.port, SURFACE)).toBe("missing-session");
    expect(refusedThenDrawn.log.consents).toBe(0);
    // And the screen the read ended on is a ready composer — which is what a
    // driver reading only the current screen would have found, and typed into.
    expect(classifyInitialSurface(refusedThenDrawn.port.screen())).toBe("composer-ready");

    // The same read arriving during the grace, which is the other place a
    // refusal lands: after this driver has already read a composer as ready.
    const refusedDuringGrace = surfaceFake([frame(READY), oneRead(MISSING, READY)]);
    expect(yield* reachComposer(refusedDuringGrace.port, SURFACE)).toBe("missing-session");
    expect(classifyInitialSurface(refusedDuringGrace.port.screen())).toBe("composer-ready");

    // A model that goes back to loading and finishes inside one read is the
    // mirror of that, and settles the other way. The loading frame ends the
    // grace, and then readiness is read off the screen as it stands — because
    // the composer about to be typed into is this one, not the frame that woke
    // the wait.
    const relapsedThenLoaded = surfaceFake([frame(READY), oneRead(LOADING, READY)]);
    expect(yield* reachComposer(relapsedThenLoaded.port, SURFACE)).toBe("composer-ready");
    expect(relapsedThenLoaded.log.consents).toBe(0);

    // And a trust dialog that comes and goes inside one read is never answered.
    // It was presented, so the grace ends at it; but Enter is an act against
    // whatever is on screen when it is pressed, and by then the dialog is gone.
    const askedThenGone = surfaceFake([frame(READY), oneRead(TRUSTING, READY)]);
    expect(yield* reachComposer(askedThenGone.port, SURFACE)).toBe("composer-ready");
    expect(askedThenGone.log.consents).toBe(0);

    // A dialog that is still up when the read ends is answered exactly once,
    // so the case above turns on the dialog having gone and not on the shape.
    const stillAsking = surfaceFake([
      frame(READY),
      oneRead(READY, TRUSTING),
      frame(TRUSTING),
      frame(READY),
    ]);
    expect(yield* reachComposer(stillAsking.port, SURFACE)).toBe("composer-ready");
    expect(stillAsking.log.consents).toBe(1);

    // The same dialog inside the *first* read, before any composer has been read
    // as ready. The dialog is what the wait matched, and the driver never goes to
    // answer it at all: it waits out no settle, because a settle is time given to
    // a dialog that is still finishing drawing, and this one is already gone.
    const goneBeforeLookedAt = surfaceFake([oneRead(TRUSTING, READY)]);
    expect(yield* reachComposer(goneBeforeLookedAt.port, SURFACE)).toBe("composer-ready");
    expect(goneBeforeLookedAt.log.consents).toBe(0);
    expect(goneBeforeLookedAt.log.paused).toEqual([]);
    expect(goneBeforeLookedAt.log.waited).toEqual(["surface", "readiness-grace"]);

    // A read carrying three frames, with the refusal in the middle of it. Neither
    // end of the read shows it: the model was still loading when the read began
    // and a composer was up by the time it ended, so this is only found by
    // examining every commit rather than the first or the last.
    const refusedMidRead = surfaceFake([oneRead(LOADING, MISSING, READY)]);
    expect(yield* reachComposer(refusedMidRead.port, SURFACE)).toBe("missing-session");
    expect(refusedMidRead.log.consents).toBe(0);
    expect(classifyInitialSurface(refusedMidRead.port.screen())).toBe("composer-ready");
  });

  it("CS20: a refusal behind an earlier match in the same read is still the finding", function* () {
    // The case above finds the refusal because nothing ahead of it in the read
    // satisfied the wait. That is not the general shape. Both waits here ask a
    // question a benign frame can also answer — the grace watches for the
    // composer becoming *anything* else, and the initial wait for any surface
    // worth acting on — so a read can satisfy one at its first frame and carry
    // the refusal behind it. A wait that stopped looking at the frame that woke
    // it would report the benign one and never see the refusal at all.

    // Codex reloading a model, refusing the identity, and drawing its composer
    // back: three commits, one read, arriving after this driver has already read
    // a composer as ready. The grace matches at `loading`, and the refusal is
    // two frames further in.
    const refusedBehindLoading = surfaceFake([frame(READY), oneRead(LOADING, MISSING, READY)]);
    expect(yield* reachComposer(refusedBehindLoading.port, SURFACE)).toBe("missing-session");
    expect(refusedBehindLoading.log.consents).toBe(0);
    // The screen the read ended on is a ready composer, which is what this
    // driver would otherwise have typed a turn into.
    expect(classifyInitialSurface(refusedBehindLoading.port.screen())).toBe("composer-ready");

    // The same ordering on the initial wait, where the trust dialog is the
    // actionable frame that answers it first and the refusal follows.
    const refusedBehindTrust = surfaceFake([oneRead(TRUSTING, MISSING, READY)]);
    expect(yield* reachComposer(refusedBehindTrust.port, SURFACE)).toBe("missing-session");
    // Never consented to: a refused session is a finding, not a directory to
    // take a standing permission on.
    expect(refusedBehindTrust.log.consents).toBe(0);
    expect(classifyInitialSurface(refusedBehindTrust.port.screen())).toBe("composer-ready");

    // And the priority is the refusal's alone. A benign frame behind another
    // benign frame decides nothing extra: the grace still ends at the first, and
    // readiness is still read off the screen as it stands.
    const loadedBehindTrust = surfaceFake([frame(READY), oneRead(TRUSTING, LOADING, READY)]);
    expect(yield* reachComposer(loadedBehindTrust.port, SURFACE)).toBe("composer-ready");
    expect(loadedBehindTrust.log.consents).toBe(0);
  });

  it("CS21: a refusal presented after the consent is the finding, and no turn follows", function* () {
    // The third wait this driver consumes a batch from, and the one CS20 never
    // reaches. Answering the dialog is not the end of the startup: Codex goes on
    // to load a model and to report what it holds, and this wait is what it is
    // watched through. The wait asks only that the dialog be gone, which the
    // model reloading already satisfies — so the refusal arrives behind a frame
    // that answered the wait, in the read that answered it.
    const refusedAfterConsent = surfaceFake([
      frame(TRUSTING),
      frame(TRUSTING),
      oneRead(LOADING, MISSING, READY),
    ]);
    expect(yield* reachComposer(refusedAfterConsent.port, SURFACE)).toBe("missing-session");
    // The consent stands, and is neither repeated nor taken back: it was pressed
    // at a dialog that was up and asking, about a directory, before anything had
    // been refused. What must not follow it is a turn, and the finding is what
    // stops one — this returns instead of going round to type into the composer
    // the same read drew.
    expect(refusedAfterConsent.log.consents).toBe(1);
    expect(refusedAfterConsent.log.waited).toEqual(["surface", "trust-answered"]);
    expect(classifyInitialSurface(refusedAfterConsent.port.screen())).toBe("composer-ready");

    // A benign batch here still continues, so what was added is the refusal's
    // priority and not a general distrust of whatever follows a consent.
    const startedAfterConsent = surfaceFake([
      frame(TRUSTING),
      frame(TRUSTING),
      oneRead(LOADING, READY),
      frame(READY),
    ]);
    expect(yield* reachComposer(startedAfterConsent.port, SURFACE)).toBe("composer-ready");
    expect(startedAfterConsent.log.consents).toBe(1);
    expect(startedAfterConsent.log.waited).toEqual([
      "surface",
      "trust-answered",
      "surface",
      "readiness-grace",
    ]);
  });

  it("CS25: a refusal presented during the settle is seen, and nothing is consented to", function* () {
    // The settle is a window like any other — the terminal goes on drawing for
    // its whole duration — but nothing was watching it. A refusal presented and
    // painted over inside one read during the settle leaves the dialog on screen
    // afterwards, and the recheck before Enter is a question about the screen,
    // which by then says the dialog is still up and still asking.
    const refusedDuringSettle = surfaceFake([
      frame(TRUSTING),
      oneRead(MISSING, TRUSTING),
      frame(READY),
      frame(READY),
    ]);
    expect(yield* reachComposer(refusedDuringSettle.port, SURFACE)).toBe("missing-session");
    // Not consented to at all. This refusal was presented *before* the Enter,
    // unlike CS21's, so there is no question of a consent standing: the
    // directory was never answered for, because the session it was being
    // answered for had already been refused.
    expect(refusedDuringSettle.log.consents).toBe(0);
    // And the screen it was decided against still shows the dialog, which is
    // exactly why the screen alone could not decide it.
    expect(classifyInitialSurface(refusedDuringSettle.port.screen())).toBe("trust-dialog");

    // An ordinary repaint during the settle still consents. The dialog redrawing
    // itself, or a model loading behind it, is a settle doing its job.
    const redrawnDuringSettle = surfaceFake([
      frame(TRUSTING),
      oneRead(STARTING, TRUSTING),
      frame(READY),
      frame(READY),
    ]);
    expect(yield* reachComposer(redrawnDuringSettle.port, SURFACE)).toBe("composer-ready");
    expect(redrawnDuringSettle.log.consents).toBe(1);

    // And a dialog that simply goes away during the settle is still not answered,
    // which is the behaviour the settle existed for in the first place.
    const departedDuringSettle = surfaceFake([
      frame(TRUSTING),
      frame(READY),
      frame(READY),
      frame(READY),
    ]);
    expect(yield* reachComposer(departedDuringSettle.port, SURFACE)).toBe("composer-ready");
    expect(departedDuringSettle.log.consents).toBe(0);

    // A refusal drawn during the settle and never committed is not something the
    // terminal ever put on show, and observing the settle does not change that.
    // The consent goes ahead — the dialog is what is presented — and the run ends
    // waiting for an answer that this held drawing never lets arrive, which is a
    // different outcome from the refusal it would be if a hold counted.
    const heldDuringSettle = surfaceFake([
      frame(TRUSTING),
      `${SYNC_ON}${frame(MISSING)}`,
      frame(READY),
    ]);
    expect(yield* reachComposer(heldDuringSettle.port, SURFACE)).toBe("unresolved");
    expect(heldDuringSettle.log.consents).toBe(1);
  });
});
