/**
 * What Codex's own surfaces say, and what a screen showing one of them means.
 *
 * `terminal-screen.ts` reconstructs a terminal and stays deliberately ignorant
 * of whose terminal it is. This is the other half: the wording one build of
 * Codex draws, and the two judgements a proof makes from it — whether the
 * composer will accept a turn, and what a screen was showing when no answer
 * arrived. Both are here rather than in the proof so the offline cases drive the
 * exact predicates the paid run consumes, instead of a copy that agrees with
 * them until the day it does not.
 *
 * Every judgement is asked of a *presented* screen. Codex withholds its drawing
 * with `CSI ?2026h` while it repaints, so cells in between are ones no operator
 * was ever shown, and a predicate that read them would decide on a frame that
 * never existed.
 */

import type { Operation } from "effection";
import { runsOf, screenShows } from "./terminal-screen.ts";
import type { ScreenSnapshot } from "./terminal-screen.ts";

/** Codex's own banner, and the strongest signal its surface is up. */
export const BANNER = "OpenAI Codex (v";

/** The composer, which is where a conversation turn can be typed. */
export const COMPOSER = "Ask Codex to do anything";

/**
 * The one dialog Codex may put in front of a session.
 *
 * It asks for a standing permission rather than anything of the conversation,
 * so a composer showing underneath one is not a composer that will take a turn.
 */
export const TRUST_DIALOG = "Do you trust the contents of this directory";

/**
 * What Codex shows in place of its model name until startup finishes.
 *
 * It draws the composer before it has a model, and input typed into that
 * composer may be queued rather than taken. A turn typed here is a turn whose
 * fate nobody can read off the screen.
 */
export const MODEL_LOADING = "model: loading";

/**
 * Codex refusing an identity it holds no thread for.
 *
 * The refusal this whole feature exists to avoid, so a screen presenting it is
 * a finding about the product rather than something to drive around.
 */
export const MISSING_SESSION = "No saved session found with ID";

/**
 * The markers naming Codex's own furniture rather than anything it said.
 *
 * Handed to {@link runsOf} so a line of chrome ends the run above it instead of
 * joining onto the sentence that follows.
 */
export const SCREEN_CHROME: readonly string[] = [COMPOSER, "esc to interrupt", BANNER];

/** Fold away everything a terminal's layout and typography may vary. */
function fold(text: string): string {
  return text.toLowerCase().replaceAll(/[‘’ʼ]/gu, "'");
}

/** Fold, and close up the wrapping a terminal chose. */
function normalize(text: string): string {
  return fold(text).replaceAll(/\s+/gu, "");
}

/** Whether the presented screen shows `phrase`, layout and case ignored. */
function shows(snapshot: ScreenSnapshot, phrase: string): boolean {
  return screenShows(
    { alternate: snapshot.alternate, rows: snapshot.rows.map(fold) },
    fold(phrase),
  );
}

/**
 * The one sentence this proof has witnessed Codex refuse a turn with.
 *
 * Witnessed, and so exactly one. Variants nobody has seen Codex draw would be
 * guesses dressed as recognition, and each one widens what can be mistaken for
 * a refusal while proving nothing about the product.
 */
const WITNESSED_REFUSAL = "You've hit your usage limit.";

/**
 * Whether the presented screen is refusing for want of remaining usage.
 *
 * Asked of a *run* — the text between the layout's own cuts — and asked whether
 * that run begins with the refusal, rather than whether the screen contains the
 * words anywhere. Codex says `usage limit` in wording that means the opposite:
 * `/status` reports the headroom that remains, the startup banner offers
 * `You have 2 usage limit resets available`, and its help text explains what to
 * do `If you've hit your usage limit`. A containment test cannot tell any of
 * those from the refusal, and one that could not reported two paid runs as
 * quota-blocked on an account with 42% of its week unspent — sending the next
 * reader off to wait for a limit nobody hit, and burying the real cause.
 *
 * Requiring the run to *start* with the sentence is what rejects the
 * conditional: `If you've hit your usage limit, …` is one run, and it begins
 * with `If`. Wrapping is closed up first, because a terminal may break the
 * sentence across rows and that is not a different sentence.
 *
 * Wording this does not recognize is not exhaustion here, even if it is
 * exhaustion in fact. That direction is the safe one: an unrecognized surface
 * is reported as a harness that could not read the screen, which costs an
 * investigation, where the other direction costs a false claim about the
 * product's environment.
 */
export function exhaustedUsage(snapshot: ScreenSnapshot): boolean {
  const refusal = normalize(WITNESSED_REFUSAL);
  return runsOf(snapshot.rows, SCREEN_CHROME).some((run) => normalize(run).startsWith(refusal));
}

/**
 * What the terminal was showing instead, when no answer was read within a bound.
 *
 * Terminal state, and nothing more. `composer-idle` in particular says the
 * composer is back to its resting form; it is not evidence that no answer
 * appeared, because an answer sits above a composer that has gone idle and
 * `observeAnswer` is the only thing that decides whether one is there.
 */
export type StallTag =
  | "approval-request"
  | "still-working"
  | "usage-limited"
  | "composer-idle"
  | "unknown";

const STALLS: readonly { tag: StallTag; matches: (snapshot: ScreenSnapshot) => boolean }[] = [
  { tag: "approval-request", matches: (screen) => shows(screen, "Allow command") },
  { tag: "approval-request", matches: (screen) => shows(screen, "wants to run") },
  { tag: "still-working", matches: (screen) => shows(screen, "esc to interrupt") },
  { tag: "usage-limited", matches: exhaustedUsage },
  { tag: "composer-idle", matches: (screen) => shows(screen, COMPOSER) },
];

/**
 * What the screen was showing, and what a run that read no answer therefore is.
 *
 * The two travel together because they are one judgement. Nothing here converts
 * a tag into a verdict, so there is no function a caller could hand a
 * `usage-limited` it made up — the only way to reach `ENVIRONMENT_BLOCKED` is to
 * put the witnessed refusal on a screen and classify it. A tag on its own is a
 * label for a report; it carries no authority to blame anything.
 */
export interface StallClassification {
  /** What the terminal was showing. Reported as-is, and decides nothing alone. */
  readonly tag: StallTag;
  /**
   * What a run that spent a turn and read no answer is.
   *
   * `ENVIRONMENT_BLOCKED` only where {@link exhaustedUsage} recognized the
   * refusal. Every other surface describes where the terminal got to and
   * explains nothing: still working, waiting on an approval, sitting at an idle
   * composer, or showing wording nothing here recognizes is this harness having
   * stopped waiting in front of something it could not account for, which is a
   * harness failure however ordinary the screen.
   */
  readonly verdict: "ENVIRONMENT_BLOCKED" | "HARNESS_FAILED";
}

/** Read the presented screen, and say both things about it at once. */
export function classifyStall(snapshot: ScreenSnapshot): StallClassification {
  const tag = STALLS.find((stall) => stall.matches(snapshot))?.tag ?? "unknown";
  return { tag, verdict: tag === "usage-limited" ? "ENVIRONMENT_BLOCKED" : "HARNESS_FAILED" };
}

/** Whether the composer is up, unobstructed, and backed by a loaded model. */
export function composerReady(snapshot: ScreenSnapshot): boolean {
  return (
    shows(snapshot, COMPOSER) && !shows(snapshot, TRUST_DIALOG) && !shows(snapshot, MODEL_LOADING)
  );
}

/**
 * What a session is showing on its way to a composer that will take a turn.
 *
 * `starting` and `blank` are the two ways a screen can be nothing to act on:
 * one has Codex on it and no surface to answer or type into yet, the other has
 * nothing recognizable at all. Neither is a decision, and keeping them apart
 * from the three that are is what lets a wait resume rather than conclude.
 */
export type InitialSurface =
  | "missing-session"
  | "trust-dialog"
  | "composer-ready"
  | "starting"
  | "blank";

/**
 * Which of those the presented screen is showing.
 *
 * Ordered by what covers what. The refusal comes first because it is the
 * finding and Codex draws its composer while still opening the thread, so a
 * screen carrying both is a refused one. The dialog comes before readiness
 * because it is drawn *over* a composer, and a composer nobody can reach is not
 * a composer that will take a turn.
 *
 * Asked of a presented snapshot in every case. The byte stream retains a
 * composer drawn before a dialog covered it and a refusal erased by the repaint
 * after it, so a reader of the stream answers a question about the past; and
 * cells inside a `CSI ?2026h` hold were never shown to anybody, so a reader of
 * those answers a question about a frame that did not exist.
 */
export function classifyInitialSurface(snapshot: ScreenSnapshot): InitialSurface {
  if (shows(snapshot, MISSING_SESSION)) {
    return "missing-session";
  }
  if (shows(snapshot, TRUST_DIALOG)) {
    return "trust-dialog";
  }
  if (composerReady(snapshot)) {
    return "composer-ready";
  }
  if (shows(snapshot, BANNER) || shows(snapshot, COMPOSER) || shows(snapshot, MODEL_LOADING)) {
    return "starting";
  }
  return "blank";
}

/**
 * Whether Codex refused the identity at any point in the read that was waited on.
 *
 * Any point, because the refusal outranks everything else a read presented. The
 * frames either side of it are Codex getting on with a startup it has already
 * decided the outcome of, and acting on one of those means driving a session the
 * product has said it does not hold.
 */
function refused(presented: readonly ScreenSnapshot[]): boolean {
  return presented.some(isRefusal);
}

/** Whether this one screen is Codex saying it holds no such thread. */
export function isRefusal(snapshot: ScreenSnapshot): boolean {
  return classifyInitialSurface(snapshot) === "missing-session";
}

/**
 * Watch for what this wait is for, and for the refusal that means stop waiting.
 *
 * A wait ends at the read that satisfied it, so a frame its predicate says
 * nothing about is not merely left out of the batch — it does not stop the wait,
 * and the read after it repaints over it. The refusal is then in no batch and on
 * no screen, and the only trace it left is that it was once presented.
 *
 * That is survivable for a wait watching for a surface, because every surface
 * predicate in this file is already satisfied by a refusal: reaching a composer
 * waits for something {@link actionable}, for the trust dialog to be gone, or
 * for readiness to be lost, and `missing-session` answers all three. It is not
 * survivable for the waits that ask whether a composer is ready or whether a
 * turn is in it, because Codex can draw the refusal where the composer was —
 * making both of those predicates false on the one screen that matters most.
 *
 * So the waits whose next act is typing or Enter watch for the refusal too. It
 * belongs in the predicate rather than in a check afterwards: a wait that ends
 * on the refusal is one whose batch holds it, which is what {@link refused} then
 * finds, and it ends there rather than waiting out a bound for a composer that
 * has already been spoken for.
 */
function stoppingAtRefusal(
  predicate: (snapshot: ScreenSnapshot) => boolean,
): (snapshot: ScreenSnapshot) => boolean {
  return (snapshot) => predicate(snapshot) || isRefusal(snapshot);
}

/** Whether this surface is one a driver may act on. */
function actionable(surface: InitialSurface): boolean {
  return (
    surface === "missing-session" || surface === "trust-dialog" || surface === "composer-ready"
  );
}

/** Where reaching for a composer got to. */
export type SurfaceOutcome =
  /** Codex refused the identity. A finding, and not something to drive around. */
  | "missing-session"
  /** A composer is up, unobstructed, and backed by a loaded model. */
  | "composer-ready"
  /** No surface this recognizes settled within the bounds it was given. */
  | "unresolved";

export interface SurfaceBounds {
  /** How long each round waits for a surface it can act on. */
  readonly surface: number;
  /** How long a dialog is given to finish drawing its options. */
  readonly settle: number;
  /** How long a ready composer is watched for a dialog arriving over it. */
  readonly grace: number;
}

/**
 * Everything reaching a composer needs from a terminal, and nothing else.
 *
 * `consent` rather than a raw keystroke, because the one Enter this driver may
 * press is a consent that has to be recorded as one — a port that could be
 * handed a bare `send` could spend a conversation turn through this path.
 */
export interface SurfacePort {
  /** What the terminal last put on show. Never a frame still being drawn. */
  screen(): ScreenSnapshot;
  /**
   * Wait for a read presenting `predicate`, and answer with every frame that did.
   *
   * The screens that matched, rather than a flag saying one did, because the two
   * questions have different answers. A read from a pty carries as many finished
   * frames as its bytes finished, so a surface can be presented and repainted
   * over inside one — and a caller handed a flag has nothing left to look at but
   * whichever frame that read ended on.
   *
   * All of them, because both questions asked here are wide: whether a ready
   * composer stopped being one, and whether any surface worth acting on is up.
   * A refusal satisfies either, and so does a model reloading or a dialog going
   * up — so the read that carries the refusal often answers the wait a frame or
   * two before it.
   *
   * Empty where the bound was spent, because a surface that never arrived is
   * something to report rather than an error.
   */
  waitForScreen(
    name: string,
    ms: number,
    predicate: (snapshot: ScreenSnapshot) => boolean,
  ): Operation<readonly ScreenSnapshot[]>;
  /** Answer the trust dialog: record the consent, and press Enter. */
  consent(): void;
  /**
   * Wait out a fixed delay, and answer with what was presented during it.
   *
   * A delay rather than a wait — nothing shortens it — but the same answer a
   * wait gives, because the terminal does not stop drawing while a driver is
   * deliberately not looking. The screen afterwards says what survived the
   * delay, which is a different question from what happened during it, and a
   * refusal is routinely only in the second.
   */
  pause(
    ms: number,
    predicate: (snapshot: ScreenSnapshot) => boolean,
  ): Operation<readonly ScreenSnapshot[]>;
}

/**
 * How many surfaces one session is followed through.
 *
 * A composer that goes back to loading, the dialog that follows it, the composer
 * that dialog was covering, and one spare. A session that needs more than that
 * is one this driver does not understand, and saying so is better than pressing
 * Enter into it until something happens.
 */
const SURFACE_ROUNDS = 4;

/**
 * Answer the trust dialog if it is presented, then establish the composer.
 *
 * Whether the dialog appears belongs to the machine — a directory Codex already
 * trusts shows none — so this reacts to what is on screen rather than following
 * a script, and consents at most once.
 *
 * Every Enter is preceded by reading the presented screen again. The dialog is
 * still drawing its options as it announces itself, so a settle is waited out
 * first; and if the screen is no longer showing the dialog after it, no Enter is
 * pressed. That is the difference between consenting to a question and pressing
 * Enter into whatever replaced it.
 */
export function* reachComposer(
  port: SurfacePort,
  bounds: SurfaceBounds,
): Operation<SurfaceOutcome> {
  let consented = false;
  for (let round = 0; round < SURFACE_ROUNDS; round++) {
    const arrived = yield* port.waitForScreen("surface", bounds.surface, (snapshot) =>
      actionable(classifyInitialSurface(snapshot)),
    );
    if (arrived.length === 0) {
      return "unresolved";
    }
    // A refusal the terminal presented is the finding, whatever it drew next and
    // whatever it drew before. Codex commits the refusal and repaints a composer
    // over it, and one read from a pty can carry both — so the screen as it now
    // stands is not enough to see it, and a driver that only looked there would
    // type a turn into a composer for a session the product had already said it
    // does not hold. Asked of the whole read because the dialog Codex may draw
    // ahead of the refusal answers this wait too, and the refusal outranks it.
    if (refused(arrived)) {
      return "missing-session";
    }
    // Otherwise read again rather than trusting the wait: what satisfied the
    // predicate may have been repainted over, and consenting or typing is an act
    // against whatever is on show now.
    const surface = classifyInitialSurface(port.screen());
    if (surface === "missing-session") {
      return "missing-session";
    }
    if (surface === "trust-dialog") {
      if (consented) {
        // Asked twice about one directory. Answering again would be consenting
        // twice to a question that was only asked once.
        return "unresolved";
      }
      // Settling lets a dialog drawn in pieces finish being drawn, and a session
      // Codex is still resolving refuse. The screen afterwards cannot tell those
      // apart from a refusal that was shown and painted back over, so the settle
      // is asked what it saw: consenting to a directory on behalf of a session
      // that no longer exists answers a question nobody is asking any more.
      const duringSettle = yield* port.pause(bounds.settle, isRefusal);
      if (refused(duringSettle)) {
        return "missing-session";
      }
      if (classifyInitialSurface(port.screen()) !== "trust-dialog") {
        continue;
      }
      consented = true;
      port.consent();
      // The dialog stays on screen until Codex repaints over it. Waiting for it
      // to go is what stops the next round reading an answered question as a
      // second one and giving up in front of a session that is coming up fine.
      const answered = yield* port.waitForScreen(
        "trust-answered",
        bounds.surface,
        (snapshot) => classifyInitialSurface(snapshot) !== "trust-dialog",
      );
      // Answering the dialog is not the end of the startup, so this is a third
      // read a refusal can be presented in — and this wait asks only that the
      // dialog be gone, which the model Codex loads next already satisfies. The
      // refusal then arrives behind a frame that has answered this wait, inside
      // the read that answered it, and going round without looking would find
      // only the composer that read ended on. The consent already pressed
      // stands: it answered a question about a directory that was up and asking
      // at the time. What it must not be followed by is a turn.
      if (refused(answered)) {
        return "missing-session";
      }
      continue;
    }
    if (surface === "composer-ready") {
      // Codex draws its composer early — before it asks about the directory,
      // before a model has finished loading, and before it reports that it holds
      // no such thread. So a first ready screen is a screen that may still be
      // about to become one of those, and the grace watches for it becoming
      // *anything* else rather than for the dialog alone. Watching only for the
      // dialog is how a refusal or a loading model arriving during the grace
      // used to run out the bound unnoticed and be returned as readiness.
      const departed = yield* port.waitForScreen(
        "readiness-grace",
        bounds.grace,
        (snapshot) => classifyInitialSurface(snapshot) !== "composer-ready",
      );
      // The refusal ends it here too, and for the same reason: it was presented,
      // and a repaint in the same read does not take that back. This is the wait
      // it most often arrives behind — Codex puts its model back to loading
      // before it says it holds no such thread — and a loading frame satisfies
      // this predicate as readily as the refusal two frames later does.
      if (refused(departed)) {
        return "missing-session";
      }
      // Otherwise the decision is the screen as it now stands: a surface that
      // arrived inside a hold counts from its commit, one that came and went
      // never displaced what is on show, and readiness is a claim about a
      // composer this driver is about to type into.
      const settled = classifyInitialSurface(port.screen());
      if (settled === "missing-session") {
        return "missing-session";
      }
      if (settled !== "composer-ready") {
        continue;
      }
      return "composer-ready";
    }
  }
  return "unresolved";
}

/**
 * How much of the typed turn has to be on screen for it to count as presented.
 *
 * The tail, because a composer scrolls a long turn and shows its end. The
 * proof's turn ends in a marker minted for that one run, so the tail is unique
 * to it and no earlier repaint can supply one — provided the whole marker fits
 * inside it, which is a thing about the two lengths together and so is proven
 * rather than assumed.
 */
export const PROMPT_TAIL = 24;

/**
 * Whether the composer is showing the turn this harness typed into it.
 *
 * Asked of the typed text alone, and deliberately not of {@link COMPOSER} as
 * well. That string is the composer's placeholder, which is what an *empty*
 * composer shows — the thing {@link composerReady} reads — and it is gone the
 * moment there is a turn in the box. Requiring both would be requiring the
 * composer to be simultaneously empty and full, and every run would report a
 * turn it never managed to type.
 *
 * Before submission there is nowhere else on the screen for this text to be:
 * nothing has been sent, so no transcript carries it back.
 */
export function promptPresented(snapshot: ScreenSnapshot, typed: string): boolean {
  const tail = typed.slice(-PROMPT_TAIL);
  return tail.length > 0 && shows(snapshot, tail);
}

/** The bounds a submission is given, supplied by whoever owns the run. */
export interface SubmissionBounds {
  /** How long the composer is waited for, before and after the grace. */
  readonly ready: number;
  /**
   * How long a ready-looking composer is given to turn out to have something
   * over it, or a model still loading behind it.
   *
   * Its length matters less than the recheck it precedes: a composer that stops
   * being ready during the grace is waited for again rather than typed into.
   */
  readonly startupGrace: number;
  /** How long the typed turn is given to appear in the composer. */
  readonly presented: number;
}

/**
 * Everything submitting a turn needs from a terminal, and nothing else.
 *
 * Narrow on purpose: the offline cases implement this against scripted frames,
 * so what they decide is what the pty path does.
 */
export interface SubmissionPort {
  /** What the terminal last put on show. Never a frame still being drawn. */
  screen(): ScreenSnapshot;
  /**
   * Wait for a read presenting `predicate`, and answer with every frame that did.
   *
   * The frames rather than a flag, and for a sharper reason than reaching a
   * composer had. Codex draws its refusal *above* a composer rather than in
   * place of one, so a screen carrying `No saved session found with ID` and an
   * empty composer both is a screen {@link composerReady} calls ready and
   * {@link promptPresented} calls presented. A refusal therefore does not merely
   * ride along in these batches — it satisfies them. Answering `true` here would
   * hand back the one bit that cannot distinguish the composer this driver is
   * waiting for from the refusal that means it must not type into it, and the
   * next thing down that path is Enter.
   *
   * Empty where the bound was spent, because a surface that never arrived is
   * something to report rather than an error.
   */
  waitForScreen(
    name: string,
    ms: number,
    predicate: (snapshot: ScreenSnapshot) => boolean,
  ): Operation<readonly ScreenSnapshot[]>;
  /** Type one turn into the composer, without sending it. */
  type(text: string): void;
  /** Press Enter. This is the keystroke that spends the turn. */
  send(typed: string): void;
  /** Wait out a fixed delay, and answer with what was presented during it. */
  pause(
    ms: number,
    predicate: (snapshot: ScreenSnapshot) => boolean,
  ): Operation<readonly ScreenSnapshot[]>;
}

export type SubmissionRefusal =
  | "session-refused"
  | "composer-never-ready"
  | "composer-unready-after-grace"
  | "prompt-never-presented";

export type SubmissionOutcome =
  | { readonly submitted: true }
  | { readonly submitted: false; readonly reason: SubmissionRefusal };

const REFUSALS: Readonly<Record<SubmissionRefusal, string>> = {
  "session-refused":
    "Codex refused the identity while the turn was being readied, so the composer on screen " +
    "belonged to a session it had already said it does not hold",
  "composer-never-ready":
    "the composer never came up ready — it was absent, covered by the trust dialog, or still " +
    "showing a model that had not loaded",
  "composer-unready-after-grace":
    "the composer stopped being ready during the startup grace and did not come back",
  "prompt-never-presented":
    "the turn was typed but never appeared in the composer, so what Codex would have received " +
    "could not be established",
};

/** The sentence naming why nothing was submitted. Carries no typed content. */
export function refusalDetail(reason: SubmissionRefusal): string {
  return REFUSALS[reason];
}

/**
 * Type one turn and submit it, or establish that it must not be submitted.
 *
 * Enter is reached from exactly one place, past three screen readings that each
 * have to hold: the composer is ready, it is still ready after the grace in
 * which an overlay or a loading model would have shown itself, and the turn is
 * on screen in the composer. A run that fails any of them returns having typed
 * at most — no Enter, and so no turn to account for.
 *
 * None of those three is a question about a refusal, though, and `No saved
 * session found with ID` can be drawn either above the composer or where the
 * composer was. The first shape passes every test here — ready, and holding the
 * turn that was typed. The second fails them all, which is worse: a wait
 * watching only for readiness does not stop at it, and the next read paints over
 * it. So the refusal is watched for by each wait as well as asked of the batch
 * that answers it, and asked again of the screen as it stands wherever this
 * decides something without a wait: after the startup grace, after a composer is
 * waited for a second time, and immediately before Enter.
 *
 * Reaching a composer has already established that the session was not refused,
 * but only up to the bound it was willing to wait — and Codex draws its composer
 * before it resolves the thread, so a refusal slower than that bound arrives
 * here, with the turn already typed and Enter next.
 */
export function* submitWhenReady(
  port: SubmissionPort,
  typed: string,
  bounds: SubmissionBounds,
): Operation<SubmissionOutcome> {
  const ready = yield* port.waitForScreen(
    "composer-ready",
    bounds.ready,
    stoppingAtRefusal(composerReady),
  );
  if (refused(ready)) {
    return { submitted: false, reason: "session-refused" };
  }
  if (ready.length === 0) {
    return { submitted: false, reason: "composer-never-ready" };
  }

  // The grace is a window a refusal can be drawn in, and what it leaves behind
  // is a screen rather than a batch: nothing else is watching it. Asked for
  // readiness alone the screen afterwards answers yes, because the refusal is
  // drawn above a composer that is otherwise up — so the second wait would not
  // even be taken, and the read that later confirms the turn repaints a clean
  // composer over the only frame that ever said the session does not exist. A
  // refusal repainted before the grace is out leaves no trace on that screen at
  // all, so the grace is asked what it saw as well as what it left.
  const duringGrace = yield* port.pause(bounds.startupGrace, isRefusal);
  if (refused(duringGrace)) {
    return { submitted: false, reason: "session-refused" };
  }
  const settled = port.screen();
  if (classifyInitialSurface(settled) === "missing-session") {
    return { submitted: false, reason: "session-refused" };
  }
  if (!composerReady(settled)) {
    const again = yield* port.waitForScreen(
      "composer-ready-again",
      bounds.ready,
      stoppingAtRefusal(composerReady),
    );
    if (refused(again)) {
      return { submitted: false, reason: "session-refused" };
    }
    if (again.length === 0) {
      return { submitted: false, reason: "composer-unready-after-grace" };
    }
    // A batch says a ready composer was presented during the read, not that it
    // is what the read ended on. The refusal that arrives after it takes the
    // composer with it, and a screen with no composer is precisely what this
    // wait does not collect — so the honestly ready batch above can sit in front
    // of a refusal that is on show right now, with typing next.
    if (classifyInitialSurface(port.screen()) === "missing-session") {
      return { submitted: false, reason: "session-refused" };
    }
  }

  port.type(typed);
  const presented = yield* port.waitForScreen(
    "prompt-presented",
    bounds.presented,
    stoppingAtRefusal((snapshot) => promptPresented(snapshot, typed)),
  );
  if (refused(presented)) {
    return { submitted: false, reason: "session-refused" };
  }
  if (presented.length === 0) {
    return { submitted: false, reason: "prompt-never-presented" };
  }

  // Enter is the act this whole file exists to place correctly, so it is taken
  // against the screen as it stands and not against a batch that answered a
  // wait. A refusal arriving after the turn was confirmed on screen — in a read
  // of its own, with nothing left to satisfy any predicate above — is invisible
  // to all three waits and would otherwise be charged for.
  if (classifyInitialSurface(port.screen()) === "missing-session") {
    return { submitted: false, reason: "session-refused" };
  }

  port.send(typed);
  return { submitted: true };
}
